# Implementation Plan: YAN-358 Multi-account Password Login

## Overview

Implement GitHub #226 / YAN-358: account-aware password login, self-service password rotation, and admin temporary passwords without granting dashboard access before mandatory rotation. Preserve pristine switch-off behavior, owner recovery, tunnel restrictions, and established-security enforcement after rollout switches off.

Research baseline: branch `users/yan-358-password-login`, `origin/master` at `c34db1b7`. Read worktree `CLAUDE.md`, `RELEASING.md`, `docs/ARCHITECTURE.md`; accepted `docs/users/spec.md`, ADR-0003 and ADR-0004 were read from parent checkout because ignored `docs/users/` is absent from this worktree. PR targets `master`, release v1.1.0, no backport. All implementation stays in `/home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-users-password-login`; no releases, changelog, version bump, or other-worktree edits.

## Requirements

- `POST /api/auth/login` accepts `{ login, password }`; `login` resolves email or username. **Field name decision: `login` only** (issue #226 wording). `account` is not read; UX lane renames its state/body key (input keeps `name="username"` for autofill). Not accepting both avoids conflicting-field ambiguity. Missing identifier means owner only when `multiUserActive()` is false. A supplied unknown identifier never falls back to owner.
- Successful login mints the resolved user's `sub`, `sv`, personal `wid`, and `amr: ["pwd"]`; never default owner claims for another account. Refuse disabled and `instanceRole: "pending"` users.
- Unknown account, passwordless account (no hash, except owner null-hash recovery fallback), ambiguous identifier, and wrong password (for any account status) return byte-identical 401 `{ "error": "Invalid email/username or password.", "code": "invalid_credentials" }` with identical headers. No per-account counters (`remainingBeforeLock` dropped in established mode). Unknown/passwordless account runs async `bcrypt.compare` against a dummy hash of the same cost (10, matching `bcrypt.genSalt(10)` in `src/app/api/settings/route.js`). Pending/disabled accounts always run real compare first. Do not expose DB/hash errors or account existence.
- **Pending/disabled are distinct only after the correct password is verified:** 403 `account_disabled` (precedence) or `account_pending`, no cookies of any kind. Leaks status only to someone already holding the password. Correct-password status refusal neither records a limiter failure nor clears account/IP buckets. Wrong password on pending/disabled stays generic 401 and records failure.
- Enforce separate IP and account lockouts, not one IP-account pair. Both locks checked **before** any bcrypt work. Unknown identifiers count under a normalized-identifier key (trim + lowercase, separate namespace), so behavior matches existing accounts. Limiter map is bounded (hard cap with oldest-first eviction plus expiry pruning) against memory exhaustion via random identifiers. Preserve trusted-peer IP extraction and existing single-argument SAML limiter calls.
- All bcrypt work async (`bcrypt.compare`/`bcrypt.hash`); never `*Sync` on request path.
- Preserve configured tunnel/Tailscale dashboard restrictions and `resolveAuthModes` SSO-only behavior, including existing unconfigured-SSO recovery fallback. Public default `123456` must never mint any remote session, including restricted sessions and stored/default-env variants.
- Self-service password change requires an actual live browser session and current password. Rotate only that principal, bump `sessionVersion`, invalidate cache, and revoke old sessions immediately in-process.
- Admin temporary password persists mandatory-change state, bumps `sv`, and only grants a short-lived password-change credential on next login. No dashboard/settings/API authority before rotation.
- Preserve existing host CLI `POST /api/auth/reset-password` owner-only recovery semantics and local/CLI policy. Reset must revoke sessions and require secure rotation after activation.
- New passwords: at least **8** characters (Unicode code points); reject when installed `bcrypt.truncates(password)` is true (>72 UTF-8 bytes), never silently truncate. No trimming, no composition rules. Reject equality with current password, the temporary password being replaced, configured `INITIAL_PASSWORD`, and public default `123456`. Minimum applies to new/temporary passwords, not verification of existing legacy credentials.
- **Length decision (ASVS 8/15 guidance supplied by librarian):** ASVS requires minimum 8 and recommends 15. Existing UI enforces only non-empty, so 8 is the smallest step that meets ASVS without locking out owners rotating today. UI hint recommends 15+. `ponytail:` single `MIN_PASSWORD_LENGTH` constant in `src/lib/auth/userPassword.js`; raise to 15 when product accepts it (one-line change plus test fixture). Max: ASVS asks to allow ≥64 characters; 72-byte cap allows 64 ASCII characters but may reject long multibyte passphrases. Documented limit, error message names the byte cap.
- No dependencies. Add explicit routePolicy rows for every new API route. New functionality hidden on pristine switch-off installs; `isUserSecurityEnforced()` remains authoritative after durable activation, regardless of rollout flag.
- UI: identifier appears only when `multiUserActive`; preserve allowlisted query error messages; forced-change form cannot depend on full dashboard authentication. Self-service form must be reachable by ordinary users, not only instance settings managers.

## Architecture Changes

### Decisions and alternatives

- **Persistence:** add `users.mustChangePassword INTEGER NOT NULL DEFAULT 0 CHECK (mustChangePassword IN (0, 1))` through `src/lib/db/migrations/007-user-password-change.js`, register in `src/lib/db/migrations/index.js`, and match `src/lib/db/schema.js`. Prefer one column over identities metadata, settings-per-user blobs, or a sessions table. Historical migrations remain frozen. Existing migration runner provides transaction, backup, and schema-chain checks.
- **Restricted credential:** issued only alongside login's 403 `password_change_required` response (never with 200). Separate `password_change_token` httpOnly, SameSite=strict cookie, path `/api/auth` (reaches only `change-password`, `status`, `logout`; never dashboard or other APIs), 10-minute expiry, `secure` per existing `shouldUseSecureCookie`, existing JWT secret/HS256. Claims contain `sub`, `sv`, `amr: ["pwd"]`, `purpose: "password-change"`, `authenticated: false`; no workspace claims or full `auth_token`. Prefer this over giving temporary-password holders dashboard JWTs or inventing server-side sessions. Clear any prior full auth cookie when issuing challenge; clear challenge after rotation/logout.
- **Handler-level enforcement, not proxy only:** route handlers must reject restricted sessions themselves. `resolvePrincipal`, `getPrincipal`, `authorize`, `isLiveSession`, `hasValidSession` and comboProbe's fallback all reject challenge-purpose tokens and users with `mustChangePassword = 1`, so a handler invoked without the proxy (direct import in tests, future middleware misconfig, rewrite edge cases) still denies. Proxy check is defense in depth.
- **Authority:** normal token verification rejects restricted purpose even on pristine switch-off paths. Normal user-session resolution rejects pending/disabled/mandatory-change users, including legacy owner tokens. Dedicated restricted-token validation verifies signature/expiry, exact purpose, active approved user, matching `sv`, and persisted mandatory-change state; never calls `getPrincipal()` to grant dashboard authority. Unknown purposes fail closed.
- **Rollout:** reuse `isUserSecurityEnforced()` and existing durable hashed-security marker; do not invent a second latch. Change `multiUserActive()` to test established security before counts so identifier omission cannot become an owner shortcut after flag-off. Auth status must use established-security validation, not raw signed-token truthiness while flag-off. Hide new password management only when security is genuinely pristine/off.
- **Credential writes:** narrow repo helper atomically updates hash, mandatory-change state, `sv`, timestamp, and owner `settings.password` mirror. Await hashing before synchronous DB transaction. Recheck expected `sv`/old hash and eligibility inside transaction; stale concurrent requests fail without writing. Drop session cache after commit; honor adapter durable-flush contract before reporting success. This avoids current owner-first/settings-second split writes.
- **Lookup:** parameterized email-or-username query using existing SQLite `COLLATE NOCASE`, trimmed identifier, distinct users, at most two matches. Cross-field email/username collision fails generically rather than selecting arbitrary account. Never link password accounts by SSO email. Account limiter key uses resolved user ID, so email/username aliases share failures; unknown identifiers use normalized identifier keys in separate namespace.
- **Password service:** new `src/lib/auth/userPassword.js` holds credential resolution, existing-bcrypt/dummy comparison, shared new-password policy, and rotation/reset service. Reuse `bcryptjs`, existing `jose`, DB repos, and cookies; no generic auth framework. Owner with null hash alone may use `INITIAL_PASSWORD`/default recovery fallback.
- **New endpoints:** `POST /api/auth/change-password` with `{ currentPassword, newPassword }` accepts full self-session or validated restricted session. `POST /api/users/[id]/password` with `{ password }` sets temporary password under `instance.users.manage`. Both forbid CLI/local implicit principals as browser-session substitutes, enforce JSON/body limits and same-origin browser mutation checks, and return no-store responses. Self route ignores/rejects target-user fields; subject comes only from verified credential.
- **Admin scope decision:** owner may reset other non-owner users/admins; admin may reset ordinary/pending users, never owner or peer admin. Reject self-reset through admin route; use current-password self-service instead. Disabled/pending targets remain disabled/pending after reset. Full invitation/lifecycle CRUD and admin UI stay with YAN-360/YAN-373.

### API contract (reconciled with `docs/prps/plans/yan-358-ux.md`)

UX doc assumptions superseded here: body key `login` not `account`; restricted flow uses concrete `POST /api/auth/change-password`, not `PATCH /api/settings`; temp-password 403 carries `code: "password_change_required"`. All responses `Cache-Control: no-store`. `error` = display text, `code` = stable machine key; codes match `loginErrors.js` MESSAGES keys.

**`GET /api/auth/status`** adds (established security only; absent on pristine off): `multiUserActive: boolean`, `userSecurityEnforced: true`, `mustChangePassword: boolean` (true only for live challenge cookie; `authenticated` then false). UI treats absent = false.

**`POST /api/auth/login`** body `{ login?: string, password: string }` (`login` ≤ 320 chars, `password` ≤ 1024 chars, else 400).

| Case                                                        | Status | Body                                                                                                                                                                                     | Cookies                                           |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Success                                                     | 200    | `{ success: true, mustChangePassword: false, startPage }`                                                                                                                                | `auth_token` set                                  |
| Unknown / ambiguous / no hash / wrong password (any status) | 401    | `{ error: "Invalid email/username or password.", code: "invalid_credentials" }`                                                                                                          | none                                              |
| Missing `login` while `multiUserActive`                     | 401    | same `invalid_credentials` body                                                                                                                                                          | none                                              |
| Correct password, disabled                                  | 403    | `{ error: "This account has been disabled by an admin.", code: "account_disabled" }`                                                                                                     | none                                              |
| Correct password, pending                                   | 403    | `{ error: "This account is waiting for an admin to approve it.", code: "account_pending" }`                                                                                              | none                                              |
| Correct password, `mustChangePassword`                      | 403    | `{ error: "Your password must be changed before you can sign in.", code: "password_change_required", mustChangePassword: true, reason: "temporary" \| "initial", passwordMinLength: 8 }` | `password_change_token` set; `auth_token` deleted |
| Remote public default                                       | 403    | `{ error: <existing text>, code: "default_password_remote", mustChangePassword: true }`                                                                                                  | none                                              |
| Locked (IP or account)                                      | 429    | existing shape `{ error, retryAfter, resetHint }` + `Retry-After`                                                                                                                        | none                                              |
| Tunnel / SSO-only                                           | 403    | existing bodies                                                                                                                                                                          | none                                              |
| Malformed                                                   | 400    | `{ error: "Invalid request", code: "invalid_request" }`                                                                                                                                  | none                                              |

Pending/disabled status checked only after `bcrypt.compare` succeeds; disabled wins over pending. `default_password_remote` keeps legacy `mustChangePassword: true` for backward compat, but UI must branch on `code` and show local-recovery guidance, never the change form (no challenge cookie exists).

**`POST /api/auth/change-password`** (concrete restricted route) body `{ currentPassword: string, newPassword: string }`; any extra field (`login`, `userId`, `account`) → 400. Subject comes only from `password_change_token` (restricted) or `auth_token` (self-service); restricted wins if both valid and they name different subjects → 401 and both cleared.

| Case                              | Status    | Body                                                                                                      | Cookies                                             |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Success                           | 200       | `{ success: true, startPage }`                                                                            | fresh `auth_token`; `password_change_token` deleted |
| No / expired / revoked credential | 401       | `{ error: "Your password change session expired. Sign in again.", code: "password_change_expired" }`      | both cleared                                        |
| Wrong current password            | 401       | `{ error: "Invalid current password", code: "invalid_current_password" }`                                 | unchanged                                           |
| Policy failure                    | 400       | `{ error, code: "password_too_short" \| "password_too_long" \| "password_reused" \| "password_default" }` | unchanged                                           |
| Locked                            | 429       | limiter shape                                                                                             | unchanged                                           |
| Cross-origin / not JSON           | 403 / 415 | `{ error, code }`                                                                                         | unchanged                                           |
| Pristine off                      | 404       | `requireMultiUser`-style                                                                                  | —                                                   |

Restricted form keeps the typed temporary password in React memory and sends it as `currentPassword`; form shows New + Confirm only. If memory lost (reload while status says `mustChangePassword`), form adds a `Temporary password` field. Self-service form always shows Current + New + Confirm. Same endpoint, same body.

**`POST /api/users/[id]/password`** body `{ password: string }` → 200 `{ success: true }`; 403 `forbidden_target`; 404 unknown user; 400 policy codes. Admin API only, no UI this issue.

### Existing red flags to address narrowly

- `src/app/api/auth/login/route.js:114-115` always calls owner-oriented `sessionClaims("pwd")`; current catch returns raw exception messages.
- `src/lib/users/session.js:72-88` does not reject pending roles or mandatory-change state; raw-token fallback in `src/sse/services/comboProbe.js:121-148` can bypass principal restrictions.
- `src/app/api/auth/status/route.js:35-44` checks rollout rather than durable security; `multiUserActive()` currently returns false immediately with switch off.
- `src/app/api/settings/route.js:420-457` can change owner password through settings-manager permission; null-hash check ignores `INITIAL_PASSWORD`, no minimum exists, and owner/settings writes are separate.
- `src/app/login/page.js` has dead remote-default forced-change flow using privileged `PATCH /api/settings`; login/settings functions already large. Replace password branches with narrow helpers, not unrelated refactors.
- `src/lib/db/helpers/gatewayKeyTransfer.js` exports users via `SELECT *` but imports explicit columns. Without updating import, forced-change state disappears on restore.

### Before / after UX

| Flow                   | Before                          | After                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pristine switch off    | Owner password-only login       | Same presentation and owner behavior; public-default remote refusal retained                                                                                                                                                             |
| Activated multi-user   | Shared owner password           | Email/username + password; resolved-account dashboard; generic credential failure                                                                                                                                                        |
| Activated single-owner | Password-only owner             | Identifier optional; hidden input; supplied identifier still resolved explicitly                                                                                                                                                         |
| Temporary password     | No durable forced-change state  | Login 403 `password_change_required`; restricted card "Changing password for {login}" with New + Confirm (temp password reused from memory); reload restores challenge and adds Temporary password field; no dashboard before completion |
| Pending / disabled     | Not applicable                  | Generic 401 on wrong password; specific 403 message only after correct password                                                                                                                                                          |
| Remote public default  | 403; local CLI/setup needed     | Still 403, no cookies; clear local recovery instruction, not unusable change form                                                                                                                                                        |
| Self password change   | Instance settings changes owner | Ordinary user opens Change password from shell menu; verifies own current password; success replaces browser cookie with fresh current-version session; other sessions revoked                                                           |
| CLI owner reset        | Clears owner/settings hash      | Same existing CLI route; activated owner flagged for rotation; only genuine local recovery login can obtain challenge when using public default                                                                                          |

## Implementation Steps

### Phase 1: Durable State and Frozen Contracts — Backend Lane

1. **Add durable forced-change state and credential repo operations** (Files: `src/lib/db/migrations/007-user-password-change.js`, `src/lib/db/migrations/index.js`, `src/lib/db/schema.js`, `src/lib/db/repos/usersRepo.js`, `src/lib/db/index.js`)
   - Action: Idempotent ADD COLUMN with `tableHasColumn`. Include flag in internal session reads; keep hashes absent from public user objects. Add bounded parameterized login lookup and atomic password-write helper with expected version/hash checks. Create/reset/bootstrap paths initialize flag deliberately; null-hash bootstrap owner requires rotation, imported customized owner hash stays usable. Flag/hash writes revoke once, never double bump.
   - Why: Forced reset must survive restart and revocation must invalidate guard cache.
   - Dependencies: None; migration number 007 is next at baseline, parent rechecks before implementation.
   - Complexity: Medium. Risk: High — transactional invariants and owner mirror.

2. **Preserve password state through backup/import** (File: `src/lib/db/helpers/gatewayKeyTransfer.js`)
   - Action: Validate flag as 0/1, include in explicit user INSERT, preserve exported value. For older snapshots missing field, retain legacy semantics for custom hashes and require rotation for null-hash owner. Reject malformed flag before destructive import. Reuse existing transfer validation/transaction flow.
   - Why: Restore must not silently lift mandatory rotation.
   - Dependencies: Step 1.
   - Complexity: Low. Risk: High — security downgrade via restore.

3. **Freeze password/session HTTP contracts** (Files: `src/lib/auth/userPassword.js`, `src/lib/auth/dashboardSession.js`, `src/lib/users/session.js`)
   - Action: Establish helper signatures for resolved-user claims, challenge issuance/validation, and atomic rotation. Keep existing `sessionClaims` SSO behavior unchanged; add explicit password-user claim path rather than overloading SSO identity linking. Centralize public-default/INITIAL_PASSWORD checks and 8-character/72-byte new-password policy. Limit login/body strings to bounded sizes; accept legacy short passwords only for verification.
   - Why: UI and tests can proceed against stable API without shared-file edits.
   - Dependencies: Step 1.
   - Complexity: Medium. Risk: Medium.

### Phase 2: Authentication and Password Lifecycle — Backend Lane

1. **Enforce limited session purpose everywhere** (Files: `src/lib/auth/dashboardSession.js`, `src/lib/users/session.js`, `src/lib/users/bootstrap.js`, `src/dashboardGuard.js`, `src/lib/auth/routePolicy.js`, `src/sse/services/comboProbe.js`)
   - Action: Add dedicated challenge-cookie/token helpers with optional short expiration while retaining normal 24-hour JWT contract. Reject restricted/unknown-purpose tokens in full-session verification before signature-only off fallback. Full user/legacy-owner sessions require active approved user with flag false. Prevent implicit single-user owner mode from bypassing outstanding owner rotation. Challenge must not resolve as principal or satisfy capabilities. Guard challenge paths explicitly; dashboard challenge redirects to `/login?error=password_change_required`, normal APIs refuse.
   - Action: Add `passwordChange` policy flag and exact POST row for `/api/auth/change-password`, `{ cap: "self.session", alwaysProtected: true, cliAllowed: false }`; guard may admit validated challenge only for that method/path, handler independently validates. Admin password row uses `{ cap: "instance.users.manage", alwaysProtected: true, cliAllowed: false }`. Do not mark either route public. Add policy flag default false; encoded separators, near-miss paths, wrong methods never borrow exception.
   - Action: Close comboProbe raw-cookie fallback with purpose, mandatory-change, pending/status and version checks; otherwise denied principal could become owner/user authority there.
   - Why: Restricted cookie alone is insufficient if another validator accepts its JWT or single-user mode grants owner implicitly.
   - Dependencies: Steps 1, 3.
   - Complexity: High. Risk: High.

2. **Resolve account login and enforce independent limiters** (Files: `src/app/api/auth/login/route.js`, `src/lib/auth/loginLimiter.js`, `src/lib/auth/userPassword.js`)
   - Action: Validate JSON shape/string fields, check trusted IP bucket before expensive work, bootstrap safely when established security applies, then resolve account and account bucket. Maintain separate namespace/buckets; deny when either locked, report maximum active retry time. Record both failures for supplied valid identifiers regardless of account existence/status; aliases share user-ID bucket. Unknown/ambiguous/passwordless compare against precomputed valid cost-10 dummy hash. Keep existing SAML single-key API unchanged. Successful account login clears account failures, not unrelated/global IP failures; bound/prune stale entries.
   - Action: Preserve tunnel and normalized configured-SSO-only refusal before issuing credentials. Pristine off branch retains password-only owner behavior. Established branch requires login when `multiUserActive`, uses owner only for absent identifier otherwise, and mints resolved claims. Public default from fallback/env/stored hash remotely returns existing 403 recovery error with no full/challenge cookie. Existing custom short password remains accepted. After correct password: disabled → 403 `account_disabled`; pending → 403 `account_pending`; `mustChangePassword = 1` → 403 `password_change_required` plus `password_change_token` only (no `auth_token`, existing `auth_token` deleted). Owner null-hash public-default/INITIAL fallback after activation: local trusted request → 403 `password_change_required` (`reason: "initial"`) with challenge; remote → 403 `default_password_remote`, no cookie. Other success returns existing `{ success: true, mustChangePassword: false, startPage }`.
   - Action: Use uniform 401 credential errors and uniform limiter response, malformed input 400, sanitized unexpected 500/503, no-store on every response. Preserve existing one-argument limiter call sites. Pristine switch-off responses stay byte-identical to today (including `Invalid password. N attempt(s) left…` and existing remote-default body).
   - Why: Fix owner impersonation, enumeration, password spraying, alias bypass and raw-error leak without changing SSO linking.
   - Dependencies: Steps 1, 3, 4.
   - Complexity: High. Risk: High.

3. **Add self-change and admin temporary-password routes** (Files: `src/app/api/auth/change-password/route.js`, `src/app/api/users/[id]/password/route.js`, `src/lib/auth/userPassword.js`)
   - Action: Hide routes only when `isUserSecurityEnforced()` false. Require exact validated full browser session or exact restricted challenge for self route; no anonymous, API-key, CLI-token or `requireLogin=false` substitute. Verify current password even with challenge; rate-limit failed reauthentication by trusted IP and account. Apply new-password policy and current-password reuse refusal, atomically rotate/clear flag/bump version. After committed rotation and cache invalidation, reload live approved user and current `sv`, build fresh subject-bound claims, issue fresh full `auth_token`, and delete `password_change_token`. For challenge completion use personal workspace and `amr: ["pwd"]`; for normal self-change preserve `wid` only if still authorized. Never copy challenge purpose or stale claims. If fresh eligibility/issuance fails, clear cookies and require login; do not undo committed password change. Return success with existing `startPage` shape.
   - Action: Admin route independently resolves full browser principal, live-checks `instance.users.manage`, checks actor/target constraints, validates temporary password, hashes it, and atomically sets flag true plus version bump. No target cookie/session minting and no plaintext/hash response.
   - Action: Reject cross-origin browser mutations; validate Origin against request origin, reject cross-site fetch metadata, require JSON. Never use Host/Origin as proof of loopback. Follow existing trusted server request construction, not attacker-supplied forwarding headers.
   - Why: Current password proves self-service authority; temporary password proves only permission to finish rotation.
   - Dependencies: Steps 1, 3–5.
   - Complexity: Medium. Risk: High.

4. **Guard owner compatibility/reset paths and report safe status** (Files: `src/app/api/settings/route.js`, `src/app/api/auth/reset-password/route.js`, `src/app/api/auth/logout/route.js`, `src/app/api/auth/status/route.js`, `src/lib/users/session.js`, `src/lib/users/bootstrap.js`)
   - Action: Before settings early-return branches, detect password fields. Established security: only live full owner browser session plus verified current owner password may use compatibility password update. Reject admin/non-owner, restricted challenge, implicit owner/CLI and mixed password-plus-settings edits; direct `password` hash smuggling remains forbidden. Delegate policy and atomic owner/settings mirror write, rather than duplicated bcrypt/default checks. Pristine off retains legacy route availability, but enforce password policy/current configured INITIAL_PASSWORD for password mutation.
   - Action: Keep non-password settings PATCH behavior untouched. Adapt `revokeOwnerSessions` so owner hash synchronization/flag/version cannot produce premature full cookies; re-mint only eligible owner full session, never challenge.
   - Action: Existing CLI reset clears only owner hash and mirror in one transaction, sets owner flag true when established, bumps once, no cookies. Preserve local-only/CLI transport restriction; handler should independently enforce existing trusted local/CLI check for direct invocation. Other users unchanged. Clear challenge on logout.
   - Action: Status validates sessions through established-security rules even after switch-off; returns `authenticated: false`, no principal, and `mustChangePassword: true` only for live challenge. Expose safe `userSecurityEnforced`, `multiUserActive`, and effective `requireLogin` (not raw false when single-user mode forbidden). Preserve old off payload/display behavior. Use actual user display information when established, not owner/Password user fallback for everyone.
   - Why: Settings, reset and status otherwise undo new authentication constraints.
   - Dependencies: Steps 1, 3–6.
   - Complexity: High. Risk: High.

### Phase 3: Login and Self-service UX — UI Lane

1. **Wire account login and restricted change form** (Files: `src/app/login/page.js`, `src/app/login/loginErrors.js`, `src/app/login/loginVisibility.js`)
   - Action: Follow `docs/prps/plans/yan-358-ux.md` layout/copy/a11y, with contract above overriding its API assumptions. Consume `multiUserActive`, established-security and challenge status. Render `Email or username` (`name="username"`, `autoComplete="username"`, autoFocus) above password only when `multiUserActive === true`; React state and POST key named `login`. Status-fetch failure fallback stays single-user. Do not force dashboard redirect for challenge or raw `requireLogin=false`. Branch on response `code`, not `error` text. Add allowlisted `loginErrors.js` keys: `invalid_credentials`, `account_pending`, `account_disabled`, `password_change_required`, `password_change_expired`; never render arbitrary URL text or echo typed login in errors.
   - Action: Restricted card copy "Changing password for {login}" (not "Signed in as": no session exists). Replace dead settings-PATCH forced flow with `POST /api/auth/change-password`, new/confirm fields (+ temporary password field when memory lost), server/client minimum feedback, pending/retry states, correct autocomplete, keyboard focus and accessible errors. Reload restores challenge via status; expiry returns to login without loop. Remote public-default 403 displays local recovery guidance and never opens authenticated forced form. Successful rotation clears fields and navigates to server-returned `startPage` using fresh full cookie. Failed/expired challenge never navigates to dashboard.
   - Action: Support `/login?changePassword=1` for full-session self-service using same form, authenticated status and current-password entry; query alone never authorizes change. Hide new mode on pristine off. Suppress public-default hints in multi-user form; give non-owner recovery guidance to contact admin, not reset owner CLI instructions.
   - Why: Users need rotation outside privileged settings; forced path must work without dashboard session.
   - Dependencies: Frozen contracts from Step 3; final wiring requires Steps 5–7.
   - Complexity: Medium. Risk: Medium.

2. **Expose minimal self-service entry and maintain legacy settings form** (Files: `src/shared/components/HeaderMenu.js`, `src/app/(dashboard)/dashboard/settings/sections/SecuritySection.js`)
   - Action: Reuse cached `useAuthStatus` hook and existing menu primitives for Change password link to `/login?changePassword=1` when established security and full session exist. No new account page, admin page or hook framework. SecuritySection uses self endpoint in established mode and existing settings PATCH in pristine mode; require current password consistently and clarify session revocation. Keep unrelated instance security settings unchanged.
   - Why: Ordinary users cannot rely on `/api/settings` permission; full account/settings split remains YAN-371.
   - Dependencies: Steps 6–8.
   - Complexity: Low. Risk: Low.

### Phase 4: Adversarial Coverage — Test Lane

1. **Add isolated password/login/limiter coverage** (Files: `tests/unit/password-login.test.js`, `tests/unit/password-change.test.js`, `tests/unit/login-limiter.test.js`)
   - Action: Reuse `tests/setup/tenancyHarness.js`, `NextRequest`, real isolated DB, `next/headers` jar mocks and `vi.resetModules` env patterns from `principal-sessions.test.js`. Use real bcrypt/JWT for success and mutation; spy on bcrypt compare to prove unknown-account dummy path rather than flaky timing thresholds. Seed approved users, owner, pending, disabled, passwordless and temporary-password cases.
   - Action: Cover own-account claims, case/whitespace identifiers, cross-field ambiguity, explicit unknown no owner fallback, missing identifier rules, both independent limiter dimensions and alias aggregation, input bounds, generic errors, configured/unconfigured SSO, tunnel denial, public-default refusal, and all password lifecycle negatives listed below.
   - Why: Direct cookie/claim/DB observations prove behavior better than mocked success alone.
   - Dependencies: Step 3 contracts; tests may be authored parallel with Steps 4–9, no validation by lane agent.
   - Complexity: High. Risk: Medium.

2. **Extend existing regression fixtures without weakening legacy assertions** (Files: `tests/unit/principal-sessions.test.js`, `tests/unit/route-policy.test.js`, `tests/unit/auth-status.test.js`, `tests/unit/auth-modes.test.js`, `tests/unit/login-visibility.test.js`, `tests/unit/owner-bootstrap.test.js`, `tests/unit/db-tenancy-schema.test.js`, `tests/unit/db-migration-framework.test.js`, `tests/unit/gateway-key-transfer.test.js`, `tests/unit/gateway-key-established-security.test.js`)
   - Action: Check new column/default/check constraint, schema chain, idempotence, old snapshot compatibility, forced-state export/import, atomic failure rollback and one version bump. Update auth mocks for dedicated helpers without replacing integration coverage. Extend status/full-session tests for pending/forced users and marker-on/rollout-off behavior. Include route coverage/purpose flags, POST-only challenge exception, and encoded/near-miss paths.
   - Action: Route-policy legacy oracle assumes all `/api/auth/*` routes public and CLI allowed everywhere except SSO probes. Add explicit exceptions only for new password-management rows; keep historical rows and negative-path checks intact. Add pure login/query/helper assertions using existing test style; browser verification remains parent's job.
   - Why: Schema and routing regressions can silently bypass otherwise-correct new handlers.
   - Dependencies: Steps 1–9.
   - Complexity: Medium. Risk: Medium.

Lane ownership: backend edits only `src/lib/**`, `src/dashboardGuard.js`, `src/sse/services/comboProbe.js`, and listed API routes; UI edits only listed page/components; test lane edits only listed `tests/**`. No overlapping file ownership. Parent integrates contracts and owns validation/review. Phase 1 remains unexposed; Phase 2 is complete API/security slice; Phase 3 adds presentation without broad account/admin UI.

## Testing Strategy

### Critical negative tests

- User B login yields B `sub/sv/wid`, never owner; no hash claims or cross-user workspace. Unknown identifier, no hash, and wrong password (including wrong password on pending/disabled) share byte-identical 401 `invalid_credentials`; dummy compare runs for unresolved account.
- Correct password on disabled → 403 `account_disabled`, pending → 403 `account_pending`, disabled+pending → `account_disabled`; zero cookies; limiter neither incremented nor cleared. Correct temp password → 403 `password_change_required` with only `password_change_token` (path `/api/auth`, SameSite=strict, ~10 min), `auth_token` absent/deleted; status reports `authenticated: false, mustChangePassword: true`.
- Login body with `account` instead of `login` while `multiUserActive` → 401 `invalid_credentials` (field ignored, never owner fallback). Change-password body with `login`/`userId`/`account` → 400.
- Many accounts from one IP hit IP lock; one account across many IPs hits account lock; email/username aliases cannot reset account budget. Unknown IDs also accrue lockout. Successful unrelated login does not clear attacker's IP budget. Fake time covers expiry/progression/cleanup; spoofed peer/XFF cannot escape bucket.
- Missing identifier rejected when multiUserActive, including durable marker plus rollout off. Supplied wrong identifier never chooses owner. Shared-workspace trigger for multiUserActive remains honored.
- Remote public default with no hash, stored hash, `INITIAL_PASSWORD=123456`, proxy hop or spoofed localhost produces zero auth/challenge cookies. Genuine trusted local reset can obtain only limited challenge after activation. Tunnel-disabled and configured normalized `sso`/`oidc`/`saml` modes cannot mint password cookies; unconfigured SSO recovery behavior remains.
- Temporary login cannot access dashboard, `/api/settings`, shutdown, export/import, CLI routes, combo probe or user-password-admin route. Challenge JWT pasted into `auth_token` rejected even after rollout off. No single-user implicit owner bypass while owner rotation pending. Forged/expired/revoked challenge, changed purpose, stale `sv`, disabled/pending subject, deleted user, wrong method/path, and no-current-password change denied.
- Ordinary self-change cannot target another user; admin cannot self-reset, reset owner or peer admin; API key, CLI, anonymous and `requireLogin=false` cannot replace browser session. Cross-origin mutation rejected. Wrong current password and stale concurrent change leave hash/flag/version/mirror unchanged.
- Short, `bcrypt.truncates` (>72 UTF-8 bytes), empty/malformed, default, configured INITIAL_PASSWORD, current and temporary reuse rejected. Unicode 72/73-byte boundary checked. Existing legacy short password still verifies for migration/recovery only.
- Locked IP or account returns before any `bcrypt.compare` (spy count 0). Unknown identifier accrues normalized-key failures; random identifiers cannot grow limiter map beyond cap. Unknown/ambiguous/no-hash/wrong-password (incl. wrong password on disabled/pending) bodies deep-equal and headers equal; dummy hash has cost 10.
- Restricted challenge passed directly to `getPrincipal`/`authorize`/handler imports without proxy denies; successful change returns fresh `auth_token` with current `sv`, deletes challenge cookie, and old tokens fail.
- Password/reset/admin write bumps exactly once; old full/challenge tokens fail next request; new credential persists across reopened DB. Owner/settings hashes remain equal on success and failure injection. Other users unaffected. Export/import retains mandatory state; malformed imported flag rejected before destructive writes.
- Raw PATCH `/api/settings` password/hash fields cannot bypass self-service or admin target controls. Restricted session cannot combine rotation with `requireLogin=false` or other instance mutations. Marker corruption/DB failure denies rather than reverting to owner fallback; status never claims revoked/challenge session authenticated.

### Evidence and validation ownership

- **Unit tests:** policy and identifier normalization, limiter fake-time behavior, claim-purpose validation and login visibility/error mapping. Existing Vitest only; no new test dependencies.
- **Integration tests:** real bcrypt, isolated DB and signed JWT through login/change/admin/reset/settings/status handlers, guard and combo-probe restrictions, migration/restore round-trip. Preferred evidence is exact response, cookie contents, claims and persisted rows; wall-clock timing alone cannot prove enumeration resistance.
- **E2E tests:** parent performs browser smoke with disposable isolated DATA_DIR: pristine owner login, two-user identifier login, admin temporary reset, challenge reload/expired challenge, rotate and re-login, ordinary-user self-change, remote-default refusal, marker-on/switch-off refusal and query-error rendering. Verify labels/focus/keyboard/error announcements. No live provider calls or real HOME data.
- **Parent only runs validation.** Lane agents write code/tests and report checks not run. No builds, tests, migrations or external tools during this planning task.
- Parent starts with focused safe suite: `npx vitest run -c tests/vitest.config.js tests/unit/password-login.test.js tests/unit/password-change.test.js tests/unit/login-limiter.test.js tests/unit/principal-sessions.test.js tests/unit/route-policy.test.js tests/unit/gateway-key-established-security.test.js tests/unit/gateway-key-transfer.test.js tests/unit/db-migration-framework.test.js` from feature worktree root. Expand to affected auth/status/bootstrap tests if mocks/interfaces changed.
- Parent then runs required `npm test` regression gate, `npm run lint`, and `npm run build` once on integrated tree. Do not run bare root Vitest or alternate config; `tests/vitest.config.js` isolates HOME/DATA_DIR. Do not update known-fails baselines to hide regressions. No environment setup using real production data.
- Parent dispatches mandatory `code-reviewer` on final diff, focused on purpose isolation, owner compatibility, durable latch, atomic writes, limiter alias coverage and secret leakage; resolves findings then reruns only affected evidence plus required gates when relevant files changed. Record evidence/limitations, not assumed green.

## Risks & Mitigations

- **Risk:** rollout off restores shared-owner login or trusts raw signed token after activation.
  - Mitigation: established-security gate for every auth/password/status decision; marker-on/off regression matrix; keep feature visibility distinct from authority.
- **Risk:** mandatory-change state disappears during restore or cache stays stale after mutation.
  - Mitigation: schema/import updates, live limited-token checks, shared session cache invalidation and reopened-DB tests; retain ADR-0004 cross-process cache bound of at most 5 seconds.
- **Risk:** restricted JWT accepted by legacy verifier or raw combo-probe fallback.
  - Mitigation: separate cookie plus explicit purpose rejection at every full-token consumer; negative raw-token-placement and probe tests. No restricted token may acquire principal/capability.
- **Risk:** concurrent password writes split owner mirror or elevate stale session.
  - Mitigation: hash outside transaction, compare expected credential/version inside transaction, update hash/flag/version/mirror atomically, mint fresh full cookie only from post-commit live approved user/current version; never reuse stale/challenge claims.
- **Risk:** legitimate legacy install locks out during migration.
  - Mitigation: migrate forced flag additively, preserve custom existing hash/short login credentials, owner-only null-hash fallback, local CLI reset retained, generic remote refusal for public default. No bootstrap rewrite or new CLI command.
- **Risk:** scope expands into account/admin application.
  - Mitigation: one login-page form reused for self/forced change, one shell link, admin API only; YAN-360/371/373 own lifecycle, account split and full admin UI.

## Success Criteria

- [ ] Email/username logins authenticate correct approved user and issue subject-bound revocable claims.
- [ ] Unknown/passwordless/wrong-password cases (any account status) remain non-enumerating; pending/disabled 403 only after correct password; IP and account lockouts work independently and across aliases.
- [ ] API contract table matches implementation and `yan-358-ux.md` UI (`login` key, `code` branching, `POST /api/auth/change-password`).
- [ ] Temporary password permits only current-password-proven rotation, never dashboard or management access beforehand.
- [ ] Owner CLI reset and settings compatibility remain secure; atomic credential writes revoke exactly once and preserve owner mirror.
- [ ] New-password policy rejects short/default/INITIAL/current/temporary reuse and bcrypt truncation.
- [ ] Tunnel, normalized SSO-only and no-remote-public-default invariants hold in pristine, activated and marker-on/flag-off states.
- [ ] Forced state survives migration, process restart and supported backup/restore; malformed state fails closed.
- [ ] Identifier visibility, query errors, forced form and ordinary-user self-service work without privileged settings access.
- [ ] Parent records focused/integrated test, lint, build, browser and mandatory code-review evidence; no new dependencies or release-file edits.
