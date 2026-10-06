# Plan: YAN-360 — Invitations, Admin User Lifecycle and Workspace Membership APIs

## Summary

Server-only invitations, admin user lifecycle, workspace membership APIs. 13 new switch-gated routes; single-use hashed tokens; atomic accept; password re-auth ownership transfer. No UI, no email, no new deps.

## User Story

As instance admin, I want invite/manage users/memberships via server APIs, so onboarding needs no shared credential.

## Problem → Solution

No invite/lifecycle/membership APIs → thin routes + repos + one invitations repo/service, switch-gated 404 while off.

## Metadata

- **Complexity**: Large
- **Source PRD**: docs/plans/yan-360-invitations/feature-spec.md
- **PRD Phase**: N/A
- **Estimated Files**: ~25

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently; batches run in order.

| Batch | Tasks                   | Depends On | Parallel Width |
| ----- | ----------------------- | ---------- | -------------- |
| B1    | 1.1, 1.2, 1.3, 1.4, 2.1 | —          | 5              |
| B2    | 1.5, 4.1                | B1         | 2              |
| B3    | 3.1, 3.2, 4.2, 5.1      | B2         | 4              |
| B4    | 5.2                     | B3         | 1              |
| B5    | 6.1, 6.2                | B4         | 2              |

- **Total tasks**: 14
- **Total batches**: 5
- **Max parallel width**: 5

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-users-invitations (branch: users/yan-360-invitations)

## UX Design

N/A — internal change. Server APIs only; UI is YAN-373.

### Interaction Changes

| Touchpoint        | Before        | After                  | Notes            |
| ----------------- | ------------- | ---------------------- | ---------------- |
| 13 new API routes | 404/undefined | switch-gated JSON APIs | UI lands YAN-373 |

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                  | Lines     | Why                                |
| -------------- | ----------------------------------------------------- | --------- | ---------------------------------- |
| P0 (critical)  | `docs/plans/yan-360-invitations/feature-spec.md`      | all       | source of truth; Decisions binding |
| P0 (critical)  | `src/lib/users/bootstrap.js`                          | all       | setup token mint/consume pattern   |
| P0 (critical)  | `src/lib/users/featureSwitch.js`                      | all       | requireMultiUser guard             |
| P0 (critical)  | `src/lib/db/repos/usersRepo.js`                       | all       | COLS, updateUserUnscoped, delete   |
| P0 (critical)  | `src/lib/db/repos/membershipsRepo.js`                 | all       | assertNotLastManager               |
| P0 (critical)  | `src/lib/auth/routePolicy.js`                         | all       | multiUserOnly rows                 |
| P1 (important) | `src/app/api/auth/setup-token/route.js`               | all       | requireMultiUser handler shape     |
| P1 (important) | `src/app/api/users/[id]/password/route.js`            | all       | sameOrigin, no-store, hierarchy    |
| P1 (important) | `src/lib/users/audit.js`                              | all       | ALLOWED events                     |
| P1 (important) | `src/lib/db/migrations/011-sso-role-source.js`        | all       | latest migration pattern           |
| P1 (important) | `tests/setup/tenancyHarness.js`                       | all       | test fixtures                      |
| P2 (reference) | `src/dashboardGuard.js`                               | all       | guard ordering                     |
| P2 (reference) | `docs/plans/yan-360-invitations/research-security.md` | as needed | supporting detail                  |

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### TOKEN_MINT (invitation tokens)

```js
// SOURCE: src/lib/users/bootstrap.js:38,51-53
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();
const token = crypto.randomBytes(32).toString("base64url");
const expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
```

### TOKEN_CONSUME (single-use, timing-safe)

```js
// SOURCE: src/lib/users/bootstrap.js:70-82
const stored = Buffer.from(hash, "hex");
if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) return false;
db.run(`UPDATE _meta SET value = '' WHERE key IN (?, ?)`, [TOKEN_HASH, TOKEN_EXPIRES]);
return true; // inside db.transaction; conditional consume, changes === 1
```

### COLS_PROJECTION (no SELECT *, safe DTO)

```js
// SOURCE: src/lib/db/repos/usersRepo.js:17-19
const COLS =
  "id, email, username, displayName, instanceRole, status, sessionVersion, mustChangePassword, createdAt, updatedAt, lastLoginAt";
// instanceRoleSource (YAN-359) is internal: read it explicitly, never via COLS.
```

### OWNER_IMMUTABLE (repo-level hard stop)

```js
// SOURCE: src/lib/db/repos/usersRepo.js:292-295
if (next.instanceRole !== undefined && next.instanceRole !== row.instanceRole) {
  if (row.instanceRole === "owner" || next.instanceRole === "owner") {
    throw new TenancyError("OWNER_IMMUTABLE", "Ownership changes only by transfer");
  }
}
```

