# YAN-360 Invitations and User Lifecycle — Business Research

## Executive Summary

YAN-360 adds server APIs for controlled onboarding and user administration, not UI. Existing repositories already enforce instance-owner protection, basic last-manager checks, personal-workspace creation, session invalidation and user-key revocation; invitations, lifecycle HTTP routes, pagination and fresh ownership-transfer reauthentication remain missing.

Deletion already preserves shared connections, nodes, combos and service keys through foreign-key semantics, but workspace-prefixed `kv` cleanup remains incomplete. YAN-367 audit implementation is merged: extend existing events rather than introduce issue 228's originally proposed no-op interface.

Sources inspected: [GitHub issue 228](https://github.com/tokenhop/tokenhop/issues/228) via `gh issue view`; main-checkout `/home/yandy/Projects/github.com/tokenhop/tokenhop/CLAUDE.md`, `docs/users/README.md`, `docs/users/spec.md`, ADR-0001/0002/0003/0004/0005/0008; worktree code at `926151d1`. Approved spec/ADRs override handbook proposals. `RELEASING.md` overrides stale branch prose: this additive v1.1.0 feature targets `master`, not maintenance `release/1.0`. Validation belongs to orchestrator; no checks executed in this lane.

## User Stories

| Actor                   | Need                                                      | Expected outcome                                                                                                      |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Instance owner/admin    | Invite someone into a chosen workspace and role           | Recipient receives single-use onboarding credential; actor cannot expose personal resources through invitation.       |
| Workspace owner/manager | Invite someone into own shared workspace                  | Workspace A management rights cannot invite into workspace B.                                                         |
| Invite recipient        | Create password account using valid invite                | Account, personal workspace and invited membership created atomically; membership source is `invite`.                 |
| SSO recipient           | Accept invite after authenticated SSO login               | Membership applies to proven SSO user, never account inferred from email alone.                                       |
| Inviter                 | Revoke unused invite                                      | Revoked token cannot create account or membership.                                                                    |
| Instance owner/admin    | Browse users with pagination and approve pending accounts | Bounded, secret-free responses; approved users can subsequently authenticate.                                         |
| Instance owner/admin    | Change role, disable or enable user                       | Authorization follows persisted role/status; stale sessions fail; revoked keys stay revoked.                          |
| Instance owner/admin    | Delete departing user                                     | Personal workspace/resources and user keys disappear; shared resources and workspace service keys survive.            |
| Current instance owner  | Transfer ownership after fresh reauthentication           | Exactly one active, approved owner remains; former owner becomes admin; both users' sessions end.                     |
| Workspace owner/manager | Add/remove members or change roles                        | Personal workspace remains single-member; shared workspace retains management; IdP-managed memberships are protected. |

## Business Rules

### Invitations

- Invite contains preassigned workspace and workspace role; optional email binding is recipient restriction, not identity-linking rule.
- Token is cryptographically random, stored only as hash, single-use, expires seven days after creation, revocable. Token value must not appear in list/detail responses, audit rows or logs. Creation may return raw value once for delivery.
- Acceptance must atomically validate live invite, enforce recipient/workspace constraints, create or resolve account, apply membership with `source = 'invite'`, and consume token. Any failed step leaves no partial account or consumed invite.
- Password onboarding follows existing async bcrypt/password policy. Client cannot assign instance admin/owner, membership source, expiry or consumption state.
- SSO identity belongs to `(provider, issuer, subject)`. Authenticated SSO proof is required; matching email or submitted SSO claims alone never links accounts.
- Personal workspace cannot accept additional members. Invitation workspace must be shared and still exist at acceptance.
- Managers are scoped to workspaces they manage. Issue permits admin invitation; ADR-0002 currently limits `workspace.members.manage` for instance admins to workspaces they belong to. Global admin invitation override needs explicit decision; do not silently broaden generic workspace capability.
- Turning off rollout hides new invite APIs with `requireMultiUser()` and 404. Existing security established by hashed-key migration must remain enforced, even while rollout is off.

### Instance lifecycle

- Instance roles: `owner`, `admin`, `user`, `pending`; account status separately `active` or `disabled`. `pending` is role, not status.
- Exactly one instance owner. Ordinary role edits cannot create/demote owner; current owner cannot be disabled or deleted. Ownership transfer is only supported owner replacement.
- Approve pending user through explicit role transition; disable/enable must not implicitly approve pending user or elevate role.
- Role/status changes bump `sessionVersion` when changed; disable revokes every user-owned API key across workspaces. Enable does not restore revoked keys.
- Creation/reactivation of second active account is refused while `requireLogin=false`; existing repository returns `SINGLE_USER_MODE`.
- Transfer requires current owner freshly prove current authentication method, not merely possess valid JWT/`amr`. Target must be active and approved. Existing transfer demotes former owner to admin and invalidates both users' sessions.
- Existing YAN-358 temporary-password endpoint has target hierarchy: owner may reset non-owner; admin may reset only ordinary/pending users. Issue does not explicitly settle equivalent restrictions for role/status/delete operations; choose and test consistent policy before exposing them.
- User listing uses explicit safe projection, bounded pagination and deterministic order. Never return password hashes, API-key material, invitation hashes, SSO tokens or settings secrets.

### Membership and ownership

- Instance owner and workspace owner are distinct roles; transferring instance ownership does not automatically transfer workspace ownership.
- Personal workspace has exactly its user's owner membership; cannot add members, change that ownership, or independently delete workspace.
- Shared workspace cannot lose final owner/manager through membership remove/demotion or user deletion. Guard belongs inside same transaction as mutation.
- ADR-0002 excludes `source='idp'` rows from manual membership management. IdP sync may only alter IdP-sourced memberships; manual/invite memberships survive later SSO group reconciliation.
- Existing membership primary key `(workspaceId, userId)` means no parallel manual/invite/IdP membership for same account/workspace. Acceptance conflict must not silently overwrite stronger role or IdP provenance.
- Member removal revokes that user's keys within workspace, not service keys or keys in other workspaces.
- Repository guard currently counts memberships irrespective of user status. Whether disable must protect last _active_ manager requires explicit resolution.

### Deletion and retention

- Delete personal workspace, its connections/nodes/combos/settings/scoped data and keys; delete user-owned API keys in every workspace, identities, preferences and memberships.
- Retain shared workspace and its resources. Set departing user's creator attribution to workspace-owned/no user (`createdByUserId = NULL`, workspace unchanged), rather than assigning private material to unrelated user.
- Service key survival depends on `userId IS NULL`, not `createdByUserId`; service keys created by deleted user survive in retained shared workspace.
- Personal workspace destruction takes precedence over service-key survival: no key survives deletion of its owning personal workspace.
- Preserve audit history: merged audit table deliberately has no foreign keys to users/workspaces. Usage retention/attribution must not delete shared history incidentally.
- Envelope encryption is not present in this worktree. When YAN-365 lands, deletion must destroy personal-workspace DEK and invalidate any cached key. Avoid promising cryptographic erasure of backups that retain wrapped DEKs and available KEK; coordinate actual retention/security guarantee with encryption owner.

## Workflows

### Create, revoke and accept invitation

1. Gate new route behind multi-user switch; resolve authenticated actor and check capability on requested workspace. Reject personal/nonmanaged workspace and invalid role/email.
2. Persist invite metadata and random token hash; return raw token once. Record safe creation audit event. Delivery transport is not specified by issue.
3. Recipient submits token with validated password-account data, or accepts as authenticated SSO principal. Reject expired, revoked, consumed, mismatched-email or missing-workspace invite.
4. In one transaction, recheck invite and account/workspace state, create necessary user/personal workspace/identity, write invited membership and consume invite. Perform async password hashing before synchronous transaction.
5. Invalidate affected session caches after transaction and record safe acceptance event. Failed acceptance must not burn token or leave partial records.
6. Authorized inviter/admin may revoke live invitation; acceptance racing revocation must have one serialized outcome.

### Admin lifecycle

1. Require real permitted principal and `instance.users.manage`; validate bounded pagination or allow-listed action payload.
2. Reload target state inside mutation transaction; protect owner and any applicable target hierarchy.
3. Approve/change role or disable/enable through existing user update semantics. Disable revokes user keys; role/status changes invalidate cached sessions.
4. Delete only after checking shared-workspace management invariants. Personal workspace deletion cascades FK-owned rows; explicitly clean non-FK scoped storage; user deletion clears shared creator references.
5. Emit one safe lifecycle audit event after successful commit. Return only safe metadata or success result.

### Ownership transfer

1. Require current owner capability and fresh method-appropriate proof; CLI/local fallback or old session alone cannot substitute for reauthentication.
2. Recheck current owner, target active/approved state and proof binding in transaction.
3. Demote current owner first, promote target, clear IdP role provenance and bump both session versions atomically.
4. Invalidate sessions and emit existing `instance.ownership.transfer` event once. Workspace memberships stay unchanged.

### Workspace membership change

1. Resolve target shared workspace and check `workspace.members.manage` for that workspace, not merely any workspace.
2. Validate member/role and reject IdP-sourced manual mutation; apply owner policy and last-manager guard within transaction.
3. Insert manual membership, change role, or remove membership. Removal revokes member's workspace-scoped user keys.
4. Emit existing membership audit event once. Re-resolve principal memberships on subsequent requests; define whether role change also bumps `sv` for consistent revocation behavior.

## Domain Model

| Entity                 | Existing shape / proposed addition                                                                                                                       | Lifecycle significance                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| User                   | `id`, nullable unique email/username, displayName, instanceRole, status, passwordHash, sessionVersion, mustChangePassword; internal `instanceRoleSource` | Explicit manual role write clears IdP provenance, even same-role write. Secrets stay internal.                    |
| Identity               | `userId`, provider, issuer, subject, emailAtLink; unique provider/issuer/subject                                                                         | Stable SSO identity; password identity uses user ID.                                                              |
| Workspace              | `id`, name, personal/shared kind, nullable createdBy                                                                                                     | One personal workspace per user; shared workspace survives creator deletion.                                      |
| Membership             | workspaceId/userId composite key, role, manual/invite/idp source                                                                                         | Separates invitation from IdP authority; personal membership is owner/manual.                                     |
| Invitation — missing   | Proposed: id, workspaceId, role, optional email, tokenHash, createdByUserId, createdAt, expiresAt, consumedAt, revokedAt                                 | Derived states live/expired/consumed/revoked; raw token never stored. Exact schema remains implementation choice. |
| API key                | workspaceId; nullable userId; nullable createdByUserId; keyHash/prefix; revokedAt                                                                        | User ownership determines revocation/deletion; creator attribution does not.                                      |
| Audit event            | Actor, workspace, action, target, before/after, result, timestamp                                                                                        | Retains lifecycle history without account FK or secret snapshots.                                                 |
| Workspace key — future | workspaceId, wrapped DEK, key ID                                                                                                                         | Destroy with personal workspace once encryption exists.                                                           |

## Existing Codebase Integration

| Requirement                          | Existing integration point                                                                           | Coverage / gap                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe user reads, approve/role/status | `src/lib/db/repos/usersRepo.js`                                                                      | Explicit `COLS` omits hashes. `listUsersUnscoped()` currently unbounded; no lifecycle HTTP routes except temporary password. `updateUserUnscoped()` handles owner checks, provenance and revocation.                                                                                                                                                      |
| Atomic invited account               | `createUserWithPersonalWorkspaceSync()` in users repo; `insertIdentitySync()` in `identitiesRepo.js` | Caller-owned sync transaction pattern already used by SSO; needs invite validation/consumption and membership insertion in same transaction.                                                                                                                                                                                                              |
| Invitation token                     | `src/lib/users/bootstrap.js`                                                                         | Setup token provides `randomBytes(32)`, SHA-256, constant-time check and atomic consumption example. Different 60-minute setup purpose: do not reuse singleton metadata storage for invitations.                                                                                                                                                          |
| SSO proof and pending admission      | `src/lib/users/ssoProvisioning.js`; OIDC callback and SAML ACS routes                                | Existing stable-ID JIT and group sync preserve invite rows. Pending SSO users receive pending result rather than normal session; authenticated invite acceptance needs deliberate pending-flow design. No invite callback handoff exists.                                                                                                                 |
| Authorization                        | `src/lib/users/principal.js`, `session.js`; `src/lib/auth/routePolicy.js`                            | Fixed capability matrix and explicit route coverage. Only `/api/users/[id]/password` and `/api/workspaces/[id]/settings` currently mapped in this domain; new routes need entries and exact-workspace handler checks.                                                                                                                                     |
| Mutation request protections         | `src/lib/auth/sameOrigin.js`; temporary-password route                                               | Reuse cross-site rejection, JSON check, safe errors and `Cache-Control: no-store`; do not accept bulk-assigned security fields.                                                                                                                                                                                                                           |
| Disable/key survival                 | `src/lib/db/repos/apiKeysRepo.js`, `src/lib/users/securityState.js`                                  | `revokeUserApiKeysSync()` revokes by user/workspace; hashed-key eligibility requires active approved user plus membership. Durable security latch must not regress when rollout is off.                                                                                                                                                                   |
| Membership invariants                | `src/lib/db/repos/membershipsRepo.js`                                                                | Last-manager, personal-workspace restriction, scoped membership existence and removal key revocation exist. Public mutation methods do not enforce management capability or IdP-row exclusion; no special workspace-owner protection beyond last-manager.                                                                                                 |
| Delete cascade                       | `usersRepo.js`; migrations `004`, `005`, `008`, `009`; `src/lib/db/schema.js`                        | Personal FK rows cascade; shared creator refs become NULL; hashed user keys cascade and service keys survive. Workspace-prefixed `kv` has no FK and current deletion does not clean it. No `workspaceKeys` table yet.                                                                                                                                     |
| Ownership transfer                   | `transferOwnership()` in users repo                                                                  | Atomic single-owner replacement, active/approved target, two session bumps and audit event exist. No fresh reauthentication endpoint/proof; owner-password helper alone does not cover SSO owner. Principal resolution does not expose `amr` as proof.                                                                                                    |
| Audit                                | `src/lib/users/audit.js`, `src/lib/db/repos/auditRepo.js`                                            | Real best-effort async audit exists, not no-op. Membership mutations and transfer already emit events. Invitation and user update/delete routes need events; avoid duplicate membership/transfer events. Snapshot allow-list accepts `role`, not `instanceRole`; use permitted safe fields. Repo-level events lack request IP unless context is enriched. |
| Pagination precedent                 | `src/lib/db/repos/auditRepo.js`, `src/app/api/audit/route.js`                                        | Existing page/pageSize/offset pattern; use bounded values and stable tie-breaker for user listing rather than loading all users.                                                                                                                                                                                                                          |

Existing tests inspected for expected behavior:

- `tests/unit/db-tenancy-schema.test.js`: owner protection/transfer, last-manager, personal-workspace rules, safe user projection, IdP provenance and transaction behavior.
- `tests/unit/principal-sessions.test.js`: immediate cache invalidation, <=5-second external-write TTL, disabled-session refusal, single-user behavior.
- `tests/unit/sso-jit.test.js`: pending JIT, stable identity instead of email linking, manual/invite membership preservation.
- `tests/unit/tenancy-isolation.test.js`, `tests/setup/tenancyHarness.js`: `seedTenancy`, `denied`, `callRoute` cross-workspace pattern.
- `tests/unit/audit-management-events.test.js`, `audit-redaction.test.js`, `audit-repo.test.js`: existing audit hooks, pagination and safe snapshots.
- `tests/unit/route-policy.test.js`, `tenancy-guard.test.js`: explicit route mapping and table classification. New invitation table requires classification.

## Success Criteria

- Valid password and authenticated SSO invite acceptance produce exact preassigned membership with `source='invite'`; passwords use existing policy and SSO never links by email alone.
- Expired-at-boundary, consumed, revoked, wrong-email and wrong-workspace tokens fail without writes; concurrent acceptance cannot consume same token twice.
- Workspace A manager cannot create/revoke/manage invitations or memberships for workspace B; member/viewer/pending cannot manage members. Personal-workspace invitation fails.
- User list has bounded, deterministic pagination and explicit no-secrets assertions on list/detail/error/audit outputs.
- Approve/role/status transitions enforce target policy; disable invalidates sessions immediately in process and revokes all user-owned keys; enable leaves old keys revoked.
- Ownership transfer requires fresh proof, leaves exactly one owner, invalidates both users' sessions and emits one audit event; owner ordinary demotion/disable/delete fail.
- Last-manager and personal-owner protections cover every exposed mutation; manual APIs cannot change IdP-sourced rows. Define and test disabled-last-manager rule.
- Delete removes personal resources and workspace-prefixed data plus user keys everywhere; shared resources, shared service keys and audit history survive with creator references cleared. Rejected deletion rolls back completely.
- New APIs return 404 with rollout off; existing single-user behavior and established durable security remain unchanged. New schema is additive/idempotent and covered by legacy fixture/table classification tests.
- Orchestrator validates full handbook gate: lint, baseline tests in both switch states, build, brand guard, isolated real auth flows and security review. This research makes no pass/fail claim.

## Open Questions

1. **Global admin invitation authority:** issue permits admin invitation; approved matrix and repos require membership for `workspace.members.manage`. Should invitation use explicit instance-level override for shared workspaces, while membership APIs stay scoped?
2. **SSO pending acceptance:** JIT defaults to pending and issues no normal session. How does pending recipient obtain authenticated acceptance proof? Does valid invite approve ordinary user, or is separate admin approval still required? Password-created account default role needs same decision.
3. **Email binding:** what proof is sufficient for password onboarding versus SSO (`emailAtLink` alone is informational)? Specify normalization and verified-email policy without introducing automatic email-based account merging.
4. **Existing-account/conflict semantics:** can existing password users accept? Can invite replace IdP membership or promote existing member? Safest default is explicit conflict, never blind overwrite; determine idempotent response policy separately from token single-use.
5. **Workspace owner invariant:** current repo allows owner demotion/removal if another manager exists and permits multiple workspace owners. Must shared workspace always retain owner, or only owner/manager? May manager grant/remove owner role? Issue requires owner invariants but does not define dedicated workspace ownership-transfer API.
6. **Last active manager and target hierarchy:** must disable protect sole active manager? May admin change/delete peer admin or self-disable? Clarify before exposing broad repository operations.
7. **Fresh SSO reauthentication:** no method-bound short-lived reauth proof exists. Define OIDC/SAML fresh-login mechanism and server-verified proof lifetime; possession of current session is insufficient.
8. **Invite delivery/API surface:** issue specifies email binding, not SMTP delivery, landing UI, resend/list endpoints or transport. Keep server scope; choose one-time token response and exact public acceptance contract with UI/CLI owners.
9. **Retention/security follow-up:** agree usage attribution, orphan invitation cleanup on inviter/user/workspace deletion, DEK/cache deletion seam and backup crypto-erasure limits with YAN-365/YAN-370/YAN-375. Current branch lacks encryption; do not add placeholder encryption implementation here.
