# Technical Research: YAN-359 — SSO identity linking and JIT provisioning with group → role/workspace mapping

Part of the YAN-359 feature research (`docs/plans/yan-359-sso-jit/`). Verified against worktree `.slim/worktrees/yan-359-sso-jit` @ `dcae2aa3` (users/yan-359-sso-jit branch). Scope is technical design: exact schemas, contracts, transactions, file map, verification. Business/practices/security details live in the sibling research files. Validation owner is the parent orchestrator.

## Executive Summary

The identity substrate YAN-359 builds on is already merged: `users`/`identities`/`workspaces`/`memberships` (migration 004), `sessionClaims()` with `sub`/`sv`/`wid`/`amr` (YAN-355), owner bootstrap + `resolveSsoUser` with `TOKENHOP_OWNER_EMAIL`/setup-token linking (YAN-356), the route → capability map (YAN-357), and the YAN-349/YAN-604 fixes in `oidc.js` (`resolveAuthModes`, HS256 acceptance). What's missing is exactly the YAN-359 delta: SSO callbacks today admit **only owner-linked identities** (`sessionClaims` returns `null` for any linked non-owner), there is no JIT provisioning, no groups claim reading, no UserInfo call anywhere, and SAML persists only email/name. The change is concentrated in four places: (1) new instance settings + validation for groups mapping, (2) a nested-path groups extractor + OIDC UserInfo fallback + SAML groups attribute, (3) one transactional JIT/login-sync module that provisions users and syncs `source='idp'` memberships while never touching manual rows or the owner, and (4) relaxing `sessionClaims` so linked non-owner users get their own principal while `pending` gets a bounded "awaiting approval" surface. No new API routes are required; the whole feature rides the existing public SSO callbacks and the instance settings route, and it is structurally inert while the multi-user switch is off because `sessionClaims` returns early before any new code runs.

## Current State (what YAN-359 inherits)

Flow trace, OIDC (`src/app/api/auth/oidc/callback/route.js`):

1. `GET /api/auth/oidc/callback` — state/nonce/PKCE cookie check → `getOidcRuntimeConfig()` (null unless `resolveAuthModes(settings).oidc` and configured) → discovery → `exchangeOidcCode` → `verifyOidcIdToken` (YAN-604: HS256 with client secret when discovery advertises only HS*, RS*/ES* via JWKS; nonce enforced manually).
2. Builds `identity = { provider:"oidc", issuer: payload.iss || discoveredIssuer, subject: payload.sub, email, emailVerified: payload.email_verified === true }`.
3. `takeSetupToken(cookieStore)` (YAN-356 `setup_token` cookie stashed by the start route).
4. `sessionClaims("oidc", identity, { setupToken })` → **null → redirect `/login?error=sso_not_linked`** (message exists in `src/app/login/loginErrors.js`).
5. Success: `setDashboardAuthCookie(...claims, oidc:true, oidcSub, oidcEmail, oidcName)` + `audit("auth.login")`.

SAML (`src/app/api/auth/saml/acs/route.js`): loginLimiter lock → `validateSamlResponse` (signed assertion, `InResponseTo` bound to `saml_state` cookie, in-flight replay guard) → `identity = { provider:"saml", issuer: profile.issuer, subject: profile.nameID, email, emailVerified: true }` (comment: signed-IdP email counts as verified for `TOKENHOP_OWNER_EMAIL`) → same `sessionClaims` path. **NameID is the only identifier kept; no attributes beyond email/name are extracted.**

`sessionClaims(method, identity, opts)` (`src/lib/users/session.js`):

```
securityOn() false → {}            // switch off: today's single admin, byte-identical
ensureOwnerBootstrap()
method ≠ pwd:
  linked = resolveSsoUser(identity, opts)     // bootstrap.js
  linked → user = getUserUnscoped(linked)
           user.status!=="active" || instanceRole!=="owner" → null   ← YAN-359 must relax this
!user:
  >1 active user → null                       // unlinked SSO refused once multi-user
  owner fallback (≤1 active user), mustChangePassword guard
→ { sub, sv, wid, amr:[method] }              // wid = personal workspace
```