### DELETE_CASCADE_SHAPE (guards first, one tx)

```js
// SOURCE: src/lib/db/repos/usersRepo.js:324-339
const row = requireRow(db, id);
if (row.instanceRole === "owner") throw new TenancyError("OWNER_IMMUTABLE", "…");
for (const { workspaceId } of shared) assertNotLastManager(db, workspaceId, id);
db.run(`DELETE FROM workspaces WHERE createdBy = ? AND kind = 'personal'`, [id]);
dropSession(id);
return db.run(`DELETE FROM users WHERE id = ?`, [id]).changes > 0;
```

### TRANSFER_OWNERSHIP (demote-before-promote, dual sv bump)

```js
// SOURCE: src/lib/db/repos/usersRepo.js:412-416
const sql = `UPDATE users SET instanceRole = ?, instanceRoleSource = NULL, updatedAt = ?, sessionVersion = sessionVersion + 1 WHERE id = ?`;
db.run(sql, ["admin", now, from.id]); // demote first: idx_users_owner allows one owner
db.run(sql, ["owner", now, to.id]);
dropSession(from.id, to.id);
```

### CREATE_USER_SYNC (sync seam inside caller-owned tx)

```js
// SOURCE: src/lib/db/repos/usersRepo.js:210-248
export function createUserWithPersonalWorkspaceSync(db, { email, instanceRole = "pending", passwordHash } = {}) {
  db.run(`INSERT INTO users(id, email, …) VALUES(?, ?, …)`, [id, optText(email), …]);
  db.run(`INSERT INTO workspaces(id, name, kind, createdBy, …) VALUES(?, ?, 'personal', ?, …)`, …);
  db.run(`INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'owner', 'manual', ?)`, …);
}
```

### LAST_MANAGER_GUARD (in-transaction)

```js
// SOURCE: src/lib/db/repos/membershipsRepo.js:23-33
const { c } = db.get(
  `SELECT COUNT(*) AS c FROM memberships WHERE workspaceId = ? AND role IN ('owner', 'manager') AND userId != ?`,
  [workspaceId, userId],
);
if (c === 0)
  throw new TenancyError("LAST_MANAGER", "A workspace needs at least one owner or manager");
```

### LEGACY_KEY_TOMBSTONE_GAP

```js
// SOURCE: src/lib/db/repos/apiKeysRepo.js:317-327
export function revokeUserApiKeysSync(db, userId, { workspaceId = null, now = … } = {}) {
  if (state.storage === "legacy") return 0; // WARNING: disable path must also tombstone legacy rows
  db.run(`UPDATE apiKeys SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL ${scope}`, params);
}
```

### HANDLER_GUARD_ORDER (route shape)

```js
// SOURCE: src/app/api/users/[id]/password/route.js:22-33
if (!(await isUserSecurityEnforced())) return json({ error: "Not found" }, 404); // → requireMultiUser() instead
if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
if (!isJson(request))
  return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
const principal = await getPrincipal();
const denied = await authorize("instance.users.manage");
```

### NO_STORE_HEADERS

```js
// SOURCE: src/app/api/users/[id]/password/route.js:11-12
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
```

### HIERARCHY_CHECK (admin acts only on user/pending)

```js
// SOURCE: src/app/api/users/[id]/password/route.js:16-20
function mayReset(actorRole, target) {
  if (target.instanceRole === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && ["user", "pending"].includes(target.instanceRole);
}
```

### ROUTE_POLICY_ROW (import-free map)

```js
// SOURCE: src/lib/auth/routePolicy.js:52
"/api/auth/setup-token": { cap: "instance.ownership.transfer", localOnly: true },
// new rows gain multiUserOnly: true; static paths before dynamic [id]
```

### GUARD_ORDER (404 before auth checks)

```js
// SOURCE: src/dashboardGuard.js:141-160 (checkApiPolicy)
if (policy.localOnly && !(await canAccessLocalOnlyRoute(request, policy.cliAllowed))) return 403;
if (policy.public) return null;
// multiUserOnly check must run FIRST, before localOnly/auth, so 401/403 never leak
```

### MIGRATION_SHAPE (idempotent)

```js
// SOURCE: src/lib/db/migrations/011-sso-role-source.js
export default {
  version: 11,
  name: "sso-role-source",
  up(db) {
    if (!tableHasColumn(db, "users", "instanceRoleSource")) {
      db.exec(`ALTER TABLE …`);
    }
  },
};
// registry: src/lib/db/migrations/index.js:25-28 appends + sorts by version
```

### TENANCY_CLASSIFICATION

```js
// SOURCE: src/lib/db/tenancy.js:41-43
identities: { class: "scoped", scopeColumn: "userId" },
memberships: { class: "scoped", scopeColumn: "workspaceId" },
// invitations: { class: "scoped", scopeColumn: "workspaceId" }
```

