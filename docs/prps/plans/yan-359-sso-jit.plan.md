# Plan: YAN-359 SSO identity linking, JIT provisioning and group mapping

## Summary

Replace enforced-security SSO owner fallback with stable identity admission, atomic JIT provisioning and login-time group reconciliation. Preserve manual admins/memberships, owner bootstrap proofs, password flows and pristine-off SSO. Pending users receive no auth or identity-display cookie; public `/login/pending` gives generic approval instructions.

## User Story

As a team member, I want my configured SSO identity to resolve my own account and allowed workspaces, so that IdP login never grants another person's owner session.

## Problem → Solution

Current `sessionClaims()` rejects linked non-owners and allows unlinked one-user owner fallback (`src/lib/users/session.js:278-303`). Enforced-security callbacks instead admit verified stable identities, provision pending/user accounts, synchronize IdP-derived access transactionally, and mint claims only for active approved users.

## Metadata

- **Complexity**: XL; bounded auth/security change, not separate projects.
- **Source PRD**: `docs/plans/yan-359-sso-jit/feature-spec.md` (approved feature spec).
- **PRD Phase**: Standalone approved feature.
- **Estimated Files**: 33 planned application/test files; no dependencies added.
- **Inspection baseline**: `dcae2aa3de5143f88b0ef494a3dbb68f138f0768`; inspected HEAD and `origin/master` match. Migration registry currently ends at 010.
- **Research**: reuse all seven `docs/plans/yan-359-sso-jit/research-*.md` reports; no external research rerun.
- **Authority**: user-approved spec decisions override research suggestions; corrections below override preliminary spec contradictions.

## Batches

Tasks within each batch have disjoint advisory ownership; parent serializes any ownership adjustment. All work shares existing approved worktree. Parent owns application validation/execution; this artifact does not execute app changes.

| Batch | Tasks         | Depends On | Parallel Width |
| ----- | ------------- | ---------- | -------------- |
| B1    | 1.1, 1.2, 1.3 | —          | 3              |
| B2    | 2.1, 2.2      | B1         | 2              |
| B3    | 3.1           | B2         | 1              |
| B4    | 4.1           | B3         | 1              |
| B5    | 5.1           | B4         | 1              |