`resolveSsoUser` (`src/lib/users/bootstrap.js`): `findIdentityUnscoped({provider, issuer, subject})` → linked userId. Else owner link **only** via `TOKENHOP_OWNER_EMAIL` (one-shot `_meta.ownerEmailConsumed`, requires `emailVerified === true`) or `consumeSetupToken` (SHA-256 in `_meta`, 60-min TTL, timing-safe, burned in one tx). Never first-login-wins. First SSO login of an unlinked identity with ≥2 active users = `null`.

Repos already available: `usersRepo` (`createUserUnscoped` — one tx: user + personal workspace + owner membership, `assertNotSingleUserMode` guard; `updateUserUnscoped` — OWNER_IMMUTABLE rules, `sessionVersion` bump on `instanceRole`/`status`/`passwordHash` change; `bumpSessionVersion`; `getSessionUserUnscoped` with the ≤5 s `globalThis.__tokenhopSessionCache`), `identitiesRepo` (`findIdentityUnscoped`, `linkIdentityUnscoped` → `IDENTITY_TAKEN` on UNIQUE race), `membershipsRepo` (add/update/remove with `source`, `assertNotLastManager`, `revokeUserApiKeysSync` on removal), `workspacesRepo` (`listWorkspaces` joins role), `auditRepo`/`audit()` (deny-by-default key allow-list, fire-and-forget).

RBAC (`src/lib/users/principal.js`): `can()` denies everything for `pending`; `self.session`/`gateway.use` bypass workspace checks. Route table `src/lib/auth/routePolicy.js` covers every `/api/*` route; a test fails the build on unmapped routes — YAN-359 adds no new routes, so no table churn.

Sessions (`dashboardSession.js`, ADR-0004): HS256 24 h, cookie `auth_token`; `validateSessionToken` rejects `instanceRole === "pending"` and `mustChangePassword` outright; legacy `sub`-less tokens resolve to owner while ≤1 active user.

Settings: single-row JSON blob (`settingsRepo.DEFAULT_SETTINGS`), validated by `src/app/api/settings/validateSettings.js` (enum/length checks, `AUTH_PATCH_KEYS` lockout guard), key classification in `src/lib/settings/settingsScope.js` (everything SSO is `instance` scope), `KNOWN_SETTING_KEYS` rejects unknown keys, secrets stripped via `SECRET_SETTING_KEYS`, `multiUserEnabled` deleted from responses. Gating: `securityOn()` = hashed-marker OR `isMultiUserEnabled()` — everything new must sit behind the early return in `sessionClaims` / after a `securityOn()` check, which the placement below gives for free.

## Architecture Design

### Component flow (target)

```
IdP ──id_token/assertion──▶ SSO callback (public route, unchanged policy row)
                             │ verify (existing, YAN-604)
                             │ extract groups: id_token claim → UserInfo fallback (OIDC)
                             │                configured attribute (SAML)
                             ▼
                 ssoLoginSync(identity, groups)          ← new module (src/lib/users/ssoJit.js)
                   1. linked identity? → its user (any role; never re-link)
                   2. else owner-link paths (existing resolveSsoUser: TOKENHOP_OWNER_EMAIL /
                      setup token) — unchanged, owner safety preserved
                   3. else JIT: allow-list check → provision (tx) with settings defaultRole
                   4. login-sync (tx): recompute role from adminGroups; diff
                      groupWorkspaceMap memberships vs source='idp' rows (add/update/remove)
                   5. audit auth.ssoJit / auth.ssoRoleChange / membership.add/remove
                             ▼
                 sessionClaims → { sub, sv, wid, amr } | pending-limited | null
                             ▼
                 setDashboardAuthCookie + audit auth.login (existing)
```