### TEST_HARNESS

```js
// SOURCE: tests/setup/tenancyHarness.js:25-74
const { a, b, shared } = await seedTenancy(); // owner a, user b, shared workspace
const res = await callRoute(POST, "/api/x", { as: a, method: "POST", body, params });
const ok = await denied(() => repoCall()); // null/false/NOT_FOUND/FORBIDDEN
```

---

## Files to Change

| File                                                          | Action | Justification                                                                                  |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `src/lib/db/migrations/012-invitations.js`                    | CREATE | invitations table (re-check version on rebase)                                                 |
| `src/lib/db/migrations/index.js`                              | UPDATE | registry entry                                                                                 |
| `src/lib/db/schema.js`                                        | UPDATE | table DDL mirror                                                                               |
| `src/lib/db/tenancy.js`                                       | UPDATE | scoped classification by workspaceId                                                           |
| `src/lib/db/repos/invitationsRepo.js`                         | CREATE | create/list/revoke + sync consume seam                                                         |
| `src/lib/db/repos/usersRepo.js`                               | UPDATE | paginated list, role/status allow-lists, hierarchy, legacy-key tombstone, kv cleanup on delete |
| `src/lib/db/repos/membershipsRepo.js`                         | UPDATE | role allow-list, server-forced source, idp read-only, manager authority, active-manager guard  |
| `src/lib/db/index.js`                                         | UPDATE | export invitationsRepo surface                                                                 |
| `src/lib/users/invitations.js`                                | CREATE | accept orchestration (password/existing-user/SSO)                                              |
| `src/lib/users/userManagement.js`                             | CREATE | mgmt auth helper (capability + exact-workspace)                                                |
| `src/lib/users/ownershipTransfer.js`                          | CREATE | password re-auth proof                                                                         |
| `src/lib/users/audit.js`                                      | UPDATE | ALLOWED gains `inviteId`                                                                       |
| `src/lib/auth/routePolicy.js`                                 | UPDATE | 13 rows + `multiUserOnly` flag (integration lane)                                              |
| `src/dashboardGuard.js`                                       | UPDATE | `multiUserOnly` 404 before auth (integration lane)                                             |
| `src/app/api/users/route.js`                                  | CREATE | GET list                                                                                       |
| `src/app/api/users/[id]/route.js`                             | CREATE | PATCH/DELETE                                                                                   |
| `src/app/api/users/ownership-transfer/route.js`               | CREATE | POST                                                                                           |
| `src/app/api/workspaces/[id]/members/route.js`                | CREATE | GET/POST                                                                                       |
| `src/app/api/workspaces/[id]/members/[userId]/route.js`       | CREATE | PATCH/DELETE                                                                                   |
| `src/app/api/workspaces/[id]/invitations/route.js`            | CREATE | GET/POST                                                                                       |
| `src/app/api/workspaces/[id]/invitations/[inviteId]/route.js` | CREATE | DELETE                                                                                         |
| `src/app/api/invitations/accept/route.js`                     | CREATE | POST public accept                                                                             |
| `src/app/api/auth/oidc/start/route.js`, `callback/route.js`   | UPDATE | invite-intent state binding                                                                    |
| `src/app/api/auth/saml/start/route.js`, `acs/route.js`        | UPDATE | invite-intent state binding                                                                    |
| `tests/unit/invitations.test.js`                              | CREATE | accept matrix                                                                                  |
| `tests/unit/user-lifecycle.test.js`                           | CREATE | lifecycle matrix                                                                               |
| `tests/unit/membership-management.test.js`                    | CREATE | membership matrix                                                                              |
| `tests/unit/ownership-transfer.test.js`                       | CREATE | transfer matrix                                                                                |

## NOT Building

- No UI (YAN-373).
- No email delivery (token returned once, relayed out-of-band).
- No encryption/DEK destruction (YAN-365); no placeholder code.
- No SSO-only owner transfer (fails closed, follow-up issue).
- No new dependencies; no zod (hand-rolled strict validation).
- No expiry janitor (lazy expiry on read).

---

## Step-by-Step Tasks

Lanes with non-overlapping file ownership: **A** persistence (1.x), **E** integration owner (2.1), **B** invitations (3.x), **C** lifecycle/membership (4.x), **D** SSO + transfer (5.x), tests last (6.x). All route handlers call `requireMultiUser()` first and return its 404; guard-level hiding is lane E's `multiUserOnly` flag. Every mutation: `isCrossSite` + `isJson`, `Cache-Control: no-store`; invitation responses add `Referrer-Policy: no-referrer`. Strict body shapes: reject unknown keys, oversize fields, caller-supplied `source`/expiry/`sessionVersion`.

### Task 1.1: Migration 012 + schema + tenancy classification — Depends on [none]

