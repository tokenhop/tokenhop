# Feature Spec: YAN-360 — Invitations, Admin User Lifecycle and Workspace Membership APIs

## Executive Summary

YAN-360 adds server-only invitations, admin user lifecycle, and workspace membership APIs, landing on `master` for v1.1.0 (no backport). Every new route answers 404 while `TOKENHOP_MULTI_USER` is off, enforced at guard level plus `requireMultiUser()` in handlers. Managers and admins mint single-use, SHA-256-hashed, 7-day tokens; acceptance atomically creates an approved `user` with personal workspace and invited membership, or links a verified SSO identity. Admins get paginated listing, approve/role/status/delete, password-re-authenticated ownership transfer, and membership management. It reuses existing repositories, merged audit, and the setup-token pattern; no new dependencies, UI, or email.

## External Dependencies

### APIs and Services

No external services. No email delivery (token returned once to creator for out-of-band relay). All platform APIs are in-repo:

#### Next.js Route Handlers (Next 16.x, Node 22)

- **Documentation**: [Next.js App Router Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
- **Authentication**: dashboard session cookie (existing `dashboardSession.js`) for management routes; public bearer token for accept route.
- **Key endpoints**: all 13 new routes listed under [API Design](#api-design).
- **Constraints**: `params` and `cookies()` are async (Next 15+) — `await` before use; responses via `NextResponse.json(body, { status, headers })`; sensitive responses set `Cache-Control: no-store` (precedent: `src/app/api/auth/setup-token/route.js`).

#### Node `node:crypto`

- **Documentation**: [Node crypto](https://nodejs.org/api/crypto.html)
- **Usage**: `randomBytes(32).toString("base64url")` (256-bit token), `createHash("sha256").digest("hex")` (storage), `timingSafeEqual` (comparison, length-check first — it throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on mismatch).

### Libraries and SDKs

| Library     | Version            | Purpose                                                | Installation       |
| ----------- | ------------------ | ------------------------------------------------------ | ------------------ |
| bcryptjs    | ^3.0.3 (installed) | Password hash/verify on accept + transfer re-auth      | none — already dep |
| jose        | ^6.1.3 (installed) | Existing session JWTs; SSO invite-intent state signing | none — already dep |
| node:crypto | Node 22 builtin    | Token mint/hash/compare                                | none               |

**No new dependencies** (handbook §8). Validation stays hand-rolled (no zod). Detail: [research-external.md](./research-external.md), [research-practices.md](./research-practices.md).

### External Documentation

- [GH tokenhop/tokenhop #228](https://github.com/tokenhop/tokenhop/issues/228): issue checklist (source of scope).
- `docs/users/spec.md`, `docs/users/README.md`, ADR-0001…0008 (main checkout): roles/capabilities (0002), identity/bootstrap (0003), sessions `sv` (0004), key hashing (0005).
- `RELEASING.md`: v1.1.0 trunk-only landing on `master`.

## Business Requirements

### User Stories

**Instance owner/admin**

- As an instance admin, I want to invite a person into a chosen shared workspace with a preset role, so that onboarding needs no shared credential.
- As an admin, I want to list users with pagination, approve pending accounts, change roles, disable/enable, and delete users, so that lifecycle stays controlled and secret-free.
- As the instance owner, I want to transfer ownership only after re-proving my password, so that a stolen session cannot take the instance.

**Workspace owner/manager**

- As a workspace manager, I want to invite/add/remove members and change roles in my workspace only, so that workspace A rights never reach workspace B.
- As an inviter, I want to revoke an unused invite, so that a leaked token dies.

**Invite recipient**

- As a recipient, I want to accept an invite with a new password or my authenticated SSO identity, so that I get the exact preassigned membership with `source='invite'`.
- As a signed-in user, I want to accept an invite with my session, so that I gain a membership without a new account.

Detail: [research-business.md](./research-business.md).

### Business Rules

1. **Switch gating**: every new route returns 404 while `TOKENHOP_MULTI_USER` is off (default); single-user behavior byte-identical. Existing durable security latch (`isUserSecurityEnforced`) is never substituted for `requireMultiUser()`.
2. **Invitation token**: single-use, 256-bit random, stored only as SHA-256 hex, 7-day server-owned expiry, revocable. Raw token appears exactly once, in the create response — never in list/detail/audit/logs.
3. **Invite roles**: `manager`, `member`, `viewer` only; shared workspaces only. Granting `manager` requires workspace owner or instance admin. Personal workspace target → `PERSONAL_WORKSPACE` error. No instance-role field on invitations — a token can never grant `admin`/`owner`.
4. **Who may invite/manage**: workspace owner/manager for that workspace; instance admin/owner may invite into any shared workspace via `instance.users.manage` (narrow elevated path, no personal-resource access). Membership-management routes stay scoped to workspaces the caller manages (admins via `instance.users.manage` too).
5. **Acceptance**: one atomic transaction validates token (live, unexpired, unrevoked, unconsumed), checks workspace eligibility, creates or resolves the account, writes membership `source='invite'`, and consumes the token. Any failed step leaves no partial account and an unconsumed token. New password accounts are approved `user` (never `pending`/`admin`). Email-bound invites require account/verified IdP email match; email never links identities.
6. **SSO acceptance**: invite proof rides server-controlled OIDC/SAML state; identities link only by `(provider, issuer, subject)`; accepted SSO invitee becomes approved `user`; SSO allowed-group check still applies. Existing membership (any source, incl. `idp`) → explicit conflict error, never overwrite.
7. **Admin hierarchy** (matches shipped temporary-password route): owner may act on admins and users; admins only on `user`/`pending`. Only owner grants/demotes admin. Owner never changed except via transfer. Allow-list `instanceRole` {`admin`,`user`,`pending`} and `status` {`active`,`disabled`}.
8. **Disable**: status flip + `sv` bump + revoke all user-owned keys (including legacy-format rows) in one transaction; drop session cache. Enable never resurrects keys. Disabling the last active manager of a shared workspace is refused.
9. **Ownership transfer**: current password re-verified in the same request (limiter + dummy-hash cover); demote-before-promote inside one transaction; both `sv` bumped; both sessions die. SSO-only owners fail closed with a clear error (follow-up issue).
10. **Deletion**: FK cascades (migrations 004/005/008/009, `schema.js`) already remove personal workspace rows + memberships and SET NULL creator on shared rows; service keys (`userId IS NULL`) survive. Added explicitly: cleanup of personal `ws:<id>/` kv rows, user-key revocation/deletion everywhere, last-manager guard on shared workspaces. Invites the user created stay valid (workspace-issued grants; `createdByUserId` SET NULL). DEK destruction deferred to YAN-365 — no placeholder code.
11. **Memberships**: role allow-list {`manager`,`member`,`viewer`} for managers; server forces `source` (`manual` on direct add, `invite` on accept); `source='idp'` rows read-only to manual APIs; last owner/manager guard inside the mutation transaction; removal revokes that user's keys in that workspace only.
12. **User list**: `page`/`pageSize` pagination clamped ≤100, stable ordering, explicit `COLS` projection; no hashes/tokens/keys anywhere in responses, logs, or audit.
13. **Audit**: reuse merged YAN-367 `audit()`; add `invitation.create`/`invitation.revoke`/`invitation.accept` and `instance.users.*`; do not duplicate events already emitted by membership/transfer repos.

### Edge Cases

| Scenario                                       | Expected Behavior                                                                    | Notes                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| Expired invite (boundary `now >= expiresAt`)   | reject inside consume tx                                                             | UTC ISO compare                         |
| Reused / revoked / double-accept race          | single generic failure; exactly one winner                                           | one DB transaction, conditional consume |
| Email binding mismatch / case tricks           | generic failure after trim+lowercase on both sides                                   | no oracle                               |
| SSO login with matching email, different `sub` | does not claim invite                                                                | triple-only linking                     |
| Manager of A operates workspace B              | 404 (invisible) or 403 — never data                                                  | exact-URL workspace check               |
| Pending user invites / member invites          | 403                                                                                  | capability check                        |
| Invite into personal workspace                 | `PERSONAL_WORKSPACE`                                                                 | incl. admin calls                       |
| Last manager removed/demoted/disabled/deleted  | `LAST_MANAGER` / refused, in-transaction                                             | concurrent pair → one fails             |
| Owner patched via role/status/delete           | `OWNER_IMMUTABLE`                                                                    | transfer is only path                   |
| Disable then enable                            | old sessions and keys stay dead                                                      | re-login required                       |
| Duplicate active invite same email+workspace   | allowed; each token independent                                                      | rotate-on-recreate is follow-up         |
| Switch off                                     | all new routes 404, anonymous and authenticated, both switch states of durable latch | guard-level ordering                    |

### Success Criteria

- [ ] Password and SSO acceptance produce exact preassigned membership `source='invite'`; invitee is approved `user`; token consumed once.
- [ ] Expired/consumed/revoked/wrong-email/wrong-workspace tokens fail without writes; concurrent accepts yield one winner.
- [ ] Cross-workspace manager denial, role escalation, personal-workspace invite, and owner immutability all enforced and tested.
- [ ] Disable revokes sessions + all user keys (incl. legacy) immediately in-process; enable restores nothing.
- [ ] Transfer requires fresh password proof; wrong password → 401, no state change; success leaves exactly one owner and kills both sessions.
- [ ] Deletion: personal scope (incl. `ws:<id>/` kv) and user keys gone everywhere; shared rows, service keys, audit history survive; last-manager guard holds.
- [ ] User/member/invite lists carry no secrets (test-asserted); pagination clamped; IdP rows untouched by manual APIs.
- [ ] Every new route 404 with switch off; single-user regression green; `ROUTE_POLICY` and tenancy-classification tests green.

## Technical Specifications

### Architecture Overview

```text
Client (dashboard / operator)
  │
  ▼
Next.js route handlers (13 new, src/app/api/...)
  │  order: routePolicy multiUserOnly → 404 while off (dashboardGuard),
  │         then requireMultiUser() again in handler, then principal,
  │         same-origin + JSON check, capability + exact-workspace check
  ▼
userManagement.js (mgmt auth)   invitations.js (accept orchestration)   ownershipTransfer.js (re-auth proof)
  │                                   │ bcrypt hash BEFORE sync tx          │ verifyPassword + limiter
  ▼                                   ▼                                     ▼
usersRepo / membershipsRepo / invitationsRepo  ──►  db.transaction (synchronous)
  │  invariants: single-owner index, OWNER_IMMUTABLE, assertNotLastManager,
  │  sv bump + dropSession + revokeUserApiKeysSync (+ legacy tombstone)
  ▼
SQLite (invitations table, migration 012)      audit() after commit (no tokens/hashes)
```

Guard-order rule (release-critical): `dashboardGuard.checkApiPolicy` checks a new `multiUserOnly` route-policy flag **before** authentication/local checks so 401/403 can never leak while the switch is off; each handler repeats `requireMultiUser()` for direct execution. Detail: [research-technical.md](./research-technical.md) §System Constraints, [research-recommendations.md](./research-recommendations.md) §Risk Assessment.

### Data Models

#### `invitations` (new table, migration `012-invitations.js` — re-check next version on rebase)

| Field            | Type           | Constraints                                      | Description                                        |
| ---------------- | -------------- | ------------------------------------------------ | -------------------------------------------------- |
| id               | TEXT (uuid v4) | PK                                               | public management handle; never a bearer           |
| workspaceId      | TEXT           | NOT NULL, FK `workspaces(id)` ON DELETE CASCADE  | target shared workspace                            |
| role             | TEXT           | NOT NULL, CHECK IN (`manager`,`member`,`viewer`) | preassigned workspace role                         |
| email            | TEXT           | NULL, bounded; normalized trim+lowercase         | access condition, never identity lookup key        |
| tokenHash        | TEXT           | NOT NULL, UNIQUE                                 | SHA-256 hex of 32-byte base64url token             |
| createdByUserId  | TEXT           | NULL, FK `users(id)` ON DELETE SET NULL          | issuer provenance; invites survive issuer deletion |
| createdAt        | TEXT           | NOT NULL, UTC ISO                                |                                                    |
| expiresAt        | TEXT           | NOT NULL, UTC ISO                                | `createdAt + 7d`, server-owned, immutable          |
| consumedAt       | TEXT           | NULL, UTC ISO                                    | terminal state                                     |
| consumedByUserId | TEXT           | NULL, FK `users(id)` ON DELETE SET NULL          | preserve consumed state after user deletion        |
| revokedAt        | TEXT           | NULL, UTC ISO                                    | terminal state                                     |

**Indexes:** `(workspaceId, createdAt, id)` for scoped listing; `tokenHash` UNIQUE is the accept lookup.
**Relationships:** workspace cascade (workspace gone → invites gone); user SET NULL both ends (state preserved).
Derived state (live/expired/consumed/revoked) computed from timestamps — no mutable status column. Workspace/role/email immutable after issuance; change = revoke + create. Classify table `scoped` by `workspaceId` in tenancy guard (`tenancy.js` + table-classification test). Idempotent migration; registry + `schema.js` + classification updated together.

#### Existing entities (gaps to close — WARNING)

- `users`: add paginated safe reader (page/pageSize SQL, stable `createdAt,id` order, `COLS` projection, never `SELECT *`); API DTO omits `sessionVersion` and `instanceRoleSource` too. `updateUserUnscoped` gains `instanceRole`/`status` allow-lists and hierarchy checks (C-B).
- `memberships`: PK `(workspaceId,userId)`; API writes never choose `source`; `source='idp'` rows rejected (409 `idp_managed`); last-owner/manager guard in-transaction counting **active** managers (disable of last active manager refused); removal revokes user keys in that workspace only. Public mutators currently check membership not capability — handler + tx re-check required (C-A).
- `identities`: UNIQUE `(provider,issuer,subject)`; never look up by invite email.
- Deletion matrix (verified FK behavior): personal workspace rows cascade; shared `createdByUserId` SET NULL; service keys (`userId IS NULL`) survive; add explicit `ws:<personalId>/` kv prefix deletion (no FK — bound `substr`/escaped equality, never unescaped LIKE); revoke/delete user keys in all workspaces incl. legacy-format rows (C-C, C-E).

### API Design

Shared conventions (WARNING — apply to every route): `Cache-Control: no-store`; invitation/proof responses add `Referrer-Policy: no-referrer`; mutations reject cross-site (`isCrossSite`) and non-JSON (`isJson`) requests; strict body shapes — reject unknown keys, arrays, malformed UUID/role/status/page, oversize fields, caller-supplied `source`/expiry/consumption state/`sessionVersion`; fixed safe error literals `{ error, code }`; token never in URL/query. `params`/`cookies()` awaited (Next 15+). `ROUTE_POLICY` row per route/method (route-policy test fails otherwise; keep file import-free). Missing/non-member workspace → 404; member without management role → 403.

#### `GET /api/users?page=1&pageSize=20`

**Purpose**: paginated user list. **Authentication**: `instance.users.manage`.

**Response (200):**

```json
{
  "users": [
    {
      "id": "…",
      "email": "…",
      "username": "…",
      "displayName": "…",
      "instanceRole": "user",
      "status": "active",
      "createdAt": "…"
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 2, "totalPages": 1 }
}
```

`pageSize` clamped 1–100; stable `createdAt,id` ordering; no hashes/tokens/keys/`sessionVersion`/`instanceRoleSource` (test-asserted).

#### `PATCH /api/users/[id]`

**Purpose**: approve / role change / status change. **Authentication**: `instance.users.manage` + hierarchy (owner: admins+users; admin: user/pending only; only owner grants/demotes admin; never `owner`; never self via admin endpoint).

**Request:** exactly one of `{ "action": "approve" }`, `{ "instanceRole": "admin"|"user"|"pending" }`, `{ "status": "active"|"disabled" }` (allow-lists enforced; owner row → `OWNER_IMMUTABLE`).

**Response (200):** safe user metadata (same DTO as list).
**Errors:** 400 invalid shape; 403 capability/hierarchy/owner; 404 unknown; 409 stale state. Disable = status + `sv` bump + revoke **all** user-owned keys (hashed **and legacy-format** rows) in one transaction + `dropSession`; disabling last active manager of a shared workspace refused; enable bumps `sv` and resurrects nothing.

#### `DELETE /api/users/[id]`

**Purpose**: delete user with full cascade. **Authentication**: as PATCH; instance owner cannot be deleted.
**Response (200):** `{ "success": true }`. One transaction: guards → revoke/delete user keys everywhere → delete personal workspace (FK cascade rows) → explicit `ws:<id>/` kv cleanup → last-manager guard per shared workspace → delete user (shared creator refs SET NULL; invites survive) → `dropSession`. No `workspaceKeys`/DEK code (YAN-365).

#### `POST /api/users/ownership-transfer`

**Purpose**: transfer instance ownership with fresh proof. **Authentication**: `instance.ownership.transfer` + live browser owner session.

**Request:**

```json
{ "toUserId": "uuid", "currentPassword": "owner's current password" }
```

Password re-verified in the same request (`verifyPassword` against stored hash; IP+account limiter; dummy-hash timing cover for unknown; `MAX_PASSWORD_LENGTH` cap). No default-password fallback. SSO-only owner → fail closed, clear `reauth_unsupported` error (follow-up issue); existing session is never proof. Transaction rechecks live owner (expected `sv`), target active+approved; demote old owner → promote new (single-owner index); dual `sv` bump; both caches dropped.
**Errors:** 400 shape; 401 `reauth_required` (no state change); 403 not owner; 409 invalid/stale target.

#### `GET` / `POST /api/workspaces/[id]/members`; `PATCH` / `DELETE /api/workspaces/[id]/members/[userId]`

**Purpose**: list/add/change-role/remove membership. **Authentication**: exact-URL workspace `workspace.members.manage` (owner/manager member), or instance admin/owner via `instance.users.manage`; personal workspace → `PERSONAL_WORKSPACE` on every mutation; non-member caller → 404.

**Request (POST)**: `{ "userId": "uuid", "role": "manager"|"member"|"viewer" }` — server sets `source='manual'`. **Request (PATCH)**: `{ "role": … }` — allow-list; managers may not grant above `manager` (owner-granting reserved to workspace owner/instance admin). Existing row of any source → 409 `membership_exists`; `source='idp'` row → 409 `idp_managed` (read-only to manual APIs). DELETE: last owner/manager guard in-transaction (`LAST_MANAGER`); revokes that user's keys in this workspace only (never service keys, never other workspaces). Audit: existing `membership.*` repo events, not duplicated.

#### `GET` / `POST /api/workspaces/[id]/invitations`; `DELETE /api/workspaces/[id]/invitations/[inviteId]`

**Purpose**: list/mint/revoke invitations. **Authentication**: same workspace-management rules as members.

**Request (POST)**:

```json
{ "role": "member", "email": "sam@example.invalid" }
```

**Response (201)** — token present exactly once:

```json
{
  "invitation": {
    "id": "uuid",
    "workspaceId": "…",
    "role": "member",
    "email": "sam@example.invalid",
    "createdAt": "…",
    "expiresAt": "…"
  },
  "token": "43-char-base64url"
}
```

`role` allow-list `manager|member|viewer` (`manager` needs workspace owner or instance admin); shared workspace only; email optional, normalized. GET: metadata only (`id`, role, email, timestamps, derived state) — no token, no hash. DELETE: revoke unused invite; already-terminal → idempotent `{ "success": true }`; revoke never unconsumes.

#### `POST /api/invitations/accept` (public, switch-gated)

**Purpose**: consume an invitation. **Authentication**: none (valid token is authorization) for password enrollment; valid session for existing-user accept; server-controlled SSO state for SSO.

**Request (password enrollment)**:

```json
{
  "token": "…",
  "method": "password",
  "email": "sam@example.invalid",
  "username": "sam",
  "displayName": "Sam",
  "password": "…"
}
```

Also `{ "token": "…" }` with an authenticated session (adds membership only; subject from live session, never body; disabled/pending cannot use this path; never sets/replaces password).

**Response (200):** safe receipt `{ "user": {…}, "workspaceId": "…" }` — require normal login; no implicit auto-login.

Flow (WARNING — ordering is load-bearing): `requireMultiUser()` → same-origin/JSON → rate limit (IP **and** token-hash buckets, bounded like `loginLimiter`) → validate token shape (strict 43-char base64url) → hash + indexed `tokenHash` lookup with dummy-work cover → bcrypt hash password **before** sync transaction → single transaction: re-read invite (`consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`), email binding (normalized match), workspace shared+existing, identifier uniqueness → create approved `user` + personal workspace + password identity + membership `source='invite'` → conditional consume (exactly one changed row). Failed insert → rollback, token unconsumed. All invalid/expired/revoked/consumed/mismatch states → one generic 400 `invite_invalid`.

**SSO acceptance** (WARNING): carry invite proof through server-controlled OIDC/SAML state — short-lived signed `purpose='invite-accept'` intent (invite hash, protocol, nonce, ≤10 min) bound into freshly generated OIDC state/nonce/PKCE or SAML request ID; raw token never in redirect URLs. Callback verifies protocol normally (signatures, replay, allow-list/groups still apply); only the verified server identity object reaches the accept transaction; link by `(provider, issuer, subject)` only; email binding satisfied by verified IdP email (`email_verified === true` for OIDC), never links identities; accepted invitee becomes approved `user`; membership conflict (any source incl. `idp`) → 409, never overwrite; disabled linked account fails without consuming. Keep SSO-linking calls at `resolveSsoUser`-level API — no provider imports into proxy-loaded modules (proxy-bundle constraint).

### System Integration

#### Files to Create

- `src/lib/db/migrations/012-invitations.js`: idempotent table creation (re-check number on rebase).
- `src/lib/db/repos/invitationsRepo.js`: create/list/revoke (scoped, `ctx` first) + synchronous consume seam for caller-owned transaction.
- `src/lib/users/invitations.js`: accept orchestration (password path, existing-user path, SSO verified-identity path).
- `src/lib/users/userManagement.js`: management-authorization helper (live capability + exact-workspace verification).
- `src/lib/users/ownershipTransfer.js`: password re-auth proof for transfer.
- Route files: `src/app/api/users/route.js`, `src/app/api/users/[id]/route.js`, `src/app/api/users/ownership-transfer/route.js`, `src/app/api/workspaces/[id]/members/route.js`, `src/app/api/workspaces/[id]/members/[userId]/route.js`, `src/app/api/workspaces/[id]/invitations/route.js`, `src/app/api/workspaces/[id]/invitations/[inviteId]/route.js`, `src/app/api/invitations/accept/route.js`.
- Tests: `tests/unit/invitations.test.js`, `user-lifecycle.test.js`, `membership-management.test.js`, `ownership-transfer.test.js` (reuse `tenancyHarness.js` `seedTenancy`/`callRoute`/`denied`).

#### Files to Modify

- `src/lib/auth/routePolicy.js`: one row per new route/method; new `multiUserOnly` flag (import-free).
- `src/dashboardGuard.js`: check `multiUserOnly` before auth/local checks → 404 while off.
- `src/lib/db/schema.js`, migration registry, `src/lib/db/tenancy.js`: table + classification.
- `src/lib/db/repos/usersRepo.js`: SQL pagination; role/status allow-lists + hierarchy (C-B); disable legacy-key tombstone (C-E); delete-time `ws:<id>/` kv cleanup + all-workspace key revocation (C-C). Keep ≤500 lines — cascade helper in `ownership.js` or small lifecycle module.
- `src/lib/db/repos/membershipsRepo.js`: capability + source enforcement seams, active-manager last-guard count.
- `src/lib/users/audit.js`: `ALLOWED` gains `inviteId` (ids/roles/status only; never token/hash; `instanceRole` maps to `role`).
- OIDC/SAML start/callback + ACS routes: invite-intent state binding.

#### Configuration

- `TOKENHOP_MULTI_USER`: sole rollout switch; read only via `featureSwitch.js`.

## UX Considerations

Server APIs only — UI lands M5 (YAN-373). This section records contracts the future UI depends on; detail: [research-ux.md](./research-ux.md).

### User Workflows

#### Primary Workflow: invite → accept → membership

1. **Create** — manager/admin POSTs `{role, email?}`; system returns token once (future UI: YAN-363 `CreatedBanner` show-once pattern; admin relays out-of-band).
2. **Accept (password)** — recipient POSTs token + credentials; system creates approved `user`, personal workspace, membership `source='invite'`; receipt response, then normal login.
3. **Accept (SSO)** — recipient POSTs token, completes provider round-trip carrying server-side intent; verified identity gains membership.
4. **Accept (existing user)** — signed-in member POSTs token; membership added to live session's user.

#### Error Recovery Workflow

1. **Failure** — invalid/expired/revoked/consumed/mismatched email → one generic 400 `invite_invalid` (no enumeration oracle); recovery = admin issues new invite.
2. **Rate limited** — 429 + `Retry-After`; retry later.
3. **Transfer re-auth failure** — 401 `reauth_required`, zero state change; retry with correct password.

### UI Patterns

| Component              | Pattern                                   | Notes                                                                                                |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Error contract         | `{ error, code }` stable snake_case codes | UI maps codes (future `inviteErrors.js` mirroring `loginErrors.js`); unknown code → generic fallback |
| Token display (future) | show-once + hint                          | mono `dir="ltr"`, `tokenHint` prefix-style identification; lists never carry token/hash              |
| Password errors        | reuse `validateNewPassword` codes         | identical inline errors as login/change-password                                                     |

### Accessibility Requirements

- Stable machine codes + human literals on every failure so future UI localizes without parsing English.
- Token input: server trims surrounding whitespace, preserves case (tokens case-sensitive).
- Destructive confirms (delete/disable/transfer) are a future-UI concern; server requires re-auth for transfer regardless.

### Performance UX

- Accept is one transactional POST — no extra round-trips; no implicit auto-login.
- Disable/role-change land on next request in-process; ≤5 s cross-process bound (ADR-0004 cache TTL) — no "force logout" affordance needed.
- Lists paginated; no polling for invite state (expiry derived from `expiresAt`).

## Recommendations

### Implementation Approach

**Recommended Strategy**: thin routes + existing repositories + one invitations repo/service; sync transaction-local helpers only where acceptance needs atomic composition; hash passwords before entering the synchronous transaction; re-read every authorization-dependent value inside the transaction (request principals are not authority after an `await`). Alternatives (delay for encryption, password-only invites, generic lifecycle platform) rejected — see [research-recommendations.md](./research-recommendations.md).

**Phasing:**

1. **Phase 1 — persistence + invariants**: migration 012, invitations repo, tenancy classification, usersRepo pagination/allow-lists/hierarchy, memberships hardening, deletion kv cleanup.
2. **Phase 2 — routes + guard**: route-policy rows + `multiUserOnly` guard ordering, users/members/invitations management routes, audit events.
3. **Phase 3 — accept + transfer**: password/existing-user accept, SSO intent carry, ownership-transfer re-auth.

### Technology Decisions

| Decision      | Recommendation                                  | Rationale                                                                           |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Token hashing | plain SHA-256 hex (not HMAC)                    | 256-bit entropy; no master-key coupling (ADR-0005 HMAC was for ~31-bit legacy keys) |
| Token mint    | `randomBytes(32)` base64url (~43 chars)         | matches setup-token precedent                                                       |
| Re-auth       | inline password verify in transfer POST         | one request, no cookie surface, no new token type                                   |
| Pagination    | page/pageSize (auditRepo precedent), clamp ≤100 | consistency; cursor drift avoided via stable `createdAt,id` tie-breaker             |
| Validation    | hand-rolled strict shapes                       | no zod; codebase style                                                              |

### Quick Wins

- Copy `bootstrap.js` `mintSetupToken`/`consumeSetupToken` shape verbatim (length-check + `timingSafeEqual`, tx consume) — [research-external.md](./research-external.md) code examples.
- Reuse `tenancyHarness.js` fixtures for every isolation test.

### Future Enhancements

- **Advisory — invite quota per workspace/inviter**: bound spam; follow-up (deferral: rate limiter blunts abuse for v1.1.0).
- **Advisory — rotate-on-recreate + editable expiry presets**: token hygiene; follow-up after YAN-373 feedback.
- **Advisory — expiry janitor**: unnecessary — lazy expiry on read is correct.
- **Advisory — invite email delivery / resend / bulk / SCIM**: M5+, explicitly out of scope.
- **Advisory — SSO fresh re-auth challenge (`prompt=login`/ForceAuthn)**: needed before SSO-only owners can transfer; fail-closed until then (follow-up issue).

## Risk Assessment

### Technical Risks

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration version collision (012 claimed by YAN-365 or another lane) | Med        | Med    | re-check registry on rebase; additive idempotent migration; no invite writes while switch off                                                                    |
| Guard ordering leaks 401/403 before 404 while off                    | Med        | High   | `multiUserOnly` flag checked in `dashboardGuard` before auth; handler repeats `requireMultiUser()`; test real HTTP, anonymous + authenticated, both latch states |
| Invite race / partial account across tables                          | Med        | High   | single sync transaction; conditional consume (`changes === 1`); rollback leaves token unconsumed; concurrency tests                                              |
| Stale actor authority (cached principal outlives demotion/disable)   | Med        | Med    | re-read actor/target/membership inside every mutation tx; drop caches after commit                                                                               |
| Deletion misses non-FK storage (`ws:<id>/` kv)                       | Med        | Med    | explicit bounded prefix cleanup; cascade fixture test per resource class                                                                                         |
| `bcryptjs` CPU cost on public accept                                 | Low        | Med    | async only (never `*Sync` on request path); IP + token-hash limiter                                                                                              |
| sql.js debounced persistence ≠ fsync on HTTP ack                     | Low        | Low    | atomic tx still gives single-use/race safety in supported process model; no durability claims                                                                    |

### Integration Challenges

- **ROUTE_POLICY coverage**: unmapped route/method fails route-policy test — map every path/method; static (ownership-transfer, accept) before dynamic (`[id]`) routes; keep file import-free.
- **Proxy bundle**: no oidc/saml provider imports into proxy-loaded modules — SSO linking stays at `resolveSsoUser`-level API.
- **YAN-365 seam**: no `workspaceKeys`/DEK code now; deletion leaves a tested cascade contract for that issue; no cryptographic-erasure claims (backups with wrapped DEKs stay decryptable — ADR-0008 scope clarification belongs to YAN-365).
- **Legacy key storage**: `revokeUserApiKeysSync` no-ops while storage is `legacy` — disable path must also tombstone legacy rows (C-E).

### Security Considerations

Full threat model and 24-case test matrix: [research-security.md](./research-security.md).

#### Critical — Hard Stops

| Finding                                                               | Risk                                             | Required Mitigation                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invite token stored/returned raw after creation (S-1)                 | DB/backup/log leak = account creation            | store SHA-256 hex only; raw token in create response exactly once; never in list/detail/audit/log                                                                                 |
| Invite replay / double-accept race (S-2)                              | duplicate accounts / escalation                  | consume-then-create in one DB transaction; conditional update, `changes === 1`; parallel accepts → one winner                                                                     |
| Privilege escalation via role fields (S-3, gap C-A/C-B)               | member invites owner/admin; admin escalates peer | invite body carries role allow-list only, no instance-role field; live capability + exact-workspace checks in tx; `instanceRole`/`status` allow-lists; hierarchy owner>admin>user |
| SSO accept links by email (S-4)                                       | email takeover claims invite                     | link only by `(provider, issuer, subject)`; email binding compares verified IdP email, informational only                                                                         |
| Ownership transfer without fresh re-auth (S-5, gap C-D)               | stolen session transfers instance                | password re-verify in same request + limiter + dummy hash; SSO-only owners fail closed; never trust JWT `amr`/session alone                                                       |
| Disable leaves sessions or keys alive (S-6, gap C-E)                  | former user keeps gateway access                 | one tx: status + `sv` bump + revoke all user keys (incl. legacy rows) + drop cache; enable never restores                                                                         |
| List/detail leaks hashes/secrets — one-api#2425 repeat (S-7, gap C-F) | escalation from admin list                       | fixed `COLS`/DTO allow-lists; no `SELECT *`; no-secrets assertion tests on every list/error/audit output                                                                          |
| Switch-off exposure (S-8)                                             | new routes reachable while off                   | guard-level 404 before auth + `requireMultiUser()` per handler; single-user regression suite                                                                                      |
| Deletion cascade wrong direction (S-18, gap C-C)                      | shared data lost / personal data survives        | verified FK matrix + explicit kv/keys cleanup + last-manager guard, all in one tx                                                                                                 |

#### Warnings — Must Address

| Finding                                                              | Risk                        | Mitigation                                                                                                                           | Alternatives                        |
| -------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `timingSafeEqual` throws on length mismatch                          | 500 oracle                  | length-check first (bootstrap.js:78 precedent)                                                                                       | none — fixed pattern                |
| Accept-endpoint enumeration (distinct errors/timing per token state) | invite harvesting           | one generic `invite_invalid` after same-cost work; dummy-hash cover; IP + token-hash rate buckets                                    | per-state errors (rejected)         |
| Email binding bypass via case/whitespace                             | bound invite claimed        | normalize trim+lowercase at create and accept                                                                                        | —                                   |
| Expiry TOCTOU / revoked-still-usable                                 | stale token accepted        | expiry + `revokedAt` predicates inside consume tx                                                                                    | —                                   |
| CSRF on cookie-authed mutations                                      | forged state change         | `isCrossSite` + `isJson` on every mutation (form POST cannot set JSON content-type; no-Origin requests pass `isCrossSite` by design) | —                                   |
| Session cache staleness after disable/role change                    | ≤5 s zombie session         | drop cache in-process on every bump; document cross-process bound                                                                    | sessions table (rejected, ADR-0004) |
| IdP-sourced rows mutated by manual APIs                              | SSO sync clobbered          | 409 `idp_managed`; sync owns its rows                                                                                                | provenance conversion (follow-up)   |
| Owner demoted/deleted via PATCH                                      | instance theft              | repo `OWNER_IMMUTABLE` on every role/status path; transfer is the only owner change                                                  | —                                   |
| Last-manager race bricks workspace                                   | orphaned workspace          | `assertNotLastManager` inside same tx; concurrent pair → one `LAST_MANAGER` failure                                                  | —                                   |
| Pagination DoS                                                       | unbounded dumps             | clamp pageSize ≤100 (auditRepo pattern)                                                                                              | —                                   |
| Accept creates second user while `requireLogin=false`                | single-user invariant break | respect `SINGLE_USER_MODE` refusal semantics (switch-on path only)                                                                   | —                                   |

#### Advisories — Best Practices

- **Audit rows capture secrets**: deltas carry ids/roles/status/workspace only; `ALLOWED` list gains `inviteId`; test persisted events, not just HTTP (deferral: none — enforce now, cheap).
- **Weak invitee password**: reuse `validateNewPassword` + async bcrypt cost 10; reject default/oversize passwords.
- **Personal workspace confusion**: reject with `PERSONAL_WORKSPACE` on all multi-member operations, admin calls included.
- **In-memory limiter eviction**: attacker flooding random identifiers can evict victims' lock entries — accept route gets its own bounded token-hash + IP buckets.

## Task Breakdown Preview

### Phase 1: Persistence and Invariants

**Focus**: invitations storage + repo/user/membership hardening.
**Tasks**:

- Migration 012 + schema.js + tenancy classification + registry (re-check version on rebase).
- `invitationsRepo.js` (mint/list/revoke + sync consume seam); usersRepo pagination, role/status allow-lists, hierarchy, legacy-key tombstone, kv cleanup; memberships capability/source/active-manager hardening.
  **Parallelization**: repo lanes independent once DTO/invariant contracts frozen.

### Phase 2: Guard, Routes, Audit

**Focus**: switch-correct 404s + management endpoints.
**Dependencies**: Phase 1 seams.
**Tasks**:

- `routePolicy.js` rows + `multiUserOnly` flag; `dashboardGuard` early-hide check; `requireMultiUser()` in handlers.
- Users list/PATCH/DELETE, members CRUD, invitations create/list/revoke routes; `userManagement.js` helper; audit events (`instance.users.*`, `invitation.create/revoke`).

### Phase 3: Acceptance and Transfer

**Focus**: public accept + ownership re-auth.
**Dependencies**: Phases 1–2.
**Tasks**:

- Password/existing-user accept (`invitations.js`), rate limiting, generic failures.
- SSO intent carry through OIDC/SAML state; verified-triple linking; conflict semantics.
- `ownershipTransfer.js` re-auth + route; SSO-only fail-closed error.

### Critical test matrix (only these; via `npm test` / `npx vitest run -c tests/vitest.config.js`)

- Accept: happy (password + SSO), expiry boundary, reuse, revoke, double-accept race.
- Isolation: cross-workspace manager denial; role escalation (`instanceRole`/owner in body); personal-workspace invite.
- Lifecycle: disable revokes sessions + all keys (enable resurrects nothing); deletion cascade (personal gone incl. kv, shared + service keys + audit survive, creator NULL); last-manager; owner immutability.
- Transfer: wrong password 401 no-write; right password swaps atomically, both `sv` bumped.
- Hygiene: no-secrets assertions on lists/logs/audit; switch-off 404 for every new route (both latch states); IdP rows untouched by manual APIs.

## Decisions

Settled by maintainer; implementation treats these as binding.

1. **Invite token**: `crypto.randomBytes(32)` base64url, stored as plain SHA-256 hex, `timingSafeEqual` after length check, consumed in one DB transaction (bootstrap.js pattern). Not HMAC — 256-bit entropy makes keyed hashing unnecessary and avoids master-key coupling.
2. **Storage**: dedicated `invitations` table in the next migration (currently 012; re-check on rebase), classified in the tenancy guard. Columns: id, workspaceId (FK cascade), role, email (nullable, trim+lowercase), tokenHash unique, createdByUserId (FK SET NULL), createdAt, expiresAt (7 days), consumedAt, consumedByUserId, revokedAt.
3. **Invite roles**: manager/member/viewer only, shared workspaces only; manager-grant needs workspace owner or instance admin. No owner, no instance-role field. Personal workspace → `PERSONAL_WORKSPACE`.
4. **Inviting authority**: workspace owner/manager for that workspace; instance admin/owner for any shared workspace via `instance.users.manage`. Membership routes stay caller-managed-workspace scoped (admins via `instance.users.manage`, consistent with invites).
5. **Acceptance**: public `POST /api/invitations/accept` (switch-gated, same-origin + JSON, IP + token-bucket rate limited, single generic `invite_invalid`, no-store). Password path creates approved `user` (never pending/admin) with personal workspace + `source='invite'` membership atomically; bcrypt before the sync transaction. Authenticated users may accept (membership only). Email-bound invites match account/verified IdP email; email never links identities.
6. **SSO acceptance**: invite proof through server-controlled OIDC/SAML state; link only by `(provider, issuer, subject)`; invitee becomes approved `user`; allow-group check still applies; membership conflict (any source incl. idp) → explicit conflict error, never overwrite.
7. **Admin hierarchy**: matches temporary-password route — owner acts on admins+users, admins on user/pending; only owner grants/demotes admin; owner changes only via transfer; allow-list `instanceRole` {admin,user,pending}, `status` {active,disabled}.
8. **Disable**: status + `sv` bump + revoke all user-owned keys (incl. legacy-format) in one transaction; drop session cache; enable never resurrects keys; last-active-manager disable refused.
9. **Transfer**: `POST /api/users/ownership-transfer` with current password re-verified in the same request (limiter + dummy hash). SSO-only owners fail closed with clear error (follow-up issue); existing session never accepted as proof.
10. **Deletion**: rely on verified FK cascades (004/005/008/009, schema.js) for personal rows/memberships and SET NULL creators; service keys (`userId NULL`) survive. Add explicit personal `ws:<id>/` kv cleanup, all-workspace user-key revocation/deletion, shared last-manager guard; invites survive issuance (createdBy SET NULL). DEK destruction deferred to YAN-365 — no placeholder code.
11. **Membership APIs**: role allow-list {manager,member,viewer} for managers; server forces source (`manual`/`invite`); `idp` rows read-only to manual APIs; last owner/manager guard in-transaction; removal revokes that user's keys in that workspace only.
12. **User list**: page/pageSize clamped ≤100, stable ordering, explicit `COLS` projection; no hashes/tokens/keys in responses, logs, or audit.
13. **Audit**: reuse merged YAN-367 `audit()`; add `invitation.create/revoke/accept` + `instance.users.*`; never duplicate membership/transfer repo events.
14. **Scope exclusions**: no email delivery, no UI (M5/YAN-373), no new dependencies.

## Decisions Needed

Remaining coordination items (non-blocking; resolved at integration):

1. **Migration number** — Options: 012, next-free-on-rebase. Impact: registry ordering. Recommendation: claim next free at rebase; additive/idempotent either way.
2. **YAN-365 DEK contract** — Options: pre-coordinate deletion seam vs leave tested cascade contract. Recommendation: leave contract; revisit if maintainer makes cryptographic erasure an acceptance criterion.
3. **SSO fresh re-auth mechanism** — follow-up issue for SSO-only owners; fail-closed ships first.

## Research References

- [research-external.md](./research-external.md): External API details, crypto patterns, code examples.
- [research-business.md](./research-business.md): Business logic, domain model, workflows, success criteria.
- [research-technical.md](./research-technical.md): Architecture, data models, API design, lanes, constraints.
- [research-ux.md](./research-ux.md): API-level UX contract, error codes, future UI affordances.
- [research-security.md](./research-security.md): Threat model, severity-leveled findings, code gaps, 24-case test matrix.
- [research-practices.md](./research-practices.md): Codebase patterns, reuse map, KISS recommendations.
- [research-recommendations.md](./research-recommendations.md): Full recommendations, risk table, validation path.