### New components

- **`src/lib/users/ssoJit.js`** (new, ~200 lines): pure-ish decision core `planSsoSync({ settings, groups, user })` → `{ roleChange?, membershipOps[] }`, plus the transactional `ssoLoginSyncUnscoped(identity, groups, opts)`. No route/UI code. Sits in the route bundle only (not the proxy bundle — bootstrap.js avoids oidc/saml imports for the proxy bundle; ssoJit must likewise import nothing from `lib/auth/oidc.js`/`saml.js`).
- **Groups extraction** (extend existing auth libs, no new module):
  - `src/lib/auth/oidc.js`: `getPath(claims, "a.b.c")` helper + `fetchOidcUserInfo({ userinfoEndpoint, accessToken })` → claims object (Bearer header, `cache:"no-store"`, non-JSON → throw).
  - `src/lib/auth/saml.js`: `pickSamlGroups(profile, settings)` mirroring `pickSamlEmail` (configured attribute first, then `profile.attributes[attr]`, then common names `groups`/`memberOf`), normalizing `string | string[]` (CSV split for IdPs that send `"a,b,c"`).
- **Settings keys + validation** (see Data Models). Admin-only writes via `/api/settings` PATCH (`instance.settings.manage` already the route cap); UI is YAN-373, out of scope here.

### Integration points

- Both callbacks (OIDC GET, SAML POST) gain ~15 lines: build `groups`, call `ssoLoginSyncUnscoped`, pass the outcome into `sessionClaims` (or replace the `resolveSsoUser` call inside `sessionClaims` with the sync result — see Technical Decisions D1).
- `sessionClaims`: replace the owner-only guard with: linked/JIT user active → mint claims; `pending` → pending-limited outcome; disabled → null. Keep the ≤1-active-user owner fallback for unlinked identities exactly as-is.
- `validateSessionToken` + `/api/auth/status`: admit a pending session (see D2) or keep rejecting and use `?error=account_pending` (message already exists). Principal already denies everything to `pending`.
- Audit: reuse `audit()` from `src/lib/users/audit.js`; add nothing to the allow-list unless new keys are needed (`groups` array would be useful — one-line addition, values are group names, not secrets).

## Data Models

### No schema migration needed

`users`, `identities`, `workspaces`, `memberships` (migration 004) already cover everything YAN-359 writes. Identity keys match the issue exactly:

- OIDC: `('oidc', payload.iss, payload.sub)` — issuer from the **verified** id_token (fallback `discovery.issuer`), subject `sub`. Both already produced by the callback.
- SAML: `('saml', profile.issuer, profile.nameID)` — `profile.issuer` is the IdP entity ID from the validated assertion. Gotcha: **transient NameIDs** (`nameIDFormat ...:transient`) mint a new identity per login → one user per login. Mitigation below (D6).
- `identities.emailAtLink` stores the email at link time (informational, never a matching key) — already implemented.

Membership sync writes only rows with `source='idp'` (`CHECK (source IN ('manual','invite','idp'))` already enforced). The personal-workspace membership (created by `createUserUnscoped`, `source='manual'`, `role='owner'`) is structurally out of scope for sync. `membershipsRepo.removeMembership` already cascades `revokeUserApiKeysSync` on removal — reuse the same call inside the sync transaction.

### New settings keys (instance scope, single-row blob — no DDL)

Follow the existing flat-key convention; all default to inert (no allow-list, no mapping, default role `pending`):

```js
// settingsRepo.DEFAULT_SETTINGS additions:
ssoGroupsClaim: "groups",        // nested path supported: "realm.access.groups"
ssoAllowedGroups: [],            // empty array = allow everyone (see D4)
ssoAdminGroups: [],              // membership grants instanceRole 'admin'
ssoGroupWorkspaceMap: {},        // { [groupName]: { workspace: "<name|id>", role: "member" } }
ssoDefaultRole: "pending",       // JIT role: 'pending' | 'user'
```