- **BATCH**: B1 (Lane A)
- **ACTION**: Create `src/lib/db/migrations/012-invitations.js` (idempotent, `version: 12, name: "invitations"`); register in `src/lib/db/migrations/index.js`; mirror DDL in `src/lib/db/schema.js`; add `invitations: { class: "scoped", scopeColumn: "workspaceId" }` to `src/lib/db/tenancy.js`.
- **IMPLEMENT**: Columns per spec Decisions #2: id TEXT PK, workspaceId FK workspaces ON DELETE CASCADE, role CHECK IN (manager,member,viewer), email TEXT nullable, tokenHash TEXT NOT NULL UNIQUE, createdByUserId FK users ON DELETE SET NULL, createdAt/expiresAt NOT NULL, consumedAt/consumedByUserId (FK SET NULL)/revokedAt nullable. Index `(workspaceId, createdAt, id)`. Re-check 012 is next-free on rebase (YAN-365 collision risk).
- **MIRROR**: MIGRATION_SHAPE (011 + registry index.js:25-28), TENANCY_CLASSIFICATION.
- **GOTCHA**: No mutable status column — derived state from timestamps. Migration runs with FKs off (registry contract); ordering handled by sort.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/migration*` if present; table-classification test green; app boots.

### Task 1.2: usersRepo hardening — Depends on [none]

- **BATCH**: B1 (Lane A)
- **ACTION**: Update `src/lib/db/repos/usersRepo.js`: paginated safe reader, `instanceRole`/`status` allow-lists + hierarchy in `updateUserUnscoped`, legacy-key tombstone on disable, delete-time `ws:<id>/` kv cleanup + all-workspace key revocation.
- **IMPLEMENT**: Add `listUsersPageUnscoped({ page, pageSize })` with SQL LIMIT/OFFSET, `pageSize` clamped 1–100, stable `ORDER BY createdAt, id`, `COLS` projection minus `sessionVersion`/`instanceRoleSource` for the DTO. In `updateUserUnscoped` allow-list `instanceRole` ∈ {admin,user,pending} and `status` ∈ {active,disabled}; on `status→disabled` one tx: flip + `sessionVersion` bump + `revokeUserApiKeysSync` AND legacy-row tombstone (`UPDATE apiKeys SET revokedAt … WHERE userId = ?` regardless of storage state, or delete rows — match hashed-repo semantics) + refuse when target is last active manager of a shared workspace. In `deleteUserUnscoped`: revoke/delete user keys everywhere (incl. legacy) then bounded `DELETE FROM kv WHERE substr(key, 1, ?) = ?` with `ws:<personalId>/` prefix (escaped equality, never unescaped LIKE) before dropping the user.
- **MIRROR**: COLS_PROJECTION, DELETE_CASCADE_SHAPE, OWNER_IMMUTABLE, LEGACY_KEY_TOMBSTONE_GAP (substr precedent: `src/lib/db/repos/disabledModelsRepo.js:27`).
- **GOTCHA**: Keep usersRepo ≤500 lines — move cascade helper to small lifecycle helpers in `src/lib/db/repos/ownership.js` if needed. Enable never resurrects keys. Owner stays `OWNER_IMMUTABLE` everywhere.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/` for existing users/tenancy suites; no regressions.

### Task 1.3: membershipsRepo hardening — Depends on [none]

- **BATCH**: B1 (Lane A)
- **ACTION**: Update `src/lib/db/repos/membershipsRepo.js`: role allow-list {manager,member,viewer}, server-forced `source`, `source='idp'` rows read-only to manual mutators, active-manager last-guard count.
- **IMPLEMENT**: `addMembership`/update/remove validate role against the allow-list and reject `source='idp'` rows on manual paths (TenancyError `idp_managed`); callers can't set `source` for manual APIs (server forces `manual`). `assertNotLastManager` counts only **active** members (join users, `status='active'`) so disabling the last active manager is refused. Manager-authority seam: a `mayManage(role)` helper exported for handlers (owner/manager may manage; only workspace owner/instance admin grants `manager`).
- **MIRROR**: LAST_MANAGER_GUARD, `syncIdpMembershipsSync` (membershipsRepo.js:44-98) for idp-row semantics.
- **GOTCHA**: Public mutators currently check membership not capability — handler re-check required (4.x); repo seam only enforces data invariants.
- **VALIDATE**: Existing membership/tenancy suites green via `npx vitest run -c tests/vitest.config.js`.

### Task 1.4: audit ALLOWED gains inviteId — Depends on [none]

