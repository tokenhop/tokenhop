# YAN-360 technical research: invitations and admin user lifecycle APIs

## Executive Summary

Scope: GitHub `tokenhop/tokenhop#228` checklist only. Server invitations, admin lifecycle, ownership transfer, workspace memberships, audit hooks. No UI, mail delivery, custom roles, new session store, gateway redesign, encryption implementation, or dependencies.

Grounding: issue read through `gh issue view 228 --json title,body,labels`; worktree head `926151d1` includes password login (#767), SSO JIT (#774), audit (#773), scoped resources and hashed-key infrastructure. Read worktree `CLAUDE.md`, main-checkout `docs/users/README.md`, accepted spec, tenancy/roles/identity/sessions/keys/encryption/versioning ADRs. Remaining ADR decisions do not expand this checklist.

Smallest architecture: one invitation table/repo, invitation orchestration service, small management authorization helper, existing users/memberships repositories hardened in place, thin routes. Reuse synchronous adapter transactions, async bcrypt helpers, stable SSO identity triples, session cache invalidation, key tombstones, audit helper. No event bus or placeholder audit implementation: YAN-367 already shipped.

Main gaps:

- Invitations absent. Users list unpaginated; admin lifecycle routes absent.
- `usersRepo.deleteUserUnscoped` already protects instance owner and last shared manager, deletes personal workspaces, then users. FKs preserve shared resources and cascade identities/memberships; workspace-prefixed kv requires explicit cleanup.
- Membership writes check membership, not management capability; permit client-selected source and writes to IdP rows. Route/service boundaries must restrict these, with fresh checks inside mutation transactions.
- Existing `transferOwnership` checks owner and target, bumps both versions, audits, but does not verify reauthentication or reject stale proof.
- `can(..., "workspace.members.manage")` grants instance admin management only where already a member. Issue explicitly permits admin invites anywhere; use narrow admin-management bypass, not broad personal-workspace access.
- Route handler gating alone does not guarantee HTTP 404 while off: `dashboardGuard` can return 401/403 first. New route policy needs an early switch-only hide check.

Validation belongs to orchestrator. This lane runs no tests/build and edits only this document.

## Architecture Design

### Layers and interfaces

| Component                                   | Interface / purpose                                                                                                                                                               | Dependencies and boundary                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Route handlers                              | Validate exact request shape; hide feature; obtain principal; reject cross-site mutations; map safe errors                                                                        | `featureSwitch`, `sameOrigin`, management helper, repositories/services                    |
| `src/lib/users/userManagement.js` (new)     | Management auth/error/metadata helpers; verify live actor and capability for target workspace                                                                                     | `resolvePrincipal`, `can`, adapter reads; never resource secret reads                      |
| `src/lib/db/repos/invitationsRepo.js` (new) | `createInvitation(ctx, workspaceId, input)`, `listInvitations(ctx, workspaceId)`, `revokeInvitation(ctx, workspaceId, id)`; synchronous consume seam for caller-owned transaction | Scoped SQL; explicit column projection; narrow admin exception; secret hash stays internal |
| `src/lib/users/invitations.js` (new)        | Password accept; verified SSO accept; token hashing and validation; atomic account/identity/membership/consume operation                                                          | Users/identities synchronous seams, adapter, bcrypt, admission policy, audit               |
| `src/lib/db/repos/usersRepo.js`             | Paginated metadata read; approve/role/status/delete; hardened ownership transfer                                                                                                  | Existing single-owner index, last-manager guard, key revocation, cache invalidation        |
| `src/lib/db/repos/membershipsRepo.js`       | Safe management writes, manual source, IdP protection, shared-workspace invariant                                                                                                 | Live actor/target reads, last-manager guard, workspace-bound key revocation                |
| `src/lib/users/ownershipTransfer.js` (new)  | Password proof or purpose-bound fresh SSO proof for exact transfer target                                                                                                         | Existing password helpers, protocol callbacks, synchronous transfer seam                   |

Keep transaction helpers outside DB barrel when internal-only, following current `createUserWithPersonalWorkspaceSync`, `insertIdentitySync`, `syncIdpMembershipsSync` pattern. Public scoped repo calls take `ctx` first; elevated operations explicitly end in `Unscoped` and require service-side admin authorization.

### Secure transaction rules

1. Await adapter acquisition, password hashing/comparison, and SSO network verification before entering `db.transaction`. Transaction callback must remain synchronous on every adapter. Do not call async repo wrappers inside it.
2. Inside transaction re-read actor role/status/sessionVersion, target user/workspace, relevant membership, and settings affecting admission. Request principal and prior checks are not authority after an await.
3. Recheck proof's expected actor sessionVersion. Concurrent disable, role change, password change or ownership change yields 409; no partial writes.
4. Check all owner/manager invariants before destructive writes. Preserve exactly one instance owner through existing partial unique index plus repo checks. Demote old owner before promoting target inside one transaction.
5. Token consume, account/personal workspace creation, identity link and invited membership commit together. Any failure rolls back token consume too.
6. Drop affected session cache entries after commit, conservatively also on rollback. Existing global cache TTL stays <=5 seconds; do not add sessions table.
7. Emit safe audit events after successful commit. Never write tokens, hashes, passwords, assertion content or bearer URLs into audit snapshots/logs. Avoid duplicate route/repo events.

### Authorization boundaries

New management routes require authenticated dashboard session or existing host-local CLI owner principal; gateway bearer keys and implicit `via:"local"` principal do not authorize lifecycle writes. Ownership transfer requires live browser session and fresh method-specific proof, never CLI or `amr` alone. CLI recovery remains separate existing functionality.

Workspace management checks exact URL workspace, not `activeWorkspaceId` or capability in some other workspace. Ordinary owner/manager must belong to that workspace and hold `workspace.members.manage` there. Missing/nonmember workspace returns 404; member lacking management role returns 403. Instance owner/admin may manage shared-workspace membership and invites through explicitly elevated path even without membership. Personal workspaces remain one-person and reject all invite/add/remove/role operations, including admin calls.

Recommended delegation ceiling: workspace manager may grant manager/member/viewer, not owner; workspace owner or instance owner/admin may assign shared-workspace owner. Existing model permits multiple shared-workspace owner memberships; do not invent exactly-one-shared-owner constraint. Instance owner is separate immutable role.

## Data Models

### New `invitations` table

| Column                    | Definition / behavior                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                      | UUID TEXT PRIMARY KEY; public management handle, never bearer                                      |
| `workspaceId`             | TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE                                          |
| `role`                    | TEXT NOT NULL CHECK IN owner/manager/member/viewer; restricted by issuer authority                 |
| `email`                   | Nullable bounded normalized email; access condition, not identity lookup key                       |
| `tokenHash`               | TEXT UNIQUE NOT NULL; SHA-256 of 32 random bytes encoded base64url                                 |
| `createdByUserId`         | Nullable TEXT REFERENCES users(id) ON DELETE SET NULL; issuer provenance                           |
| `createdAt`, `expiresAt`  | Required UTC ISO timestamps; expiry fixed to create time + 7 days, server-owned                    |
| `revokedAt`, `consumedAt` | Nullable UTC ISO timestamps; monotonic terminal state                                              |
| `consumedByUserId`        | Nullable TEXT REFERENCES users(id) ON DELETE SET NULL; preserve consumed state after user deletion |

Index `(workspaceId, createdAt, id)`; UNIQUE token hash handles accept lookup. Classify table `scoped` by `workspaceId` in `tenancy.js`. No raw token column, resend table, cleanup daemon or adjustable TTL.

Raw token appears once in create response. No token/hash in list/detail/audit. Token is high entropy, unlike legacy gateway keys; plain SHA-256 suffices without master-key dependency. Strict 43-character base64url input check before hash lookup. Consume with guarded update matching `consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`; require exactly one changed row. Revoke uses same workspace/id selector and never unconsumes consumed invitation.

Workspace/role/email are immutable after issuance. Change means revoke and create. Compute metadata state from timestamps (`pending`, `expired`, `revoked`, `accepted`) rather than separate mutable status column.

### Existing entities and invariant gaps

- `users`: explicit `COLS` omits passwordHash and internal role source, but API should project smaller allowlist omitting sessionVersion too. Add separate paginated reader instead of changing unbounded internal callers silently.
- `identities`: UNIQUE `(provider, issuer, subject)` and user cascade already exist. Password identity subject is user ID, issuer empty. Never look up/link an existing account by invitation email.
- `memberships`: PRIMARY KEY `(workspaceId,userId)`, `source=manual|invite|idp`. API writes cannot choose `source`. Invite accept inserts source `invite`; normal add inserts `manual`; IdP sync retains ownership of its rows.
- `workspaces`: personal owner membership immutable; shared ownership can have several owner/manager rows. Last-manager guard currently counts disabled/pending users too. Recommended guard counts active approved managers, and disable/demotion-to-pending also prevents leaving shared workspace operationally unmanaged.
- Existing IdP-sourced membership role change/removal must return 409 `idp_managed`, not silently turn provenance manual. An invite colliding with existing membership returns 409 without consume or elevation; no silent conversion of IdP/manual rows.
- Approval is `pending` instanceRole to `user`, not status change. `pending` accounts presently have status `active`; ordinary login/session remains unavailable until approved.

### Deletion matrix

| Resource                                     | Existing behavior                        | Required lifecycle behavior                                                                                                      |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Personal workspace                           | User repo explicitly deletes before user | Retain; destroy entire personal scope in transaction                                                                             |
| Personal connections/nodes/combos            | workspace FK CASCADE                     | Retain; do not decrypt credentials during deletion                                                                               |
| Workspace settings/user preferences          | CASCADE                                  | Retain                                                                                                                           |
| Personal workspace-prefixed kv               | No FK; survives current delete           | Delete exact `ws:<personalId>/` prefix using `substr`/bound equality or escaped LIKE; never unescaped wildcard matching          |
| Personal-workspace keys                      | Hashed schema workspace CASCADE          | Delete, including any service rows inside deleted personal workspace                                                             |
| User-owned keys in shared workspaces         | Hashed schema user CASCADE               | Delete on user deletion; tombstone on disable; service rows `userId IS NULL` survive                                             |
| Shared connections/nodes/combos/service keys | creator FK SET NULL, workspace retained  | Keep workspaceId and data unchanged; NULL creator represents workspace-owned provenance                                          |
| Shared workspace created by user             | `createdBy` SET NULL                     | Retain; block deletion if remaining active approved manager absent                                                               |
| Identities/memberships                       | user CASCADE                             | Retain                                                                                                                           |
| Invitations created/accepted by user         | Proposed SET NULL provenance             | Preserve terminal timestamps; revoke outstanding issuer invitations on disable/delete to avoid delegated access outliving issuer |
| Audit events                                 | No FKs                                   | Retain historical actor IDs; no secret snapshots                                                                                 |
| `workspaceKeys`                              | Not present at inspected head            | YAN-365 owns table/destruction helper; delete DEK row with personal workspace and invalidate DEK cache once available            |

Do not delete resources by `createdByUserId` across all workspaces. Shared workspace attribution changes, not ownership or secrets. Service keys survive shared member churn, not destruction of their owning workspace.

Encryption boundary: destroying live DEK row is feasible, but backups containing wrapped DEK plus retained KEK remain decryptable. Do not claim retroactive cryptographic erasure of such backups. ADR-0008 wording needs clarification; lifecycle cannot solve backup erasure by deleting live row alone.

## API Design

All new responses: `Cache-Control: no-store`; invitation/proof handoff additionally `Referrer-Policy: no-referrer`. Reject cross-site JSON mutations with existing `isCrossSite`; require JSON and exact allowlisted keys. Reject arrays, malformed UUIDs/roles/status/page inputs, oversize email/login/display fields, caller-selected source/hash/expiry/sessionVersion. Return fixed safe error text.

| Endpoint                                             | Input / output                                                                                                                                         | Required authorization                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/users?page=1&pageSize=20`                  | `{users,pagination:{page,pageSize,total,totalPages}}`; pageSize 1–100; stable `createdAt,id` ordering                                                  | `instance.users.manage`                                                                                         |
| `PATCH /api/users/[id]`                              | Exactly one of `{action:"approve"}`, `{instanceRole:"admin" \| "user" \| "pending"}`, `{status:"active" \| "disabled"}`; returns safe user metadata    | `instance.users.manage`, live target hierarchy                                                                  |
| `DELETE /api/users/[id]`                             | `{success:true}`; transactional cascade                                                                                                                | Same; instance owner cannot be deleted                                                                          |
| `POST /api/users/ownership-transfer`                 | `{toUserId,currentPassword}`; password re-verified in request; SSO-only owners use `POST /api/users/ownership-transfer/sso` (forced fresh IdP re-auth) | `instance.ownership.transfer`, browser session plus fresh proof                                                 |
| `GET /api/workspaces/[id]/members`                   | Safe user summary + role/source/createdAt, never identity subjects/hashes                                                                              | Exact-workspace membership management or elevated instance admin                                                |
| `POST /api/workspaces/[id]/members`                  | `{userId,role}`; creates manual membership, no account creation                                                                                        | Same                                                                                                            |
| `PATCH /api/workspaces/[id]/members/[userId]`        | `{role}` only                                                                                                                                          | Same; IdP and owner/last-manager rules                                                                          |
| `DELETE /api/workspaces/[id]/members/[userId]`       | `{success:true}`; revokes user keys in this workspace                                                                                                  | Same                                                                                                            |
| `GET /api/workspaces/[id]/invitations`               | Metadata-only invitations, including expiry/terminal state                                                                                             | Same                                                                                                            |
| `POST /api/workspaces/[id]/invitations`              | `{role,email?}`; `{invitation,token}` once; 201                                                                                                        | Same, delegation ceiling                                                                                        |
| `DELETE /api/workspaces/[id]/invitations/[inviteId]` | Revokes unused invitation; `{success:true}`                                                                                                            | Same                                                                                                            |
| `POST /api/invitations/accept`                       | Password enrollment `{token,email?,username?,displayName?,password}` or authenticated accept `{token}`                                                 | Public bearer enrollment; valid session for existing-user accept; response is a safe receipt, then normal login |

No anonymous token-preview GET needed by checklist. Avoid bearer tokens in route path/query and logs. SSO acceptance enters through the OIDC/SAML start routes: the client POSTs `{ invitationToken }` (same-origin JSON) to `/api/auth/oidc/start` or `/api/auth/saml/start`; success answers 200 JSON `{ redirectUrl }` and the client navigates to it (fetch cannot follow a cross-site 307). The start stores the sealed invite intent bound to the flow, and the callback/ACS completes acceptance; no raw token in redirect URL or request bodies to `/api/invitations/accept`.

Lifecycle hierarchy recommendation follows existing temporary-password endpoint: instance owner may manage any non-owner; admin may manage ordinary/pending users, not other admins or grant admin. Reject self-disable/delete/demotion through admin endpoint. Ownership changes only through transfer, never PATCH. Approval idempotent only for already-approved ordinary user; enabling does not restore revoked keys. Instance role/status changes bump version, clear IdP role provenance when explicitly assigned, and enforce Require login before second active user.

Common failures: 400 invalid request; 401 missing/expired session or proof; 403 capability/origin denial; 404 hidden/nonmember/missing resource; 409 owner/last-manager, stale proof, existing membership, IdP-managed row or account-identifier collision; 429 existing limiter; 503 invalid durable key-security state. Anonymous invalid/expired/revoked/reused token returns same fixed 400 `invalid_invitation`, not separate existence oracle.

### Password and existing-user acceptance

1. Hide feature first; reject cross-site/invalid JSON; rate-limit IP plus invitation-hash bucket. Validate token before expensive bcrypt.
2. Password branch creates a new account only. Require configured password mode through `resolveAuthModes`, apply existing password policy and async hash. Require email or username usable by current password login. Bound email must match supplied normalized email; bearer plus match is not independent mailbox verification.
3. In one transaction recheck token, workspace shared-kind, issuer authorization, login-required setting and identifier uniqueness. Create user with automatic personal workspace, password identity, invite membership, consume token. New invite enrollment defaults instanceRole `user`; token never grants instance admin/owner. This is explicit delegated admission, unlike SSO JIT default `pending`.
4. Authenticated existing user adds membership only; never sets/replaces password. Subject comes from live session, never body `userId`. Disabled/pending accounts cannot use generic authenticated path. Collision never merges accounts by email.
5. Invalidate changed user's sessions after membership/identity change. Recommend return safe acceptance receipt and require normal login instead of implicit auto-login; existing user's prior session becomes stale after version bump.

### SSO acceptance

Normal SSO callbacks call `ssoAdmit`, whose pending branch returns no login cookie. Accept-after-login endpoint alone therefore cannot enroll first-time/pending SSO users.

1. Client POSTs `{ invitationToken }` (same-origin JSON) to the OIDC/SAML start route. Start validates the invitation token and records short-lived signed purpose=`invite-accept` HttpOnly intent cookie containing invitation hash, fixed protocol, random intent nonce, and expiry <=10 minutes. Never return cookie contents. Raw token is discarded and never reappears in a redirect URL.
2. Existing protocol start route binds intent to freshly generated OIDC state/nonce/PKCE or SAML request ID. Reject simultaneous setup-token/ownership intents; do not reuse unscoped bootstrap setup-token flow as invite authorization.
3. Callback verifies protocol normally, including stable identity, signatures, replay/state binding and SSO groups/allow-list. Callback routes fixed error codes, not assertion data. Only verified server identity object reaches invitation service.
4. Invitation transaction resolves existing stable triple or creates new account and identity, applies role/source `invite`, approves a pending invite target to `user` as explicit invite admission, and consumes token together. Never link to an unrelated email-matching password account; identifier collision fails or creates email-null account following existing SSO JIT pattern, not merge. Bound OIDC email needs `email_verified === true`; signed configured SAML email follows current verified-email convention.
5. Reuse extracted synchronous SSO assignment logic so allow-list/admin-group/IdP memberships are validated inside same transaction. Invite membership must not be overwritten by IdP sync. Normal callbacks without intent retain current behavior. Disabled linked account fails without consuming invitation.
6. Clear intent on every callback success/failure. Mint SSO session only from committed linked active approved account via existing `sessionClaims(...,{admittedUserId})`, or return safe receipt and require login. Pending promotion without valid invitation stays forbidden.

SSO invitation acceptance is explicit enrollment, not identity linking to arbitrary existing user selected by email. Linking new SSO identity to an existing password account requires that account's independent authenticated proof; do not add general identity-link API in this issue.

### Ownership transfer reauthentication

Password path: require live browser session with signed `amr:["pwd"]`; load current owner's stored password hash; rate-limit by IP/account; verify fresh password asynchronously using existing helper. No default-password/INITIAL_PASSWORD fallback. Pass expected actor sv and target to transaction. Recheck live owner/target, clear IdP provenance, demote old owner then promote new owner, bump both sv values, invalidate both caches, clear caller auth cookie. Do not retain stale owner claims or copy old owner's password to target.

SSO path: require live browser session and matching current method (`oidc` or `saml`). Mint <=5-minute purpose-bound signed action intent containing actor ID, actor sv, target ID, protocol and nonce. Store nonce hash under dedicated `_meta` key per actor; latest request replaces prior intent. Protocol start binds intent to state/request ID; OIDC requests fresh authentication (`prompt=login`, `max_age=0`) and callback verifies returned `auth_time` within challenge window; SAML requests ForceAuthn and verifies fresh authenticated assertion time. Reject absent/unverifiable freshness, not silently reuse IdP session.

Callback resolves identity triple already linked to exact current owner; never invokes JIT/bootstrap/identity linking for ownership proof. Consume nonce marker and perform transfer in same synchronous transaction. Callback replay, wrong target, wrong subject/protocol, stale sv, expired challenge, disabled/pending target all fail closed. Clear intent and old dashboard cookie after success. IdP incapable of reliable fresh proof gets safe unsupported-reauth error; never fall back to login timestamp or `amr` claim alone.

## System Constraints

- Plain ESM JavaScript, existing Next.js route conventions and `@/` aliases. Keep modules around <=500 lines; `usersRepo.js` already 431 lines, so put cascade helper in existing `ownership.js` or small lifecycle module rather than inflate it.
- `TOKENHOP_MULTI_USER` only read through featureSwitch. Every new route calls `requireMultiUser`, independent of `multiUserActive` or `isUserSecurityEnforced`. Durable hashed-security latch may keep old auth protections on while rollout reads off; management/invitation routes still hide.
- Add `multiUserOnly` route-policy flag and propagate through `flags`/resolved policy. `dashboardGuard.checkApiPolicy` checks it before authentication/local checks and returns 404 while switch off. Route handler repeats gate for direct execution. Scope this to new routes only; do not globally change established password/audit behavior.
- Workspace management policy uses `scoped:true` for ordinary managers plus narrow instance-admin admission in guard. Existing `principalCan(anyWorkspace)` is broad admission only; handler/transaction must verify URL workspace. An admin with no current manager-capability workspace still needs explicit instance-management fallback for these policy rows.
- Driver fallback: bun:sqlite, better-sqlite3, node:sqlite, sql.js; transactions use synchronous callbacks, with savepoints on several adapters. One writer per DATA_DIR enforced by `processLock`. No async transaction isolation assumptions or distributed locks.
- Migration registry currently ends 011. Reserve next available version at integration, proposed `012-invitations.js`; rebase if another lane lands first. Update current TABLES, registry and tenancy classification together. Additive empty table may migrate while switch off; no invite/account writes occur while off.
- Current migration runner temporarily disables FKs outside transaction and checks `PRAGMA foreign_key_check` before commit. Ordinary lifecycle transaction keeps FKs on. Do not copy old handbook statement that runner cannot toggle FKs: current implementation differs.
- Hashed keys are activated through durable marker, not migration-chain version alone. Use `readApiKeyStorageState` and existing `revokeUserApiKeysSync`; pristine legacy schema has no userId/workspaceId. No guessed columns or legacy key fallback under established hashed security.
- Key gateway validation already joins active user and membership; role downgrade to viewer also requires gateway permission check or scoped tombstoning since membership-existence alone is insufficient. Tombstone user keys on removal and downgrade below gateway use; never touch service keys.
- sql.js persistence is normally debounced. Do not claim HTTP transaction acknowledgement implies fsync durability; adapter durability policy is separate. Existing atomic DB state still gives single-use/race safety within supported process model.

## Codebase Changes

### Concrete file ownership lanes

| Lane                          | Owns                                                                                                                                                                                        | Notes / handoff                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A: persistence and invariants | `src/lib/db/schema.js`, `src/lib/db/migrations/012-invitations.js`, migration registry, `tenancy.js`, DB barrel; invitation repo; users/memberships repos; `ownership.js`                   | Sole writer to shared DB files. Publish synchronous enrollment/consume/transfer seams before integration. Cascade/active-manager and IdP-source hardening live here.                       |
| B: invitation API/service     | `src/lib/users/invitations.js`; `src/app/api/invitations/accept/route.js`; workspace invitation routes                                                                                      | Uses Lane A seams. Owns token generation/DTO/accept transaction orchestration; no SSO protocol file writes.                                                                                |
| C: admin/membership HTTP      | `src/lib/users/userManagement.js`; users collection/item routes; workspace members routes                                                                                                   | Uses Lane A APIs, exact field validation, safe DTOs, same-origin/error handling. New helper shared read-only by other lanes after contract lands.                                          |
| D: SSO and ownership proof    | `src/lib/users/ownershipTransfer.js`; ownership-transfer route; OIDC/SAML start/callback/ACS; `src/lib/users/ssoProvisioning.js`; `src/lib/auth/oidc.js`, `saml.js`                         | Sole owner of auth integration files. Extract sync admission reuse; intent state binding; forced fresh proof. Coordinate calls into Lane B acceptance service, no separate invite consume. |
| Integration owner             | `src/lib/auth/routePolicy.js`, `src/dashboardGuard.js`; final DB version resolution; audit event placement                                                                                  | One writer avoids policy conflicts. All new paths/methods covered; early 404 verified through guard and route.                                                                             |
| Validation owner              | `tests/unit/invitations.test.js`, `user-lifecycle.test.js`, `membership-management.test.js`, `ownership-transfer.test.js`, SSO intent tests; existing route-policy/tenancy/isolation suites | Orchestrator owns runnable evidence, baseline gates, safe temp DATA_DIR flows and reviews.                                                                                                 |

File names proposed where absent; existing users password route and workspace settings route remain unchanged except integration if required. Do not add workspace create/delete CRUD merely because collection routes absent; checklist only membership/invitations/lifecycle.

### Build order and integration checks

1. Agree DTOs, delegation/hierarchy policy, invitation account approval behavior, SSO intent and synchronous seam contracts. Validation owner writes negative tests first.
2. Lane A adds additive table/migration and hardens invariant helpers; existing public repo signatures remain compatible with current tests/callers.
3. Lanes B/C build services/routes against those seams. Integration owner maps exact static ownership/accept routes before dynamic user routes and adds early feature hide.
4. Lane D adds SSO enrollment and fresh-proof ownership flow; normal SSO/password behavior unchanged without intent.
5. Integration checks issuer revoked/role-changed invites, disable/enable key permanence, personal kv cleanup, shared service-key preservation, concurrent accepts/transfer staleness, immutable personal membership, IdP rows, and safe list fields.
6. Orchestrator runs configured tests only (`npm test`, or `npx vitest run -c tests/vitest.config.js`), both switch states, lint/build/brand, real auth temp-DATA_DIR flows and security review. No validation results claimed by this lane.

## Technical Decisions

- Reuse DB constraints and synchronous transactions, not framework/event architecture. Scoped helper with narrow admin exception preserves personal-resource secrecy.
- Create invitation bearer from native crypto, hash only, fixed 7-day expiry, show once. No delivery system needed.
- Existing repository safe field projections plus API DTO allowlists close list-secret leak class. Never spread arbitrary request objects or DB credential rows into responses.
- Protect server-owner invariant separately from shared membership owner role. Preserve current multiple-manager shared model; personal workspace owner membership cannot change.
- Maintain manual/invite provenance and reject generic mutation of IdP membership. Require reauthentication for owner transfer; `amr` chooses proof method but is not proof.
- Invite issuer authority rechecked on consumption and outstanding invites revoked on issuer disable/delete. Invite cannot grant access after issuer loses management rights. No ownership access inherited from token.
- Shared resources stay in original workspace; SET NULL creator provides workspace attribution without copying secrets. Delete user keys by owner, not service keys by creator.
- Reuse shipped `audit(ctx,action,target,{before,after,result})`; it is already no-throw and deny-by-default scrubbed. Events: `invitation.create`, `invitation.revoke`, `invitation.accept`, `user.approve`, `user.roleChange`, `user.disable`, `user.enable`, `user.delete`, existing `membership.*`, existing `instance.ownership.transfer`. Snapshot fields use allowed `role`, `status`, `userId`, `workspaceId`, `count`, `reason`; never token hash as target ID.
- Do not create `workspaceKeys` or crypto subsystem here. Coordinate deletion seam with YAN-365; do not treat future DEK cache invalidation as implemented at current head.

## Open Questions

1. **Admin hierarchy:** issue grants `instance.users.manage` to admins but does not spell out admin-to-admin management/promotion. Recommended ceiling matches shipped password-reset route; approve explicit policy before code.
2. **Workspace owner ceiling:** current schema allows several shared owner memberships and does not reserve owner edits. Recommended manager cannot grant owner; owner/admin can. No exactly-one-shared-owner rule unless maintainer changes model.
3. **Operational last manager:** current helper counts disabled/pending managers. Recommended active-approved count plus disable/pending-demotion guard tightens shared-admin safety; confirm behavior expected by current SSO sync and tests.
4. **Invite approval:** checklist implies invitation admits account. Recommended new users and pending SSO acceptors become ordinary `user`; managers may grant workspace access but never instance admin. Confirm this explicit admission exception to pending JIT.
5. **Bound email proof:** password bearer+matching email does not independently prove mailbox ownership; invitation delivery is out of scope. OIDC verified email and signed SAML assertion remain required for SSO-bound invite. Confirm whether password flow needs separate mailbox verification issue.
6. **SSO group policy:** recommend allow-list remains mandatory on invited SSO enrollment; groups may add IdP roles per existing settings but cannot overwrite invite row. Confirm invite is not intended to override allow-list.
7. **SSO reauthentication capability:** configured IdPs may not provide required auth_time/AuthnInstant evidence. Fail closed and document limitation; do not call ordinary SSO round-trip sufficient fresh proof.
8. **Encryption landing:** `workspaceKeys` absent. YAN-365 must expose transaction-compatible destruction plus postcommit cache invalidation. Orchestrator decides whether to coordinate before final verification or leave explicit tested cascade contract for that issue.
9. **Backup erasure:** ADR claims old ciphertext unrecoverable after live DEK deletion, while backups also retain wrapped DEKs. Clarify scope: live deletion only versus backup retention/key destruction. Do not promise impossible erasure.
10. **Retention:** retain audit IDs and invite terminal state; cascade user keys per checklist, retain historical usage according to existing non-FK attribution design. Separate privacy/purge policy not invented here.