Validation (`validateSettings.js`, `validSecuritySettings` + `KNOWN_SETTING_KEYS` + `settingsScope.classifyKey` — they land in default `instance`):

- `ssoGroupsClaim`, per-key text ≤ `MAX_TEXT_LEN`, must not contain `..`/`[` (plain dot-path only).
- `ssoAllowedGroups`/`ssoAdminGroups`: arrays of non-empty strings (≤100 entries, ≤128 chars each, deduped, no secrets).
- `ssoGroupWorkspaceMap`: object; values `{ workspace: string, role ∈ {owner,manager,member,viewer} }`; reject `owner` (an IdP group must not be able to hand out workspace ownership — admin action only); ≤100 entries.
- `ssoDefaultRole ∈ {"pending","user"}` (never `admin`/`owner`).
- Lockout interplay: these keys do **not** join `AUTH_PATCH_KEYS` (they cannot lock out password login; a bad allow-list locks SSO users out with a visible message, which is the intended behavior).

Group → workspace resolution at sync time: accept `workspace` as workspace **id or name** (name is what an admin configures before the workspace exists; resolve per login via `workspacesRepo`; unresolved → skip that group, `console.warn` + audit `result:"failure"` — never fail the login for a stale mapping).

No new tables, no migration file, no `_meta` keys. (`_meta.ownerEmailConsumed` / setup-token hashes already exist.)

### Transactions

All writes are single-transaction, adapter-level (`db.transaction`), matching repo style. Two new transactional functions in `ssoJit.js`, both using only existing repo primitives composed inside one tx (the repos' own audited public wrappers take `ctx` and can't be reused mid-login; reuse their internal SQL patterns instead):

**1. `provisionSsoUserUnscoped({ identity, role, email, displayName, username })`** — one `db.transaction`:

```
INSERT user (id=uuid, email?, username?, displayName, instanceRole=role, status='active')
INSERT personal workspace + owner membership          (same shape as createUserUnscoped)
INSERT identities (provider, issuer, subject, emailAtLink=email, lastLoginAt=now)
UPDATE users.lastLoginAt = now
-- UNIQUE(provider,issuer,subject) races: catch → IDENTITY_TAKEN → re-read
-- findIdentityUnscoped → return winner's userId (idempotent under concurrency)
-- users.email UNIQUE races: on EMAIL_TAKEN, retry with email=NULL (email is
--   display/`emailAtLink` only; never a linking key), keep emailAtLink
```

Note: `assertNotSingleUserMode` semantics must be honored — if `requireLogin === false`, refuse JIT (throw `SINGLE_USER_MODE` → login rejected `sso_not_allowed`): a provisioned user would flip `multiUserActive()` and lock the owner out of `requireLogin=false`. Also `status:'active'` + `instanceRole:'pending'` still counts toward `countActiveUsersUnscoped()` (query is `status='active'`) — accepted, it is a real account awaiting approval; document in the pending-page decision.

**2. `syncSsoLoginUnscoped(userId, groups, settings)`** — one `db.transaction`:

```
owner row? → skip all writes (owner role/memberships are manual by definition)
role:      desired = groups ∩ ssoAdminGroups ≠ ∅ ? 'admin' : null
           if user.instanceRole==='admin' && desired===null → demote to 'user'
              (UPDATE users SET instanceRole — reuses the SESSION_FIELDS sv bump;
               only via raw UPDATE here; updateUserUnscoped's tx cannot nest)
           if desired==='admin' && role in ('user') → promote; never touch
              'pending' (approval is an admin action, YAN-360) or 'owner'
           roleChanged → sessionVersion = sessionVersion + 1  (revokes; ADR-0004)
memberships (shared workspaces only):
   desired = ∪ over groups of map[group] → {workspaceId, role}   (resolved rows only)
   current = SELECT * FROM memberships WHERE userId=? AND source='idp'
   add:    INSERT (source='idp', role, createdAt)          — skip if a manual/invite
                                                          row already exists for that
                                                          (workspaceId,userId): PK conflict
                                                          → keep manual, do not downgrade
   update: role differs → UPDATE role (idp rows only)
   remove: current idp rows not in desired → guard assertNotLastManager-shaped check
           (skip removal when the workspace would lose its last owner/manager),
           DELETE + revokeUserApiKeysSync(db, userId, { workspaceId, now })
   personal workspace rows are source='manual' → never selected
audit (fire-and-forget, outside tx): auth.ssoJit, auth.ssoRoleChange,
   membership.add / membership.remove / membership.roleChange with principal=null
   (system), matching the bootstrap.js audit style
```

Return `{ user, roleChanged, membershipOps }` so the caller can decide on the session outcome (a demoted-from-admin user still logs in; `sv` was bumped so any _other_ live tokens die, the fresh cookie carries the new `sv`).

Ordering inside a login (the single entry point `ssoLoginSyncUnscoped`):

```
linked = findIdentityUnscoped(identity)        → syncSsoLoginUnscoped(linked.userId, …)
owner  = resolveSsoUser remaining paths        → owner: sync skipped; mint owner claims
not linked, not owner-asserted:
   allowed = ssoAllowedGroups.length===0 || groups ∩ allowed ≠ ∅
   !allowed → { rejected: true }               → /login?error=sso_not_allowed
   provision → syncSsoLoginUnscoped(newId, …)
```

This preserves owner safety exactly: JIT never runs for an identity the owner-link paths would claim, `TOKENHOP_OWNER_EMAIL`/setup-token keep their one-shot semantics, and the owner row is never written by sync.

## API Design

No new endpoints (route table stays untouched — `route-policy.test.js` keeps passing unchanged). Contract deltas:

### OIDC callback (`GET /api/auth/oidc/callback`) — outcomes

| Case                                          | Redirect                                         | Cookie                                                   |
| --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| linked/JIT user, active, role user/admin      | `/dashboard`                                     | full `auth_token` (`sub`,`sv`,`wid`,`amr:["oidc"]`)      |
| provisioned/linked user, role `pending`       | `/pending` (D2)                                  | limited session (or no cookie, `?error=account_pending`) |
| outside `ssoAllowedGroups`                    | `/login?error=sso_not_allowed`                   | none                                                     |
| user `disabled`                               | `/login?error=account_disabled` (message exists) | none                                                     |
| unlinked, ≥2 active users, no owner assertion | `/login?error=sso_not_linked` (existing)         | none                                                     |
| verify/state/config failure                   | existing codes                                   | none                                                     |

SAML ACS identical with `amr:["saml"]` and `saml_*` codes. New loginErrors entries (`src/app/login/loginErrors.js`): `sso_not_allowed` ("Your account is not in an allowed single sign-on group."), plus the pending surface's message. Unknown codes already fall back to a generic message, so old servers + new UI stay safe.

### Settings PATCH (`/api/settings`) — additive keys