- **BATCH**: B1 (Lane A)
- **ACTION**: Update `src/lib/users/audit.js`: add `inviteId` to `ALLOWED`; nothing else.
- **IMPLEMENT**: One-line set addition so invitation audit deltas (ids/roles/status/workspace only, never token/hash) persist; `instanceRole` maps to existing `role` key.
- **MIRROR**: `src/lib/users/audit.js:7-22` ALLOWED set.
- **GOTCHA**: Never add token/tokenHash to ALLOWED; audit fires after commit only.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/audit*` green.

### Task 2.1: Route policy rows + multiUserOnly guard flag — Depends on [none]

- **BATCH**: B1 (Lane E)
- **ACTION**: Update `src/lib/auth/routePolicy.js`: add `multiUserOnly: true` flag support + one row per new route/method (13 routes: users GET; users/[id] PATCH+DELETE; ownership-transfer POST; workspaces/[id]/members GET+POST; members/[userId] PATCH+DELETE; invitations GET+POST; invitations/[inviteId] DELETE; invitations/accept POST). Update `src/dashboardGuard.js` `checkApiPolicy` to return 404 for `multiUserOnly` routes while the switch is off — checked FIRST, before localOnly/auth/local checks.
- **IMPLEMENT**: Keep routePolicy.js import-free; static paths before dynamic `[id]`. Dashboard guard: `if (policy.multiUserOnly && !(await isMultiUserEnabled())) return 404` at the top of `checkApiPolicy`. Accept route is `public` + `multiUserOnly` (token is authorization, not session).
- **MIRROR**: ROUTE_POLICY_ROW, GUARD_ORDER.
- **GOTCHA**: Route-policy test fails on unmapped route/method — cover every method each new route file exports. 404 body identical to `requireMultiUser()` output.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js` route-policy + guard suites green.

### Task 1.5: invitationsRepo — Depends on [1.1]

- **BATCH**: B2 (Lane A)
- **ACTION**: Create `src/lib/db/repos/invitationsRepo.js`: `createInvitationUnscoped` (mint: randomBytes(32) base64url, SHA-256 hex storage, expiresAt = now + 7d), `listInvitations(ctx)` (scoped, metadata only — no token/hash), `revokeInvitation` (idempotent on terminal rows), `consumeInvitationSync(db, …)` sync seam for caller-owned transactions. Export from `src/lib/db/index.js`.
- **IMPLEMENT**: Consume seam re-reads inside the caller's tx: `UPDATE invitations SET consumedAt = ?, consumedByUserId = ? WHERE id = ? AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > ?` with `changes === 1` as the single-winner gate. Lookup by unique `tokenHash`; `timingSafeEqual` after length check. Email normalized trim+lowercase at create.
- **MIRROR**: TOKEN_MINT, TOKEN_CONSUME, CREATE_USER_SYNC (sync-seam shape), COLS_PROJECTION.
- **GOTCHA**: Raw token never stored or listed; workspaceId/role/email immutable after issuance. `ctx` first on scoped fns, `Unscoped` suffix otherwise (repo convention).
- **VALIDATE**: Focused vitest run on new repo via a scratch assertion in task 6.1; schema loads, unique tokenHash enforced.

### Task 4.1: userManagement helper + admin user routes (GET/PATCH/DELETE) — Depends on [1.2, 2.1]

- **BATCH**: B2 (Lane C)
- **ACTION**: Create `src/lib/users/userManagement.js` (live-capability + exact-workspace verification helper); create `src/app/api/users/route.js` (GET list) and `src/app/api/users/[id]/route.js` (PATCH/DELETE).
- **IMPLEMENT**: Helper exports `requireUserManager(principal)` (`instance.users.manage` live check) and `requireWorkspaceManager(principal, workspaceId)` (exact-URL membership role owner/manager OR instance admin/owner; non-member → NOT_FOUND-priced error). GET: `page`/`pageSize` clamp ≤100, `listUsersPageUnscoped`, safe DTO. PATCH: exactly one of approve/`instanceRole`/`status`, allow-lists, hierarchy `mayReset`-shaped (`owner`: anyone; `admin`: user/pending; only owner grants/demotes admin; never self), owner row → `OWNER_IMMUTABLE`. DELETE: owner undeletable; shared last-manager guard; one tx.
- **MIRROR**: HANDLER_GUARD_ORDER, HIERARCHY_CHECK, NO_STORE_HEADERS.
- **GOTCHA**: Approve means `instanceRole: pending → user`, not status. `params`/`cookies()` awaited.
- **VALIDATE**: Manual `curl` against dev with switch on; 404 with switch off; focused tests in 6.x cover the matrix.

### Task 3.1: Invitation management routes — Depends on [1.5, 2.1, 4.1]