- **Total tasks**: 8
- **Total batches**: 5
- **Max parallel width**: 3

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/tokenhop/tokenhop/.slim/worktrees/yan-359-sso-jit` (branch: `users/yan-359-sso-jit`, base: `origin/master`). Existing approved worktree; no creation, child worktrees or branch replacement.

## UX Design

### Before

```text
/login: existing SSO button
Verified callback: linked owner succeeds; linked non-owner refused
Unlinked identity: legacy owner fallback with <=1 active user
```

### After

```text
/login: same existing SSO button
Verified + admitted active user/admin/owner: /dashboard, own claims
Verified + admitted pending: /login/pending, generic waiting page, no auth cookie
Denied/unavailable/sync failed: /login, fixed safe error callout
```

### Interaction Changes

| Touchpoint                 | Before                             | After                                            | Notes                                                               |
| -------------------------- | ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Pending SSO                | `sso_not_linked` or owner fallback | Generic `/login/pending`                         | No session, display-name cookie, query identity, polling or new API |
| Allow-list miss            | No admission policy                | `sso_group_denied`                               | Does not reveal groups or account existence                         |
| Claims unavailable         | No groups extraction               | `sso_groups_unavailable`                         | Fail closed before writes                                           |
| Invalid map / last manager | No sync                            | `sso_sync_failed`                                | Rollback; operator repairs policy/alternate manager                 |
| Instance policy            | No keys                            | Six validated admin-only settings                | API only; editor is YAN-373                                         |
| Rollout off                | Existing UI                        | Same UI; pending route 404; keys hidden/rejected | Latched security still enforced internally                          |

Designer handoff: task 2.2 must use existing login shell, `Card`, `BrandLockup`, `EmptyState`, `Button`, `Callout`; calm waiting state, one h1, status announcement, keyboard-reachable Back to sign-in link. Copy: “Waiting for approval. An administrator needs to approve your account. Sign in again once you've been approved.” Check 1440/1024/390 widths, both themes, keyboard and RTL; no identity-specific content.

## Mandatory Reading

| Priority | File                                                  | Lines                    | Why                                                                       |
| -------- | ----------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| P0       | `CLAUDE.md`                                           | 16-18, 44-58, 100-124    | Release model, test isolation, DB boundary, JS/i18n rules                 |
| P0       | `RELEASING.md`                                        | 10-101                   | Existing master feature branch; no maintenance/release actions            |
| P0       | `docs/ARCHITECTURE.md`                                | all                      | Required request/persistence context; CLAUDE notes persistence correction |
| P0       | `docs/plans/yan-359-sso-jit/feature-spec.md`          | all                      | Approved product decisions                                                |
| P0       | `docs/plans/yan-359-sso-jit/research-security.md`     | 131-176                  | Reconciliation; approved spec still overrides suggested exceptions        |
| P0       | `src/lib/users/session.js`                            | 36-43, 77-100, 267-327   | Latch, pending rejection, unsafe SSO fallback, claims                     |
| P0       | `src/lib/users/bootstrap.js`                          | 66-89, 188-287           | Existing one-shot owner proofs and rollout-only resolver                  |
| P0       | `src/lib/db/repos/usersRepo.js`                       | 17-108, 178-270, 345-378 | Provenance clearing, synchronous creation seam, cache, ownership transfer |
| P0       | `src/lib/db/repos/membershipsRepo.js`                 | 12-32, 90-142            | Last-manager invariant and API-key revocation                             |
| P0       | `src/lib/db/repos/identitiesRepo.js`                  | 23-75                    | Stable-key uniqueness and identity insertion                              |
| P1       | `src/lib/auth/authModes.js`                           | 14-25                    | Exactly one selected SSO protocol; `both` means password plus SSO         |
| P1       | `src/lib/auth/oidc.js`                                | 41-70, 107-140, 220-276  | Runtime gating, exchange, verification; preserve HS256/nonce              |
| P1       | `src/lib/auth/saml.js`                                | 109-205, 219-267         | Signed profile, issuer pin, request binding, attribute precedence         |
| P1       | `src/app/api/auth/oidc/callback/route.js`             | all                      | Verification, setup cookie, response contract                             |
| P1       | `src/app/api/auth/saml/acs/route.js`                  | all                      | Existing IP limiter and SAML admission                                    |
| P1       | `src/app/api/settings/route.js`                       | 43-104, 162-221, 257-314 | Both response paths, split/legacy writes, validation                      |
| P1       | `src/app/api/settings/validateSettings.js`            | 12-24, 43-139, 189-216   | Pure validation shared with config import                                 |
| P1       | `src/lib/users/securityState.js`                      | 1-16                     | Marker-latched enforcement                                                |
| P1       | `src/lib/db/migrations/index.js`                      | all                      | Frozen migrations and next version 011                                    |
| P2       | `tests/unit/owner-bootstrap.test.js`                  | 1-60, 145-195, 230-240   | Env reload, explicit owner proof fixtures                                 |
| P2       | `tests/setup/tenancyHarness.js`                       | all                      | Existing two-user isolated DB and route helpers                           |
| P2       | `tests/unit/oidc-callback.test.js`                    | 1-104                    | Existing HS256 fixture; mocks do not prove real admission                 |
| P2       | `tests/unit/oidc-verify.test.js`                      | all                      | Existing RS256/JWKS fixtures                                              |
| P2       | `tests/unit/saml.test.js`                             | all                      | Existing SAML response fixtures                                           |
| P2       | `tests/unit/gateway-key-established-security.test.js` | all                      | Pristine-off vs marker-latched-off fixture                                |

Read remaining supplied research as context, not authority: `research-business.md`, `research-external.md`, `research-technical.md`, `research-ux.md`, `research-practices.md`, `research-recommendations.md`. Already inspected for this plan; their rejected designs are listed below.

## External Documentation

Existing research reused; no live IdP or fresh external calls required.

| Topic                 | Source                                                                   | Key Takeaway                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| OIDC UserInfo binding | <https://openid.net/specs/openid-connect-core-1_0.html#UserInfoResponse> | Exact case-sensitive `sub` match mandatory; ordinary UserInfo need not contain `iss`                                         |
| jose verification     | <https://github.com/panva/jose>                                          | Existing signature/issuer/audience/algorithm verification stays; nonce remains explicit                                      |
| node-saml profile     | <https://github.com/node-saml/node-saml>                                 | Signed profile NameID/issuer and scalar-or-array attributes; preserve InResponseTo/replay defenses                           |
| authentik claims      | <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/>          | Groups placement depends on configuration; absent-only UserInfo fallback covers it; exact toggle behavior remains unverified |

## Binding Contracts and Research Corrections

1. **Gate matrix**: pristine off = rollout false, marker legacy: skip all new admission, parsing, UserInfo, DB writes and new OIDC limiter; keep existing redirects/cookie claim shape. Enforced on = new path. Marker-latched off = new path remains enforced, never owner fallback; rollout-hidden settings/pending page remain hidden (404). `securityOn()` alone cannot prove pristine parity because it also invokes bootstrap and latch checks.
2. **UserInfo**: verified id_token identity remains authority. Fetch only if configured claim is absent, not empty `[]`; require discovery `userinfo_endpoint` and same exchange `access_token`, 5-second timeout, `cache: "no-store"`, no redirects to a different endpoint (`redirect: "error"`). Require exact nonempty `sub`; validate exact `iss` only if present. Never require UserInfo `iss`; endpoint is pinned by configured-issuer discovery. Non-2xx, bad JSON/shape, missing endpoint/token/claim, timeout, subject mismatch or present mismatching issuer denies before writes. Never replace email/owner proof from UserInfo.
3. **Identity**: `(provider, verified issuer, subject)` only; require nonempty string issuer/subject; no trim/case normalization of stable keys; no email matching. SAML transient NameID denies, persistent configuration explained in server log without assertion dump. Existing signature, nonce, audience, issuer pin and replay safeguards unchanged.
4. **Groups**: shared read-only bounded own-property OIDC dot-path reader, depth <=5; reject `__proto__`, `constructor`, `prototype`. Normalize scalar string or string array, exact case-sensitive names, deduplicate, keep at most 100 valid nonempty strings <=256 chars; drop object/oversize/unsafe-name entries, never stringify or CSV-split into privileges. Invalid top-level claim shape denies; explicit empty array is valid. SAML exact own configured attribute first, then own `profile.attributes` key; URI keys stay literal. Missing group source after protocol resolution denies `sso_groups_unavailable`, never silently demotes on fetch failure.
5. **Admission**: empty allow-list unrestricted; otherwise match required on every login, including linked owner and explicit owner proof. Run before bootstrap/JIT/sync and before reading-and-clearing setup cookie or consuming DB proof. Disabled stays disabled. No full cookie for pending; keep `validateSessionToken` rejection unchanged.
6. **JIT / roles**: unlinked admitted identity uses existing owner proof resolver; absent proof JITs default pending/user. Admin-group match immediately promotes pending/user to admin with `instanceRoleSource='idp'`. Losing match demotes only IdP admins to user, clearing source. Manual admin and owner never demoted/re-sourced. Approved user never reset to pending.
7. **Manual provenance**: migration 011 adds nullable `instanceRoleSource TEXT CHECK (instanceRoleSource IN ('idp'))`, no backfill marking existing admins as IdP. Any explicit manual `instanceRole` property clears source, even same-role admin reassertion; clearing nonnull provenance counts as security change and bumps sv once. Unrelated updates do not clear source; callers cannot mass-assign source. Ownership transfer clears source on both rows. Internal IdP sync uses separate sync seam, never public manual update wrapper.
8. **Memberships**: `{group, workspaceId, role}[]`; shared IDs only; roles manager/member/viewer; highest role wins per workspace. Existing manual/invite row wins unchanged even if weaker. Only IdP rows updated/removed; owner role/personal memberships excluded. Recheck configured map targets inside transaction: missing/deleted/personal target FAILS sync and denies; spec's skip-and-audit row is rejected. Guard both last-manager demotion and removal. Removal revokes that user's workspace API keys.
9. **Atomicity / sv**: one synchronous transaction owns non-owner JIT user+personal workspace+identity+role+memberships+exactly one sv increment if role or memberships change. No async repo calls inside tx. Unchanged login no increment; provenance-only manual reassertion also revokes. Invalidate user and active-count cache on commit (and conservatively on rollback), return fresh committed row. Existing owner's proof/link semantics preserved; bootstrap/proof resolver remains outside non-owner transaction, after admission. Existing claim-before-link caveat stays follow-up, not silently widened.
10. **Race / collisions**: UNIQUE identity loser rolls back all own rows, re-reads winner and retries one full sync; bounded one retry, recheck disabled/provenance/map. Email collision retries entire transaction once with email NULL, preserving claimed `identities.emailAtLink`; no username synthesis needed (nullable username), no reserved-owner collision. `requireLogin=false` must check active-user count inside tx and deny second active user, including pending; never alter settings as login side effect.
11. **Protocols verified**: `resolveAuthModes` returns `oidc: ssoEnabled && protocol === "oidc"`, `saml: ... === "saml"` (`src/lib/auth/authModes.js:14-25`); cannot simultaneously enable OIDC and SAML. `authMode="both"` means password plus selected SSO, not both protocols. Latest successful selected-protocol login is sole authority for user's IdP rows; protocol flip reconciles old rows at next login. No multi-issuer union/provenance expansion.
12. **Settings**: six flat keys: `ssoGroupsClaim="groups"`, `samlAttributeGroups="groups"`, `ssoAllowedGroups=[]`, `ssoAdminGroups=[]`, `ssoGroupWorkspaceMap=[]`, `ssoDefaultRole="pending"`. Admin-only instance GET/PATCH when rollout enabled; while disabled omit on GET and every PATCH response, reject any body containing these keys with 404 before legacy/split writes. Shape errors and unknown/personal workspace IDs 400. Do not add policy keys to existing protocol-completeness lockout guard or fabricate current-user group state. Same shape checks apply to existing config-import validation; no new import/export editor.
13. **Responses / logs**: active approved user gets own `{sub, sv, wid, amr:[method]}` and existing protocol metadata. Pending gets `/login/pending`, no new cookie (normal attempt-cookie deletion allowed); errors fixed codes `sso_group_denied`, `sso_groups_unavailable`, `sso_sync_failed`, `account_disabled`, existing limiter/protocol codes. Audit safe role/source/count/workspace delta only; no groups, assertions, access/id tokens, setup proofs or claim dumps. New logs fixed safe reasons, not network error objects carrying secrets.

Rejected research proposals: limited pending/display cookie, UI editor, no migration, manual-admin demotion, owner allow-list bypass, silent last-manager/map skip, no membership sv bump, retaining enabled owner fallback, multiple active protocol assumption, requiring UserInfo `iss`, new nested settings object, general email merge, speculative extra SAML configuration.

---

## Patterns to Mirror

Inspection confirmed exact paths below at baseline `dcae2aa3`. Snippets are copied, max five lines.

### NAMING_CONVENTION

```js
// SOURCE: src/lib/db/repos/identitiesRepo.js:23-24
// Login/bootstrap path: resolve an identity before any principal exists.
export async function findIdentityUnscoped({ provider, issuer = "", subject }) {
```

Login/admin repo helpers use `*Unscoped`; synchronous transaction helpers export plain functions or `*Sync` (`revokeUserApiKeysSync`). Keep camelCase, ESM JavaScript, no TypeScript.

### ERROR_HANDLING

```js
// SOURCE: src/lib/users/errors.js:26-33
export function mapConstraintErrors(fn) {
  try {
    return fn();
  } catch (err) {
    const msg = String(err?.message || "");
```

Branch on `TenancyError.code` (`IDENTITY_TAKEN`, `EMAIL_TAKEN`, `LAST_MANAGER`, `SINGLE_USER_MODE`), never driver text. Routes catch and return fixed `/login?error=` codes.

### LOGGING_PATTERN

```js
// SOURCE: src/app/api/auth/oidc/callback/route.js:124-130
console.warn("[OIDC] callback failed:", error?.message || error);
audit(
  { request },
  "auth.loginFailed",
  { type: "user" },
```

New SSO logs use fixed safe text; never pass assertion, tokens, raw claims or setup proof.

### REPOSITORY_PATTERN

```js
// SOURCE: src/lib/db/repos/usersRepo.js:205-207
return mapConstraintErrors(() =>
  db.transaction(() => {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

Transactions are synchronous. Await prerequisites before `db.transaction`; return committed row after cache drop.

### SERVICE_PATTERN

```js
// SOURCE: src/lib/users/session.js:278-282
export async function sessionClaims(method, identity = null, opts = {}) {
  if (!(await securityOn())) return {};
  await ensureOwnerBootstrap();
  let user = null;
  if (method !== "pwd") {
```

Session module remains claim boundary; new SSO admission service owns policy and mutation, and must not be imported by proxy-bundle modules.

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/owner-bootstrap.test.js:16-22
async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  b = await import("@/lib/users/bootstrap");
```

Tests import through aliases under isolated vitest config; restore env in `afterAll`.

### Additional exact anchors

```js
// SOURCE: src/lib/auth/authModes.js:20-23
password: !ssoOnly,
oidc: ssoEnabled && protocol === "oidc",
saml: ssoEnabled && protocol === "saml",
protocol,
```

```js
// SOURCE: src/lib/db/repos/membershipsRepo.js:129-133
const { changes } = db.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [
  workspaceId,
  userId,
]);
if (changes > 0) revokeUserApiKeysSync(db, userId, { workspaceId, now });
```

```js
// SOURCE: src/lib/users/securityState.js:9-13
export async function isUserSecurityEnforced() {
  // Validate the marker even with rollout on; malformed state must never bypass.
  if (await isHashedSecurityEstablished()) return true;
  const { isMultiUserEnabled } = await import("./featureSwitch.js");
  return isMultiUserEnabled();
```

## Codebase Discovery

| Category     | File:Lines                                         | Pattern                                                          | Key Snippet                                             |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Similar Impl | `src/lib/users/bootstrap.js:234-271`               | Stable-key lookup, explicit owner proofs, IDENTITY_TAKEN re-read | `const linked = await findIdentityUnscoped(key);`       |
| Similar Impl | `src/lib/db/repos/usersRepo.js:190-233`            | User + personal workspace + owner membership in one transaction  | `db.transaction(() => {`                                |
| Naming       | `src/lib/db/repos/identitiesRepo.js:23-24`         | Login-path functions use `Unscoped` suffix                       | `findIdentityUnscoped`                                  |
| Error        | `src/lib/users/errors.js:16-23`                    | SQLite constraint mapping to typed tenancy codes                 | `["identities.provider", "IDENTITY_TAKEN", ...]`        |
| Logging      | `src/lib/users/audit.js:7-31,69-96`                | Deny-by-default audit keys; fire-and-forget                      | `const ALLOWED = new Set([`                             |
| Types        | `src/lib/users/session.js:273-277`                 | JSDoc contracts, no TS                                           | `@param {"pwd"\|"oidc"\|"saml"} method`                 |
| Types        | `src/lib/db/schema.js:167-183`                     | Users role CHECK and single-owner unique index                   | `instanceRole IN ('owner', 'admin', 'user', 'pending')` |
| Tests        | `tests/unit/owner-bootstrap.test.js:16-39`         | Switch reload and isolated DB reset                              | `vi.resetModules();`                                    |
| Tests        | `tests/setup/tenancyHarness.js:25-41`              | Owner A/user B/shared workspace seed                             | `await db.addMembership(...)`                           |
| Config       | `src/lib/users/featureSwitch.js:43-75`             | Only rollout reader; route 404 helper                            | `requireMultiUser()`                                    |
| Config       | `src/app/api/settings/validateSettings.js:204-216` | Default keys become known keys                                   | `Object.keys(DEFAULT_SETTINGS)`                         |
| Deps         | `src/lib/auth/oidc.js:63-70`                       | Native fetch with `no-store`; no OIDC client lib                 | `fetch(discoveryUrl, { cache: "no-store" })`            |
| Deps         | `src/app/api/auth/saml/acs/route.js:7-14`          | Existing SAML helper/session/limiter imports                     | `checkLock, recordFail, recordSuccess, getClientIp`     |

## Traces

| Trace         | Path                                                                                         | Finding                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Entry Points  | `src/app/api/auth/oidc/callback/route.js:23-123`; `src/app/api/auth/saml/acs/route.js:18-94` | Public SSO callbacks verify protocol data then call `sessionClaims`. OIDC lacks limiter; SAML has IP limiter.          |
| Data Flow     | `src/app/api/auth/oidc/callback/route.js:62-97`                                              | Discovery/token/id_token produce `identity`; access token available as `tokenData.access_token` for UserInfo fallback. |
| State Changes | `src/lib/users/bootstrap.js:241-270`; `src/lib/db/repos/usersRepo.js:235-269`                | Today only explicit owner identity links; manual role updates bump sv via `SESSION_FIELDS`.                            |
| Contracts     | `src/lib/users/session.js:77-100,278-303`; `src/app/login/loginErrors.js:1-38`               | Pending sessions reject; SSO claims fallback is unsafe; login error codes map through allow-listed text.               |
| Patterns      | `src/lib/users/securityState.js:9-13`; `src/lib/db/migrations/index.js:4-26`                 | Latch-aware enforcement, append-only idempotent migrations, synchronous repository invariants.                         |

## Gaps

- GAP: no UserInfo, groups reader, JIT service, IdP membership sync, admin role provenance or pending page exists at baseline.
- GAP: existing OIDC callback tests mock `sessionClaims`; database-backed admission must be covered separately.
- GAP: authentik "include claims in id_token" exact live behavior remains unverified; plan handles absence with UserInfo and never needs live IdP.

---

## Files to Change

Ownership advisory, not permission to broaden scope. CREATE paths absent at inspection; UPDATE paths verified. Parent serializes fixes after review.

| File                                                  | Action | Justification / task owner                                                                  |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `src/lib/db/migrations/011-sso-role-source.js`        | CREATE | Nullable IdP-admin provenance, task 1.1                                                     |
| `src/lib/db/schema.js`                                | UPDATE | Match current schema with new column, 1.1                                                   |
| `src/lib/db/migrations/index.js`                      | UPDATE | Register migration 011, 1.1                                                                 |
| `src/lib/db/repos/usersRepo.js`                       | UPDATE | Internal sync creation/cache seam; manual source clearing including same role/transfer, 1.1 |
| `src/lib/db/repos/identitiesRepo.js`                  | UPDATE | Synchronous identity insert seam reused by public wrapper, 1.1                              |
| `src/lib/db/repos/settingsRepo.js`                    | UPDATE | Six flat policy defaults, 1.2                                                               |
| `src/app/api/settings/validateSettings.js`            | UPDATE | Pure policy shape validation, shared with config import, 1.2                                |
| `src/app/api/settings/route.js`                       | UPDATE | Rollout visibility, new-key 404, shared workspace checks, 1.2                               |
| `src/app/api/settings/config/import/route.js`         | UPDATE | Same gate/map validation on import; block bypass, 1.2                                       |
| `src/lib/db/configExport.js`                          | UPDATE | Omit rollout-hidden SSO policy from export/preview state, 1.2                               |
| `src/lib/auth/oidc.js`                                | UPDATE | Bounded sub-bound UserInfo fetch, 1.3                                                       |
| `src/lib/auth/saml.js`                                | UPDATE | Exact configured groups attribute reader, 1.3                                               |
| `src/lib/users/ssoProvisioning.js`                    | CREATE | Safe groups reader/pure assignments in 1.3, transactional admission in 2.1                  |
| `src/lib/db/repos/membershipsRepo.js`                 | UPDATE | IdP-only synchronous diff with invariants/revocation, 2.1                                   |
| `src/lib/users/audit.js`                              | UPDATE | Add `groupCount`, `roleSource`; workspaceId already allowed, 2.1                            |
| `src/app/login/pending/page.js`                       | CREATE | Generic public server page with rollout 404, designer task 2.2                              |
| `src/app/login/loginErrors.js`                        | UPDATE | Three new safe fixed errors, 2.2                                                            |
| `src/lib/users/session.js`                            | UPDATE | Enforced SSO uses only admitted user, password unchanged, 3.1                               |
| `src/app/api/auth/oidc/callback/route.js`             | UPDATE | Enforced groups/admission/outcomes/account limiter, 3.1                                     |
| `src/app/api/auth/saml/acs/route.js`                  | UPDATE | Same admission, persistent identity check/account limiter, 3.1                              |
| `src/app/api/auth/oidc/start/route.js`                | UPDATE | Enforced-path `Referrer-Policy: no-referrer` on all responses, 3.1                          |
| `src/app/api/auth/saml/start/route.js`                | UPDATE | Same policy, 3.1                                                                            |
| `src/lib/auth/gatewayAuth.js`                         | UPDATE | Existing logged-URL sanitizer redacts `setupToken` as well as `key`, 3.1                    |
| `tests/unit/db-migration-chain.test.js`               | UPDATE | 011 fresh/upgrade/idempotence/schema parity, 1.1                                            |
| `tests/unit/oidc-verify.test.js`                      | UPDATE | Reuse JWKS fixture; UserInfo absent-issuer/mismatch/timeout cases, 1.3                      |
| `tests/unit/saml.test.js`                             | UPDATE | Existing assertion/profile fixtures; attribute cases, 1.3                                   |
| `tests/unit/sso-jit.test.js`                          | CREATE | Critical DB admission/sync, 2.1                                                             |
| `tests/unit/settings-api-validation.test.js`          | UPDATE | Policy shapes, visibility and role/target rejection, 1.2                                    |
| `tests/unit/settings-config-export.test.js`           | UPDATE | Export/import hidden policy and no bypass, 1.2                                              |
| `tests/unit/oidc-callback.test.js`                    | UPDATE | Callback outcomes/limiter/headers with existing fixture, 3.1                                |
| `tests/unit/owner-bootstrap.test.js`                  | UPDATE | Owner proof admission ordering and legacy assertions, 3.1                                   |
| `tests/unit/principal-sessions.test.js`               | UPDATE | Enforced SSO no fallback; real admitted claims/revocation, 3.1                              |
| `tests/unit/gateway-key-established-security.test.js` | UPDATE | Latched-off no owner fallback, 3.1                                                          |

No DB barrel exports for internal synchronous helpers. New module imported directly by route handlers only. New API routes absent, so no route-policy table churn; `/login/pending` is outside dashboard guard (`src/dashboardGuard.js:185-248`). Extra test files forbidden unless existing fixtures cannot express critical case; parent may reassign ownership for necessary existing tests, serially.

## NOT Building

- YAN-373 editor, workspace picker, registry/search UI, approval management, invitations or YAN-360 lifecycle API.
- Pending auth/display cookie, pending session validator exception, extra status payload, polling, user-identifying URL parameters.
- General email linking/merging; SCIM, background sync, webhooks, grant union across IdPs, new auth framework/dependencies.
- Discovery caching, new queues/telemetry, reusable rules engine or future scaffolding.
- Protocol verification rewrite, broader SSRF/forwarded-host/signature hardening, form-encoded token exchange, owner-email claim atomicity change; pre-existing follow-ups remain documented in supplied research.
- Release/tag/publish, backports, default-switch change, RELEASING.md/CHANGELOG edits, locale translations, unrelated app cleanup.

---

## Step-by-Step Tasks

### Task 1.1: Provenance migration and synchronous repo seams — Depends on none

- **BATCH**: B1
- **ACTION**: Own migration/schema/registry, usersRepo, identitiesRepo and migration-chain test rows above. Add narrow 011 migration and transaction-safe primitives; do not edit SSO service yet.
- **IMPLEMENT**: Add nullable CHECK column with `tableHasColumn` idempotence and no broad rebuild/backfill; include column in internal user read projection, not session/public user projection. Extract smallest synchronous user/personal-workspace and identity creation helpers from existing wrappers (no async nested transactions); expose internal cache invalidation for post-sync use, and update manual role writes to clear source on explicit property including same-role admin, count actual source change in existing single sv bump, ignore client source fields, clear source during ownership transfer.
- **MIRROR**: REPOSITORY_PATTERN; `src/lib/db/migrations/007-user-password-change.js:4-14`; `usersRepo.js:190-269,345-365`; `identitiesRepo.js:42-74`.
- **IMPORTS**: Existing `tableHasColumn`, UUID, `mapConstraintErrors`, users cache; helpers imported directly, not DB barrel.
- **GOTCHA**: Do not clear source on unrelated profile/password writes. Same-role manual reassertion of IdP admin must become manual and invalidate old sv; changed role/source together still bumps once. CHECK allows NULL, not string `manual`; migrated existing admins stay manual. Recheck latest migration number before write; if parent rebases past 010, use next available number consistently rather than editing shipped migration.
- **VALIDATE**: Parent runs isolated migration tests and existing tenancy/password tests; assert fresh/010 upgrade/rerun match TABLES, no role/status/grant data changes, same-role clear bumps once, no-source same-role no bump, transfer clears both sources and preserves immutable-owner rules. Critical provenance assertions included in task 2.1 DB tests if fixtures need full service.

### Task 1.2: Validated gated instance policy — Depends on none

- **BATCH**: B1
- **ACTION**: Own settings defaults, validator, settings route, config import/export seams and their two existing test files. No editor.
- **IMPLEMENT**: Add six defaults and pure bounded validators (lists deduped, 100 entries/256 chars, safe claim path max five segments, default role pending/user, map array max100 and manager/member/viewer only; SAML key exact literal <=256 with forbidden prototype keys rejected). Enforce rollout gate before new-key writes on both split and legacy paths, omit keys on GET/every response/export/preview when off, require existing instance capability when on, and validate mapped IDs against shared workspaces for PATCH and config-import preview/apply before writes; import transaction must recheck targets to avoid deletion race.
- **MIRROR**: `validateSettings.js:43-103,195-216`; settings route `omitSecrets`, `safeSettingsResponse`, `splitKeyError`; `settingsScope.js:42-46` instance default. `config/import/route.js:94-106` already shares validator.
- **IMPORTS**: `isMultiUserEnabled`, existing `authorize`/`can` capability guard, `getAdapter`, existing settings validator. Keep async DB-target checks separate from pure `validateSettingsBody`.
- **GOTCHA**: `principalScope()` returns null with <=1 user or rollout off; never use it alone to authorize new policy. Defaults auto-add known keys; without explicit 404 gate pristine legacy PATCH would accept them. Inspect full GET and PATCH response paths and config preview, not only UI hiding. Use arrays of entries/stable IDs, not object maps or workspace names. Do not impose unapproved owner allow-list exemption/settings save guard.
- **VALIDATE**: Parent runs isolated settings API/config export tests: all six defaults, on admin/owner success, ordinary/pending deny, off missing keys and 404 writes, malformed/oversized/prototype/default-role/owner-role/unknown/personal ID 400, dedupe, config-import same checks/rollback. Existing lockout and secret scrubbing unchanged.

### Task 1.3: Verified protocol groups and UserInfo — Depends on none

- **BATCH**: B1
- **ACTION**: Own oidc.js, saml.js, pure start of ssoProvisioning.js and existing oidc-verify/saml tests. No callback changes.
- **IMPLEMENT**: Export safe presence-aware group reader/normalizer and pure `resolveAssignments(groups, settings) -> { admit, adminMatch, memberships }`; use bounded Map keyed by workspace ID, highest role rank, no claim mutation. Add `fetchOidcUserInfo` with five-second native timeout, bearer token/no-store/no redirect, exact sub and optional-present iss check; add `pickSamlGroups` using exact configured own key then attributes key, sharing normalization without CSV/string coercion.
- **MIRROR**: `oidc.js:63-70,107-140`; `saml.js:219-260`; NAMING_CONVENTION and TEST_STRUCTURE. Use same jose/SAML verifiers, not decode-only identity.
- **IMPORTS**: Native fetch/AbortSignal/Object.hasOwn; shared pure reader directly from new module. New module must not import oidc/saml, session, dashboardGuard or featureSwitch during this pure stage.
- **GOTCHA**: Claim present empty array must suppress fallback; no merge of id_token/UserInfo groups. UserInfo without `iss` valid, but present mismatch invalid. Endpoint authority comes from configured issuer's discovery; preserve existing id_token nonce/signature/algs. URI SAML attribute must remain literal. Missing/invalid source never becomes authoritative empty groups implicitly.
- **VALIDATE**: Parent runs isolated protocol tests: nested and literal keys, scalar/array, empty-vs-absent, wrong-sub, missing sub, absent iss accepted, wrong-present iss rejected, non-JSON/HTTP/timeout rejected, dangerous/oversize entries bounded, zero claim mutation; preserve existing HS256, RS256/JWKS, nonce, SAML signature/issuer/replay checks. Mock fetch or existing loopback fixtures only.

### Task 2.1: Atomic admission, JIT and IdP-only reconciliation — Depends on 1.1, 1.2, 1.3

- **BATCH**: B2
- **ACTION**: Own transactional section of ssoProvisioning.js, membershipsRepo.js, audit.js and new sso-jit.test.js. Preserve task 1.3 pure exports.
- **IMPLEMENT**: Implement `ssoAdmit(identity, groups, { setupToken, displayName }={})` returning `{ kind:"active"|"pending", userId }` or throwing fixed typed admission errors; apply validated identity/groups/allow-list before strict bootstrap/proof resolution, lookup linked identity directly (works latched off), reject disabled, use existing rollout-only `resolveSsoUser` for unlinked explicit owner proofs, otherwise provision via sync seams with username NULL. One synchronous non-owner tx re-reads user/source/status, checks requireLogin and all configured map targets, creates/link if needed, synchronizes IdP memberships/role, bumps sv once if role/membership changed, and returns safe deltas; rollback on any error, bounded IDENTITY_TAKEN winner re-read/EMAIL_TAKEN null-email retries, cache drop and sanitized audit only after result.
- **MIRROR**: REPOSITORY_PATTERN, ERROR_HANDLING; `membershipsRepo.js:23-32,100,121-134`; `bootstrap.js:234-271`; `usersRepo.js:82-108,178-233`.
- **IMPORTS**: `getAdapter`, direct sync user/identity helpers, `findIdentityUnscoped`, `resolveSsoUser`, `ensureOwnerBootstrap`, `syncIdpMembershipsSync`, `mapConstraintErrors`, `TenancyError`, `getSettings`, `audit`; no protocol/network/session imports.
- **GOTCHA**: Admission before bootstrap and before resolver means denied owner never spends proof. Strict bootstrap is rollout-only today; latched off with missing owner must deny, not call legacy bootstrap or mint `{}` claims. Owner bypasses role/membership mutation but not allow-list; validate policy before owner success. Preserve manual admin even matching admin group; only set IdP source on promotion. Re-read inside tx prevents stale pre-read manual role/source reassertion from being overwritten. Missing workspace and LAST_MANAGER both abort entire login; never skip or return prior success. IdP membership helper returns changed/deltas, never bumps sv itself; separate service single bump prevents double increment. No transaction wraps Promise/async repo calls.
- **VALIDATE**: Parent runs isolated sso-jit tests for pending/user/admin first login, stable identity without email, email change/same-email distinct account, issuer separation, manual approved/admin/source reassertion behavior, owner allowed/denied proof unchanged, disabled unchanged, highest mapped role/manual-invite collision, removal key revocation, role+membership one bump/membership-only one bump/unchanged zero, stale JWT/cache denial, missing/personal target/LAST_MANAGER rollback, injected insert failure no orphan rows, same-key concurrent first login converges, requireLogin=false second active user deny. Use existing tenancy/bootstrap/JWT fixtures; no new framework.

### Task 2.2: Public pending page and safe login errors — Depends on 1.2

- **BATCH**: B2
- **ACTION**: Designer owns new pending server page and loginErrors.js. Review handoff required before callbacks integration; no admin editor.
- **IMPLEMENT**: Server component gates with `isMultiUserEnabled()` and `notFound()`, renders generic approved copy on existing login shell with one h1/status/Back to sign-in link, no cookies read or user data fetch. Add only `sso_group_denied`, `sso_groups_unavailable`, `sso_sync_failed` fixed messages; preserve generic unknown-code fallback and existing errors.
- **MIRROR**: `src/app/login/page.js:1-15`; `src/shared/components/EmptyState.js:10-18`; `Callout.js:18`; unmatched dashboard page's `notFound()` precedent.
- **IMPORTS**: `notFound` from next/navigation, rollout helper, existing components, `ACTIVE` brand for metadata; no pending JWT/session imports.
- **GOTCHA**: Public page intentionally generic even direct bookmark. Marker-latched-off security may send pending outcome to this rollout-hidden 404; never mint cookie to bridge hidden UI. No new auth/status fields, display cookie, dashboard exception or locale-file edits.
- **VALIDATE**: Parent checks direct unauthenticated on=200/off=404 including latched off; heading/status/link/keyboard/RTL and width/theme checks listed in UX handoff. Unknown crafted login codes show generic text; no groups/workspaces/email/identity reflected.

### Task 3.1: Callback admission, session safety and cheap hardening — Depends on 2.1, 2.2

- **BATCH**: B3
- **ACTION**: Integration owner edits session.js, both callbacks/start routes, logged-URL sanitizer and four auth regression files plus OIDC callback test; ownership may expand only serially for existing focused assertions.
- **IMPLEMENT**: Call latch-aware gate before any new work; pristine-off retains original callback calls/cookie payload, enforced path gets settings/groups then applies allow-list before `takeSetupToken`, calls service, maps pending/disabled/deny/sync error safely, and passes admitted user ID to `sessionClaims`. Replace enforced SSO fallback with admitted-ID-only lookup (missing admission/invalid identity returns null), require active nonpending/nonrotation user and mint fresh committed sub/sv/personal wid/amr; keep pwd/legacy behavior and pending validator unchanged; add OIDC IP pre-verification limit and both protocols' post-verification account buckets via `checkLoginLocks`/`recordLoginFail`/`clearAccount`, enforced-only no-referrer headers on every start response, and redact setupToken in existing URL sanitizer.
- **MIRROR**: SERVICE_PATTERN, LOGGING_PATTERN; passwordSessionClaims `session.js:314-327`; `loginLimiter.js:93-112`; `gatewayAuth.js:256-265`; callback verification and success metadata unchanged.
- **IMPORTS**: Direct route imports `ssoAdmit`, presence reader, UserInfo/SAML helpers, `isUserSecurityEnforced`, `getSettings`, existing limiter/audit/session/proof imports. Session receives `{ admittedUserId }` server-only option, does not import provisioning service or protocol helpers.
- **GOTCHA**: `sessionClaims` is server-internal, never trust client user ID. No SSO direct call without admission may regain owner fallback. Clear setup cookie only after group admission; DB proof not spent on denial. Account bucket uses case-sensitive collision-safe tuple string such as `sso:${JSON.stringify([provider,issuer,subject])}`, not lowercasing `accountKey({login})`. Enforced successes clear account only, never IP budget; pending is admitted, not failed password attempt. Preserve existing SAML pristine IP behavior; OIDC pristine must not gain new limiter. Existing cookie deletions are attempt cleanup, not pending session. No-referrer intentional security improvement applies enforced path so pristine-off comparisons remain stable.
- **VALIDATE**: Parent extends existing fixture/mocked-route tests plus real DB service/session test: pending/deny/failure no `setDashboardAuthCookie`; active claims match own user, pristine-off unchanged cookie shape/redirect and zero UserInfo/JIT; latched off no owner fallback; no malformed/empty identity session; owner allow-list miss doesn't clear/spend setup proof; wrong-sub unavailable error/no writes; account locks shared across IPs without case folding; SAML transient denial; no-referrer on success/error; sanitizer hides setupToken without changing actual routed URL. Existing callback test mock of sessionClaims cannot count as DB admission proof.

### Task 4.1: Parent validation and mandatory reviews — Depends on 3.1

- **BATCH**: B4
- **ACTION**: Parent runs critical checks/full gates, designer pending-page review and mandatory code-reviewer on every code change; security review covers trust/atomicity/latch paths. No broad test rewrite or live IdP.
- **IMPLEMENT**: Execute commands below against final feature head, record exact command/head/status and browser evidence; distinguish baseline pass from raw test count. Resolve in-scope review defects serially, rerun affected isolated tests and full gates after code changes; code-reviewer rechecks fixes and designer signs off public page.
- **MIRROR**: CLAUDE.md test isolation and known-fails gate, existing fixtures/tests from discovery, `RELEASING.md` trunk model.
- **GOTCHA**: Do not mark passing from mocked admission alone or `securityOn()` alone; require pristine legacy marker, valid hashed marker with rollout off, and malformed marker fail-closed cases. Request-log inspection finds no SSO start logger in custom-server (line143 passes URL internally, not log); redact via existing sanitizer only, never mutate `req.url` and break setup proof transport. Inspect new log call sites for proof leakage rather than invent new logging subsystem.
- **VALIDATE**: All lint/tests off/tests on/build/brand gates green; no regression baseline changes to hide failures; reviewer has no unresolved critical/high security defects; designer evidence attached. Only temporary isolated DB/loopback protocol fixtures used.

### Task 5.1: Trunk PR, first review turn and completion — Depends on 4.1

- **BATCH**: B5
- **ACTION**: Parent owns commit/push/PR/merge/cleanup/Linear lifecycle. Plan creator does none of these.
- **IMPLEMENT**: Conventional commit and PR against `master` from approved branch, body includes exact `Closes YAN-359` and `Closes #227`, scope/decisions/gates and off/on/latch evidence. Address first CodeRabbit review turn only (in-scope findings or explicit rationale), then require green required CI, squash merge, safe approved feature worktree/branch cleanup preserving untracked research and main checkout, verify merged state and set Linear YAN-359 Done.
- **MIRROR**: `CLAUDE.md:16-18,124`; `RELEASING.md:55-101,196`.
- **GOTCHA**: No endless CodeRabbit rounds, CI baseline bypass, release/backport actions, tags, publishing, CHANGELOG/RELEASING edit or removal of unrelated/untracked artifacts. Preserve plan/research before worktree removal; cleanup only after parent confirms merged/clean state.
- **VALIDATE**: Parent records master-base PR URL, required CI green on reviewed head, first-turn disposition, squash merge commit on master, preserved artifacts, worktree cleanup and Linear Done. Done requires merge/CI evidence, not plan structural validator success.

---

## Testing Strategy

Critical tests only. Extend existing protocol/settings/session fixtures and one new DB test file; no real IdP, new test framework, broad snapshots or speculative performance suite. Repository config isolates HOME/DATA_DIR per test file; reset env/modules/global caches using existing `load(state)` pattern and restore them on teardown.

### Unit Tests

| Test                            | Input                                                                                              | Expected Output                                                                                         | Edge Case? |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| Stable keys / non-linking email | No email; changed email; same email/different sub; same sub/different issuer                       | Same key resolves same user; collisions distinct, duplicate email NULL, emailAtLink retained            | Yes        |
| JIT role matrix                 | default pending/default user/admin match                                                           | Own personal workspace/identity; pending no cookie; admin match immediately IdP admin                   | No         |
| Admission first                 | Denied new/linked/owner with valid setup proof                                                     | No JIT/sync writes, no proof or setup-cookie consumption, no full cookie                                | Yes        |
| Group source precedence         | Present empty claim; absent claim/UserInfo; nested and scalar SAML key                             | Empty suppresses fetch; absent fetch once; bounded exact normalization                                  | Yes        |
| UserInfo trust                  | Correct sub without iss; wrong sub; optional wrong iss; HTTP/JSON/timeout/no endpoint              | No-iss accepted, failures denied before writes, no borrowed identity/email                              | Yes        |
| Provenance / sv                 | IdP promotion/loss; manual admin; same-role reassertion; manual update during async preflight      | Preserve manual admin, reassert clears source/revokes once; tx reads current source, no stale overwrite | Yes        |
| IdP membership diff             | Multiple groups same workspace; manual/invite collision; other user's rows                         | Highest IdP rank; non-IdP and other users untouched; personal owner kept                                | Yes        |
| Revocation                      | Role-only, memberships-only, both changed, unchanged                                               | Exactly +1/+1/+1/+0 sv; stale JWT denied; removal revokes workspace key                                 | Yes        |
| Rollback                        | Missing mapped workspace, personal target, last-manager remove/demotion, injected identity failure | Visible sync deny; role/membership/sv/key/user/identity/workspace changes rolled back                   | Yes        |
| Race                            | Two first logins same stable key; duplicate-email unique conflict                                  | One user/identity/personal workspace, bounded retry, no orphan loser                                    | Yes        |
| Disabled / no-login guard       | Disabled matched admin; requireLogin=false second active including pending                         | Never reactivate; SINGLE_USER_MODE denies visibly                                                       | Yes        |
| SAML trust                      | Missing issuer/NameID; transient NameID; signed issuer mismatch/replay                             | Denied; no JIT; existing request/signature guards retained                                              | Yes        |
| Gate matrix                     | Pristine off, on, hashed marker/off, invalid marker                                                | Pristine unchanged; on/latched enforce no fallback; invalid marker fail closed                          | Yes        |
| Policy boundary                 | on owner/admin/user/pending; off GET/PATCH/import/export                                           | Admin-only on; off keys absent/write 404; shared targets and bounds validated                           | Yes        |
| UX and hardening                | Pending route direct, safe errors, start responses, log sanitizer                                  | Generic on page/off404, no auth cookie, no-referrer enforced, setupToken redacted                       | Yes        |

### Edge Cases Checklist

- [ ] Absent vs empty claims distinguished; scalar strings exact, objects never coerced, unsafe names dropped.
- [ ] Bounds: depth 5, 100 groups/maps, 256-char strings; own-property lookup only.
- [ ] Same identity races roll back loser and sync winner, never lose manual/source change.
- [ ] Network failure/subject mismatch produces zero provisioning/sync writes.
- [ ] Pending never receives `auth_token` or display cookie; dashboard/API access remains denied.
- [ ] LAST_MANAGER on manager-to-viewer and removal aborts whole sync; missing target does not silently skip.
- [ ] Owner admission checked before proof consumption; owner sync immutable.
- [ ] Combined changes bump once; manual same-role IdP reassert bumps once; unchanged zero.
- [ ] Pristine-off parity explicitly includes zero UserInfo and no new OIDC limiter/headers; latched-off explicitly not legacy parity.
- [ ] Both protocols cannot be enabled simultaneously by any accepted auth mode; protocol flip replaces sole IdP authority.

## Validation Commands

Parent runs application commands from approved worktree. Do not set RUN_REAL/RUN_E2E; never run tests with alternate config or production HOME/DATA_DIR. New feature tests must pass, not merely join known-fails baseline.

### Static Analysis

```bash
npm run lint
npm run lint:brand
```

EXPECT: lint and brand guard exit 0; no new accessibility warnings. Plain JS repo has no separate typechecker; build validates imports.

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/sso-jit.test.js tests/unit/oidc-callback.test.js tests/unit/oidc-verify.test.js tests/unit/saml.test.js tests/unit/owner-bootstrap.test.js tests/unit/principal-sessions.test.js tests/unit/gateway-key-established-security.test.js tests/unit/settings-api-validation.test.js tests/unit/settings-config-export.test.js
```

EXPECT: critical new assertions pass under isolated config; fixtures control switch state with module reload. Existing password, auth-modes, login-limiter, SAML issuer-pin, route-policy and audit regressions covered by full suite.

### Full Test Suite

```bash
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run build
```

EXPECT: both known-fails regression gates and build exit 0. Record statuses individually, not final chained command only. Off run must include pristine/off and marker-latched/off explicit fixture cases; on suite cannot silently override every feature test to off.

### Database Validation

```bash
npx vitest run -c tests/vitest.config.js tests/unit/db-migration-chain.test.js tests/unit/db-migration-framework.test.js tests/unit/db-tenancy-schema.test.js tests/unit/tenancy-isolation.test.js
```

EXPECT: 011 upgrade/rerun/fresh parity, CHECK/foreign keys intact; synchronous rollback proves no orphan account/grants. No migration command against real DB.

### Browser Validation

```bash
mkdir -p /tmp/opencode/yan-359-browser
TOKENHOP_MULTI_USER=on DATA_DIR=/tmp/opencode/yan-359-browser PORT=20128 BASE_URL=http://localhost:20128 npm run dev
```

EXPECT: temporary-instance direct public `/login/pending` works without cookie; existing local fixture login reaches pending/active/deny correctly; no external IdP. Parent checks port availability first; use free port consistently if occupied. Stop server, restart same temporary instance with switch off for pending404, settings hidden and latched-security behavior; use separate fresh temporary directory for pristine-off comparisons. Browser may use existing fixture callbacks or test-backed mocked network; no production credentials/setup proofs.

### Manual Validation

1. Confirm PR branch/base and no unrelated tracked/untracked changes before execution.
2. Inspect active user's cookie via existing JWT verifier: own sub/current sv/personal wid/amr, not owner; pending/denied never calls full cookie writer.
3. Change fixture groups, log in again, check stale cookie and removed-workspace key denial; repeat unchanged and check no sv bump.
4. Deny owner with valid setup proof; assert DB proof and stashed cookie untouched. Admit owner, link proof once; subsequent identity lookup succeeds.
5. Designer reviews generic pending page and alert messages at 1440/1024/390, light/dark, keyboard and RTL.
6. Inspect safe audit fields and logged URLs; no raw claims, tokens, setupToken, XML or group names. Existing stdout one-time owner token remains explicit bootstrap behavior, not added request logging.

## Acceptance Criteria

- [ ] Stable OIDC issuer/sub and SAML issuer/NameID resolve own identities; no implicit email link or owner fallback in enforced path.
- [ ] All admitted new identities atomically JIT pending/user, matched admin group immediately IdP admin; disabled stays disabled.
- [ ] Every login applies allow-list including owner, before mutation/proof consumption.
- [ ] UserInfo absent-only fallback uses exact sub and optional-present issuer check, bounded timeout, no token persistence.
- [ ] Manual/invite memberships, manual admins and personal ownership preserved; explicit same-role manual reassertion clears provenance safely.
- [ ] Missing map target/last-manager failure rolls back all non-owner sync/provisioning and denies login.
- [ ] Role or membership changes bump sv once and invalidate caches; unchanged login does not; workspace key removal revocation retained.
- [ ] Pending page generic/public/on-only, no pending auth/display cookie or validator exception.
- [ ] Policy is bounded, admin-only instance API and hidden/rejected off, including config-import/export bypass checks; no YAN-373 editor.
- [ ] Pristine-off SSO shape/redirect parity proven separately from marker-latched-off enforcement; authModes single selected protocol verified.
- [ ] Required lint, off/on full tests, build and brand gates green; critical tests pass using isolated config and local fixtures.
- [ ] Designer and mandatory code-reviewer review complete; first CodeRabbit turn handled; required CI green before master squash merge.

## Completion Checklist

- [ ] Eight tasks completed with bounded dependency batches and single shared worktree; no conflicting parallel file writes.
- [ ] Code mirrors sync repository invariants, typed errors, safe audit and fixture test patterns; no new dependency/abstract framework.
- [ ] Parent records final HEAD, commands/results, UX/review evidence and approved deviations only.
- [ ] No baseline weakening, unrelated cleanup, locale translations, release/backport/publish actions or RELEASING/CHANGELOG changes.
- [ ] PR targets master and includes `Closes YAN-359` plus `Closes #227`.
- [ ] First CodeRabbit review turn addressed, required CI green, squash merged; no endless second review cycle.
- [ ] Plan/research preserved before safe worktree cleanup; unrelated untracked files untouched; Linear YAN-359 Done after merge evidence.
- [ ] Self-contained plan structural validator run; validation of plan is not validation of implementation.

## Risks

| Risk                                                      | Likelihood | Impact        | Mitigation                                                                                                     |
| --------------------------------------------------------- | ---------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| Enabled/latched owner fallback accidentally retained      | Medium     | Critical      | Missing-admission SSO returns null; separate gate-state tests; proxy-safe claim seam                           |
| UserInfo confused subject / optional issuer mishandled    | Medium     | Critical      | Exact sub, present-only iss check; fixture absent-iss positive and mismatch negatives                          |
| Async nested transactions / partial access                | Medium     | High          | Sync seams, all prerequisites before tx, injected rollback/race cases                                          |
| Manual same-role admin overwritten after slow network     | Medium     | High          | Clear source on explicit manual reassertion; tx current-row read; sv test                                      |
| Role+membership double sv / stale route-guard cache       | Medium     | High          | Service owns single bump; invalidate shared global cache after tx                                              |
| Deleted target or last manager silently retains privilege | Medium     | High          | Recheck IDs, guard demotion/removal, rollback+deny; no skip-on-error                                           |
| Rollout-hidden policy leaks via legacy/config path        | Medium     | High          | New-key gate before both PATCH branches; all response/export/preview projections tested                        |
| Pending UI requires session or leaks identity             | Low        | High          | Generic server page, no cookies/data fetch; designer public-page review                                        |
| Migration version collides after rebase                   | Low        | Medium        | Registry ends010 at inspection; next available number if parent rebase changes it; frozen migrations untouched |
| Multiple IdP assumption erases grants                     | Low        | Medium        | Current authModes exactly one protocol; latest successful selected protocol authority, no multi-IdP promise    |
| External deprovisioning latency                           | Certain    | Known ceiling | Sync occurs on next login, not webhook/background push; no claim of immediate upstream revocation              |

## Notes

- Research-business records all code blockers Done/merged into master at baseline; docs-only YAN-350 approval has no merge commit. Parent already owns prerequisite/ancestry validation, not plan creator.
- Existing repo session cache single-process ceiling is <=5 seconds for another process sharing DATA_DIR; same-process writes must invalidate immediately. Do not claim cross-process immediate revocation.
- Owner setup proof claim-before-link caveat remains pre-existing follow-up. Non-owner JIT and all IdP access changes are atomic; this plan does not promise owner bootstrap/proof resolver's entire historical flow is one transaction.
- All seven reports read; approved pending/provenance/owner admission/last-manager/map semantics supersede conflicting suggestions. No remaining product choice deferred to implementor.