`PATCH { ssoAdminGroups: ["admins"] }` → 200, audited via existing settings audit; unknown/invalid shapes → 400 from `validateSettingsBody` (add cases to `validSecuritySettings`). Reads via GET `/api/settings` return the new keys (not secrets, no `SECRET_SETTING_KEYS` additions). While the switch is off the UI must not expose them (YAN-373's job), but accepting them server-side is harmless: nothing reads them until `securityOn()`.

### `/api/auth/status` — pending surface

If D2 (limited session) is chosen: add `pending: true` + `principal: { role: "pending" }` for pending sessions so the UI can route to `/pending`. The `describePrincipal` shape already carries `role`; only the `pending` boolean is new.

## System Constraints

- **Owner safety (inviolable):** `resolveSsoUser`'s link order and one-shot semantics stay untouched; sync never writes the owner row; `updateUserUnscoped`'s OWNER_IMMUTABLE rules remain the backstop; `transferOwnership` is the only owner-role path. Negative test: "first SSO login is NOT owner" already exists in the YAN-356 test set — keep it green.
- **Manual ownership preserved:** sync selects only `source='idp'` rows for update/delete; manual/invite rows block an idp insert on the PK rather than being overwritten; the last-manager guard skips removals that would orphan a shared workspace.
- **Switch-off byte-compatibility:** every new code path sits behind `securityOn()`/`sessionClaims`'s early return; OIDC/SAML callbacks with the switch off produce byte-identical redirects and cookies. `ssoJit.js` must not be imported by `dashboardGuard`/proxy-bundle modules (bootstrap.js precedent).
- **Concurrency:** UNIQUE `(provider, issuer, subject)` serializes JIT races (loser re-reads the winner); `users.email` UNIQUE handled by the email-NULL retry (email is never a security key); SAML replay already guarded (`inFlightRequestIds`).
- **Rate limiting:** SAML ACS already runs the login limiter; OIDC callback does not (provider-verified, no guessable secret). Add `recordFail`/`checkLock` to the OIDC callback's rejection paths (allow-list rejects) for parity — cheap, keyed by IP.
- **Performance:** per-login cost = 1 settings read (already cached by `getSettings`), 1 identity lookup, 1 tx of ≤ small-diff membership writes, 1 `fetchOidcUserInfo` **only when the groups claim is absent from the id_token** (authentik default) — cache discovery per issuer in-process (10–60 s) if profiling demands; don't preemptively.
- **Audit:** every sync outcome writes an audit row; scrub allow-list covers `provider`,`role`,`status`,`workspaceId`,`userId`,`reason`; add `groups` only if needed (strings, non-secret).
- **File-size guard:** settings route is already 521 lines — put new validation in `validateSettings.js`, not the route. `session.js` is 381 lines; the `sessionClaims` change is a guard swap, keep it small.

## Codebase Changes

Files to create:

| File                                                  | Purpose                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/users/ssoJit.js`                             | `planSsoSync`, `provisionSsoUserUnscoped`, `syncSsoLoginUnscoped`, `ssoLoginSyncUnscoped` (link order + owner safety)              |
| `src/app/(dashboard)/pending/page.js` (only under D2) | "Waiting for approval" page (static, no data fetch, i18n strings)                                                                  |
| `tests/unit/sso-jit.test.js`                          | JIT roles, allow-list, admin promote/demote, idp-vs-manual sync, no-email linking, race (IDENTITY_TAKEN), SINGLE_USER_MODE refusal |
| `tests/unit/sso-groups.test.js`                       | `getPath`, `pickSamlGroups`, UserInfo fallback decision (id_token absent vs empty), CSV/array normalization                        |

Files to modify:

| File                                                            | Change                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/lib/auth/oidc.js`                                          | `getPath`, `fetchOidcUserInfo`, maybe `extractOidcGroups(payload, settings)`                        |
| `src/lib/auth/saml.js`                                          | `pickSamlGroups(profile, settings)`; pass-through of `profile.attributes` already exists            |
| `src/app/api/auth/oidc/callback/route.js`                       | groups extraction (id_token → UserInfo), `ssoLoginSyncUnscoped`, outcome mapping                    |
| `src/app/api/auth/saml/acs/route.js`                            | same with `pickSamlGroups`; keep loginLimiter calls on new reject paths                             |
| `src/lib/users/session.js`                                      | `sessionClaims`: accept linked active non-owner users; pending outcome; keep ≤1-user owner fallback |
| `src/lib/users/bootstrap.js`                                    | none required (owner paths intact); optional: export `resolveSsoUser` result reason for audit       |
| `src/lib/db/repos/settingsRepo.js`                              | `DEFAULT_SETTINGS` + 5 keys                                                                         |
| `src/app/api/settings/validateSettings.js`                      | validation cases + `KNOWN_SETTING_KEYS` additions                                                   |
| `src/app/login/loginErrors.js`                                  | `sso_not_allowed` (+ pending message if D2 uses redirect)                                           |
| `src/lib/users/session.js` / `src/app/api/auth/status/route.js` | pending-session admission + `pending` field (D2 only)                                               |
| `i18n/*`                                                        | new strings (follow the existing translate-commits pattern)                                         |

No changes: `schema.js`, `migrations/`, `routePolicy.js`, `dashboardGuard.js` (pages under `/dashboard` already require a session; `/pending` needs a row only if it must be protected — static page can be public-safe with no data), `principal.js`, `usersRepo`/`membershipsRepo`/`identitiesRepo` public surfaces.

## Technical Decisions

- **D1 — sync inside `sessionClaims` vs in the callback.** Recommend: callbacks call `ssoLoginSyncUnscoped` first and pass its `{ userId, roleChanged, ... }` into an extended `sessionClaims(method, identity, { sync })`. Rationale: `sessionClaims` is also the password path; keeping SSO-specific sync out of it avoids importing `ssoJit` (and transitively settings shapes) into the proxy-adjacent session module; `revokeOwnerSessions` and `/api/auth/login` keep their current shapes. Alternative (sync inside `sessionClaims`) touches one file but couples login paths; rejected for bundle hygiene.
- **D2 — pending UX.** Recommend the **login-page message first** (`/login?error=account_pending`, string already shipped; zero session-model change), with a dedicated `/pending` page as a stretch: mint a limited cookie only if product wants the page to show _who_ they are. If the page ships: `validateSessionToken` returns `{ user, payload, pending: true }` for pending users (mustChangePassword check stays), principal stays as-is (`can()` already denies everything), dashboard layout redirects `instanceRole==="pending"` → `/pending`. Deviation risk: the issue text says "pending users see a 'waiting for approval' page" — flag for the parent to validate whether the login-page variant satisfies acceptance.
- **D3 — sv bump on membership-only change.** `principalFor` rebuilds `workspaceIds`/`activeWorkspaceId` from `memberships` on every request, so idp membership add/remove takes effect immediately with **no** bump; only `instanceRole` changes bump (already via the SESSION_FIELDS path). The issue says "bump sv when role or memberships change" — implement the bump only for role (correctness) and document the immediate-effect rationale for memberships; parent validates the deviation. Bumping on every login's group churn would log users out of other devices for no security gain.
- **D4 — empty allow-list semantics.** `[]` = allow all (opt-in restriction, matches how the feature must behave for existing single-IdP installs that never configure groups). Alternative (deny all) bricks every existing SSO login the moment the keys default in — rejected.
- **D5 — admin demotion.** `adminGroups` absence demotes `admin → user` deterministically (owner/pending untouched). Manual admin grants get demoted at that user's next SSO login — acceptable and audited; record in the PR's Decisions section. Alternative (track role source) adds a column for a corner case — YAGNI.
- **D6 — SAML transient NameIDs.** Document + warn: with `urn:...:name-id-format:transient` each login JITs a fresh user. Detect (node-saml exposes the format) and reject with `saml_acs_failed` + a specific log line when `ssoNameIdTransient !== "allow"`… simplest: always reject transient with a clear server log message and the existing generic UI error; admin fixes the IdP to persistent. No setting (YAGNI).
- **D7 — groupWorkspaceMap role domain.** Reject `owner` in validation (an IdP group granting workspace ownership breaks the "sharing is an explicit admin action" model); `manager|member|viewer` allowed.
- **D8 — UserInfo fallback trigger.** Fallback runs when the configured claim path is **absent** from the id_token (not when it resolves to an empty array — an empty group list is a real answer with allow-list consequences). Key-presence check, not truthiness.
- **D9 — reuse `resolveAuthModes`** per the issue's binding note; do not re-implement mode gating. YAN-604's `verifyOidcIdToken`/`summarizeOidcSigning` stay untouched.

## Verification Affordances

- **Gate commands** (worktree root): `npm run lint`, `npm test` (run only via `npm test` / `tests/` per CLAUDE.md — the config isolates `HOME`), both with `TOKENHOP_MULTI_USER=off` and `=on` (the CI gate; handbook §5), `npm run build`, `npm run lint:brand`.
- **Existing tests that must stay green:** `tests/unit/oidc-callback.test.js` (HS256 wiring; extend its `stubIdp` shape with a `userinfo_endpoint`), `oidc-verify.test.js`, `saml.test.js`, `saml-issuer-pin.test.js`, `owner-bootstrap.test.js` (incl. the "first SSO login is NOT owner" negative), `principal-sessions.test.js`, `password-login.test.js`, `auth-modes.test.js`, `login-limiter.test.js`, `route-policy.test.js`, `audit-auth-events.test.js`.
- **New tests per issue checklist:** JIT with each `ssoDefaultRole`; allow-list rejection; admin-group promote **and** demote (incl. owner-untouched, pending-untouched); idp add/update/remove preserving `manual`/`invite` rows (the Open WebUI pitfall); linking without email (no-email identity links by `(issuer, sub)` alone); UserInfo fallback (claim absent → fetch; claim present-but-empty → no fetch); SAML NameID identity + transient rejection. Fixtures: OIDC RS256 JWKS + HS256 local fixtures already exist in the test set — reuse; SAML signed-response fixtures follow `saml.test.js`.
- **Single-user regression:** switch off → OIDC/SAML callbacks byte-identical (redirect target, cookie claims) — assert against the current expected values captured in `oidc-callback.test.js`.
- **Manual flow check** (temp `DATA_DIR`): authentik-style IdP or a local fixture server; verify owner-link via setup token still prints/consumes once, and a second SSO user gets `pending` (default) with no capabilities (`/api/*` → 403/404 per route table, `principal === {role:"pending"}`).
- **Definition-of-done hooks:** cross-workspace negative test for every membership write (user B's manual row untouched by user A's sync); no secret material in any new response/log/audit row; no new dependencies (issue forbids without maintainer approval — `jose`/`@node-saml/node-saml`/`bcryptjs` already in tree cover everything).

## Open Questions (for the parent / maintainer)

1. D2: does a login-page "waiting for approval" message satisfy "pending users see a page", or is `/pending` required for acceptance?
2. D3: confirm the no-bump-on-membership-only-change deviation from the issue's "bump sv when role or memberships change".
3. Should a JIT-provisioned user count toward `multiUserActive()` while still `pending` (current query says yes — it flips the single-user UI early)? Cheap alternative: count only `instanceRole != 'pending'`.
4. `ssoGroupsClaim` is shared by OIDC and SAML (issue wording implies one setting) vs separate `samlAttributeGroups` — recommend shared `ssoGroupsClaim` for OIDC paths + `pickSamlGroups` honoring it as the attribute name; confirm.
5. Does YAN-373 (SSO mapping UI) need these keys mirrored into the config export/import allow-lists (`settingsConfigDoc.js` / `configExport.js`) now, or when that issue lands?

## Other Docs

- `docs/users/README.md` §4 (target model), §5 (switch/trunk landing), §8 (definition of done) — main checkout (docs/ is gitignored)
- `docs/users/spec.md` decisions 3 (identity) and 4 (sessions)
- `docs/users/adr/0003-identity-and-bootstrap.md`, `0004-sessions.md`, `0002-roles-and-capabilities.md`, `0001-tenancy-model.md`
- Linear YAN-359 (full description + binding design decisions), blockers YAN-356/357/349/604
- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `RELEASING.md`