- **BATCH**: B3 (Lane B)
- **ACTION**: Create `src/app/api/workspaces/[id]/invitations/route.js` (GET/POST) and `src/app/api/workspaces/[id]/invitations/[inviteId]/route.js` (DELETE).
- **IMPLEMENT**: Both start `requireMultiUser()` → `isCrossSite`/`isJson` → workspace-manager authority (`requireWorkspaceManager`). POST: strict `{role, email?}` (role allow-list; `manager` needs workspace owner or instance admin); shared workspace only (personal → `PERSONAL_WORKSPACE`); email normalized. Response 201: metadata + raw `token` exactly once. GET: metadata only + derived state (live/expired/consumed/revoked). DELETE: revoke; terminal already → idempotent success; revoke never unconsumes. Audit `invitation.create`/`invitation.revoke` after commit.
- **MIRROR**: HANDLER_GUARD_ORDER, TOKEN_MINT, NO_STORE_HEADERS + `Referrer-Policy: no-referrer`.
- **GOTCHA**: Raw token never in URL/query; never in list/detail/audit/log.
- **VALIDATE**: Tests in 6.x; switch-off 404 anonymous + authenticated.

### Task 3.2: Accept service + public accept route (password + existing-user) — Depends on [1.5, 1.2]

- **BATCH**: B3 (Lane B)
- **ACTION**: Create `src/lib/users/invitations.js` (accept orchestration) and `src/app/api/invitations/accept/route.js`.
- **IMPLEMENT**: Route: `requireMultiUser()` → same-origin/JSON → dedicated rate limit (IP + token-hash buckets, bounded like `loginLimiter`) → strict token shape (43-char base64url) → hash + indexed lookup with dummy-work cover → bcrypt hash password BEFORE sync tx (password path). Service: single sync tx — re-read invite (`consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`, boundary `now >= expiresAt` rejects), email binding (normalized match), workspace shared+existing, identifier uniqueness → `createUserWithPersonalWorkspaceSync`-style create (approved `user`, never pending/admin) + personal workspace + password identity + membership `source='invite'` → conditional consume (`changes === 1`). Session path: uses live session subject only; disabled/pending get generic failure; membership only, never touch password. All failures → one generic 400 `invite_invalid`. Response: safe receipt, no auto-login.
- **MIRROR**: TOKEN_CONSUME, CREATE_USER_SYNC (hash-before-tx), HANDLER_GUARD_ORDER.
- **GOTCHA**: Username/email collision inside tx fails closed, token unconsumed. Respect `SINGLE_USER_MODE` refusal on switch-on path (S-401 advisory: accept while `requireLogin=false` must respect single-user refusal semantics).
- **VALIDATE**: Race test (parallel accepts → one winner) in 6.x.

### Task 4.2: Membership routes — Depends on [4.1, 1.3]

- **BATCH**: B3 (Lane C)
- **ACTION**: Create `src/app/api/workspaces/[id]/members/route.js` (GET/POST) and `src/app/api/workspaces/[id]/members/[userId]/route.js` (PATCH/DELETE).
- **IMPLEMENT**: Same `requireWorkspaceManager` authority as invitations; personal workspace → `PERSONAL_WORKSPACE` on mutations; non-member → 404. POST `{userId, role}` (server forces `source='manual'`); existing row any source → 409 `membership_exists`; idp row → 409 `idp_managed`. PATCH `{role}`: allow-list; managers cannot grant above `manager` (workspace-owner/instance-admin only); in-tx `assertNotLastManager` + re-read caller authority. DELETE: in-tx last owner/manager guard, then revoke that user's keys in THIS workspace only (never service keys, never other workspaces). Audit uses existing `membership.*` repo events — no duplicates.
- **MIRROR**: HANDLER_GUARD_ORDER, LAST_MANAGER_GUARD, LEGACY_KEY_TOMBSTONE_GAP.
- **GOTCHA**: Re-read actor membership + target inside mutation tx; cached principal may be stale.
- **VALIDATE**: Cross-workspace manager denial (404/403, never data) tests in 6.x.

### Task 5.1: Ownership transfer service + route — Depends on [1.2, 2.1]

- **BATCH**: B3 (Lane D)
- **ACTION**: Create `src/lib/users/ownershipTransfer.js` (password re-auth proof) and `src/app/api/users/ownership-transfer/route.js`.
- **IMPLEMENT**: Route: `requireMultiUser()` → same-origin/JSON → owner live session → rate-limit (IP+account limiter) → strict `{toUserId, currentPassword}` → `verifyPassword` against stored hash with dummy-hash cover for unknown users, `MAX_PASSWORD_LENGTH` cap. Service: reuse `transferOwnership` repo fn inside tx that rechecks live owner (expected `sv`) and target active+approved; demote-before-promote; dual `sv` bump; both session caches dropped. SSO-only owner (no password identity) → fail closed, clear `reauth_unsupported` error.
- **MIRROR**: TRANSFER_OWNERSHIP, HANDLER_GUARD_ORDER, `src/lib/auth/loginLimiter.js` bucket shape.
- **GOTCHA**: Existing session is never proof; wrong password → 401 `reauth_required`, zero state change; never trust JWT `amr`.
- **VALIDATE**: Transfer matrix tests in 6.x.

### Task 5.2: SSO invite acceptance via OIDC/SAML state — Depends on [3.2]

- **BATCH**: B4 (Lane D)
- **ACTION**: Update `src/app/api/auth/oidc/start/route.js`, `src/app/api/auth/oidc/callback/route.js`, `src/app/api/auth/saml/start/route.js`, `src/app/api/auth/saml/acs/route.js` to carry invite intent through server-controlled state.
- **IMPLEMENT**: Short-lived signed `purpose='invite-accept'` intent (invite tokenHash, protocol, nonce, ≤10 min) bound into freshly generated OIDC state/nonce/PKCE or SAML request ID (jose signing); raw token never in redirect URLs. Callback verifies protocol normally (signatures, replay, allow-list/groups); only the verified identity object reaches the accept transaction — SSO verified-identity path in `invitations.js`: link by `(provider, issuer, subject)` triple only; email binding via verified IdP email (`email_verified === true` OIDC), never links identities; accepted invitee becomes approved `user`; membership conflict (any source incl. `idp`) → 409, never overwrite; disabled linked account fails without consuming.
- **MIRROR**: `src/lib/users/bootstrap.js` resolveSsoUser usage (bootstrap.js:240-244), `ssoProvisioning.js` admission shape.
- **GOTCHA**: Proxy-bundle constraint — no oidc/saml provider imports into proxy-loaded modules; keep SSO-linking calls at `resolveSsoUser`-level API.
- **VALIDATE**: SSO accept tests in 6.x; `npm run build` clean (proxy bundle).

### Task 6.1: invitations + SSO + guard tests — Depends on [5.2]

- **BATCH**: B5 (tests)
- **ACTION**: Create `tests/unit/invitations.test.js`: accept happy (password + session + SSO-intent via service seam), expiry boundary, reuse, revoke, double-accept race (parallel), wrong-email/case tricks, generic `invite_invalid` on all bad states; cross-workspace manager denial; `manager`-grant refusal; personal-workspace invite; switch-off 404 every invitation route (anonymous + authenticated, both latch states); idp-triple SSO linking (email-only mismatch never claims).
- **IMPLEMENT**: Reuse `seedTenancy`/`callRoute`/`denied` from `tests/setup/tenancyHarness.js`; concurrency via `Promise.allSettled` on two accepts; no-secrets assertions (`token`/`tokenHash` absent in list/detail/logs/audit).
- **MIRROR**: TEST_HARNESS.
- **GOTCHA**: Tests run only via `npm test` or `npx vitest run -c tests/vitest.config.js` (HOME isolation).
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/invitations.test.js` green both switch states.

### Task 6.2: lifecycle + membership + transfer tests — Depends on [4.2, 5.1]

- **BATCH**: B5 (tests)
- **ACTION**: Create `tests/unit/user-lifecycle.test.js` (list pagination clamp/no-secrets; approve; role/status allow-lists; hierarchy; escalation via `owner`/`instanceRole` in body; `OWNER_IMMUTABLE`; disable revokes sessions + all keys incl. legacy and refuses last-active-manager; enable resurrects nothing; delete cascade — personal rows + `ws:<id>/` kv + user keys gone everywhere, shared refs NULL, service keys + audit survive), `tests/unit/membership-management.test.js` (CRUD matrix; idp rows `idp_managed`; last-manager; key revocation scoped to workspace), `tests/unit/ownership-transfer.test.js` (wrong password 401 no-write; right password atomic swap, dual `sv` bump, single owner; SSO-only fail-closed; switch-off 404).
- **IMPLEMENT**: Same harness; disable tests re-login to prove old session + keys dead; persisted audit rows asserted secret-free.
- **MIRROR**: TEST_HARNESS.
- **GOTCHA**: IdP rows untouched by manual APIs — assert sync state unchanged after manual attempts. Switch-off: every new route 404 across both `isUserSecurityEnforced` latch states.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/user-lifecycle.test.js tests/unit/membership-management.test.js tests/unit/ownership-transfer.test.js` green both switch states.

---

## Testing Strategy

### Unit Tests

Reuse `tests/setup/tenancyHarness.js` (`seedTenancy`/`callRoute`/`denied`); run only via `npm test` or `npx vitest run -c tests/vitest.config.js`.

| Test                                | Input                                          | Expected                                                                              | Edge? |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | ----- |
| accept happy (password/session/SSO) | valid token                                    | approved `user` + exact `source='invite'` membership                                  | —     |
| expiry boundary                     | `now >= expiresAt`                             | reject, token unconsumed                                                              | yes   |
| reuse / revoke / double-accept race | parallel accepts                               | one winner, rest generic 400                                                          | yes   |
| cross-workspace manager denial      | manager of A → B                               | 404/403, never data                                                                   | yes   |
| escalation                          | `instanceRole`/`owner` in body                 | refused                                                                               | yes   |
| disable                             | admin disables user                            | status + sv bump, sessions + all keys (legacy incl.) dead                             | yes   |
| enable                              | re-enable                                      | resurrects nothing                                                                    | yes   |
| delete cascade                      | delete user                                    | personal rows + `ws:<id>/` kv + user keys gone; shared + service keys + audit survive | yes   |
| last-manager                        | remove/demote/disable/delete                   | `LAST_MANAGER` in-tx                                                                  | yes   |
| owner immutability                  | PATCH/DELETE owner                             | `OWNER_IMMUTABLE`                                                                     | yes   |
| transfer                            | right/wrong password                           | atomic swap, dual sv bump / 401 no-write                                              | yes   |
| no-secrets                          | every list/error/audit                         | no token/hash/key/sessionVersion                                                      | yes   |
| switch-off                          | all 13 routes anon + authed, both latch states | 404                                                                                   | yes   |
| idp rows                            | manual write to `source='idp'`                 | 409 `idp_managed`, sync state unchanged                                               | yes   |

### Edge Cases Checklist

- [ ] Expired/reused/revoked/double-accept race (one winner)
- [ ] Email binding mismatch + case/whitespace tricks
- [ ] SSO matching-email different-`sub` never claims
- [ ] Switch off: all routes 404 both latch states
- [ ] Pagination DoS clamp (pageSize ≤100)

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: Zero errors

### Brand

```bash
npm run lint:brand
```

EXPECT: Zero errors

### Unit Tests

```bash
npm test
```

EXPECT: Full suite + known-fails gate green.

Switch-state legs mirror CI: `.github/workflows/ci.yml` sets `TOKENHOP_MULTI_USER: ${{ matrix.multi_user }}` (`off`/`on` matrix legs). Reproduce locally:

```bash
TOKENHOP_MULTI_USER=off npx vitest run -c tests/vitest.config.js tests/unit/invitations.test.js
TOKENHOP_MULTI_USER=on npx vitest run -c tests/vitest.config.js tests/unit/invitations.test.js
```

### Full Test Suite

```bash
npm test
```

EXPECT: No regressions

### Focused runs

```bash
npx vitest run -c tests/vitest.config.js tests/unit/invitations.test.js tests/unit/user-lifecycle.test.js tests/unit/membership-management.test.js tests/unit/ownership-transfer.test.js
```

EXPECT: All four green with switch off and on.

### Build

```bash
npm run build
```

EXPECT: Clean (proxy bundle constraint: no oidc/saml imports in proxy-loaded modules).

### Manual Validation

- [ ] Switch off: every new route 404 anonymous + authenticated, single-user behavior byte-identical
- [ ] Switch on: invite → accept → login flow end-to-end

---

## Acceptance Criteria

- [ ] Password + SSO + session acceptance produce exact `source='invite'` membership; token consumed once
- [ ] Expired/consumed/revoked/wrong-email tokens fail without writes; concurrent accepts → one winner
- [ ] Cross-workspace denial, escalation, personal-workspace invite, owner immutability enforced + tested
- [ ] Disable revokes sessions + all keys (legacy incl.); enable restores nothing
- [ ] Transfer: wrong password 401 no-write; success one owner, both sessions dead
- [ ] Deletion cascade correct; last-manager holds; service keys + audit survive
- [ ] No-secrets lists; pagination clamped; IdP rows untouched
- [ ] All new routes 404 with switch off; route-policy + tenancy tests green

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style (fixed `{ error, code }` literals)
- [ ] No secrets in responses/logs/audit
- [ ] Tests follow tenancyHarness patterns
- [ ] No hardcoded values
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk                                    | Likelihood | Impact | Mitigation                                       |
| --------------------------------------- | ---------- | ------ | ------------------------------------------------ |
| Migration 012 claimed by another lane   | Med        | Med    | re-check registry on rebase; additive idempotent |
| Guard ordering leaks 401/403 before 404 | Med        | High   | multiUserOnly first; test anon + authed          |
| Invite race / partial account           | Med        | High   | single sync tx; conditional consume              |
| Stale actor authority                   | Med        | Med    | re-read inside every mutation tx                 |
| Deletion misses `ws:<id>/` kv           | Med        | Med    | explicit bounded cleanup + test                  |
| bcrypt cost on public accept            | Low        | Med    | async only; IP + token-hash limiter              |
| sql.js persistence ≠ fsync              | Low        | Low    | tx atomicity only; no durability claims          |

## Notes

- Decisions in feature-spec.md are binding; don't reopen.
- Migration number 012: re-check next-free on rebase (YAN-365 collision).
- YAN-365 DEK contract: leave tested cascade contract, no placeholder code.
- SSO-only owners fail closed on transfer (follow-up issue).
