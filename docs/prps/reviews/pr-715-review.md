# PR Review #715 — feat(auth): request principal and revocable sessions

**Reviewed**: 2026-10-03
**Mode**: PR (parallel: correctness, security, quality)
**Author**: yandy-r
**Branch**: users/yan-355-principal-sessions → master
**Decision**: APPROVE with comments

## Summary

Core `sv` revocation, legacy-token, CLI-loopback and fail-closed paths are correct and tested; no CRITICAL/HIGH. The main MEDIUM: with the switch off the guard now reads the DB on paths that were DB-free (CLI-token `/v1/*`), which breaks "switch off = exactly today".

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

- **[F001]** `src/lib/users/session.js:33` — Every guarded request with a cookie or CLI token now does an uncached `getSettings()` (switch read) even with the switch off, plus an uncached active-user `COUNT(*)` for legacy tokens / CLI tokens. Previously CLI-token and JWT checks were DB-free.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Skip all work when no token is presented; cache the switch read (≤ 5 s) and the active-user count (dropped on user create/delete/status change).
- **[F002]** `src/lib/users/session.js:120` — `resolvePrincipal` lets DB errors throw, unlike `hasValidSession`/`cliTokenAccepted`; `logout-all` 500s and status loses `principal` on a DB blip.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Return null from `resolvePrincipal` on errors.
- **[F003]** `src/app/api/auth/oidc/callback/route.js:88` — With ≥ 2 active users an SSO login mints a `sub`-less cookie that the guard rejects at once: silent login loop, and ADR-0004 says no new `sub`-less token is ever minted.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: When multi-user is on and `sessionClaims` is empty, redirect to `/login?error=sso_not_linked` (OIDC and SAML) instead of minting.
- **[F004]** `src/lib/db/repos/usersRepo.js:62` — The session cache keeps the whole user row; `describePrincipal` serves profile fields from it. ADR-0004 shape is `{ sv, status, … }`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Cache only `id, instanceRole, status, sessionVersion`; `describePrincipal` reads the row uncached and returns null when it's gone.
- **[F005]** `tests/unit/principal-sessions.test.js:1` — No tests for TTL expiry of an out-of-band `sessionVersion` change, or for `/api/auth/reset-password` revocation.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Add both (fake timers for TTL).
- **[F006]** `docs/prps/plans/yan-355-principal-sessions.plan.md:18` — Plan names `sessionCache.js` and `countUsersUnscoped`, which don't exist.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Update to as-built names; note the single-process assumption.

### LOW

- **[F007]** `src/lib/users/session.js:186` — `describePrincipal` dereferences a possibly-null user.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Covered by F004 (null guard).
- **[F008]** `src/app/api/auth/logout-all/route.js:13` — With `requireLogin=false` any LAN peer resolves to the owner (`via: "local"`) and can repeatedly sign the owner out.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Refuse `via: "local"` principals (nothing to revoke without a session).
- **[F009]** `src/lib/users/session.js:177` — Password-change re-mint resets the caller's active workspace (`wid`) to personal.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Keep the old `wid` when it is still one of the owner's workspaces.
- **[F010]** `src/dashboardGuard.js:5` — `cliTokenAccepted as hasValidCliToken` hides the new loopback semantics; `hasValidToken` is a one-line pass-through.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Import `cliTokenAccepted` by name; call `hasValidSession` directly.
- **[F011]** `src/lib/db/repos/usersRepo.js:60` — The in-process cache drop assumes a single process; not written down where contributors will see it.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: `ponytail:` comment naming the ceiling (other processes see a bump within the 5 s TTL) and the upgrade path.
- **[F012]** `src/app/api/auth/status/route.js:20` — `displayName`/`oidcLogin`/`samlLogin` still read the raw JWT when the session is revoked.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Defer to YAN-371 (account UI owns these fields); cosmetic.
  - **Resolution**: Deferred to YAN-371.
- **[F013]** `tests/unit/dashboard-guard.test.js:33` — Same 6-line switch mock copied into three test files.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Accept; each file is self-contained by repo convention.
  - **Resolution**: Accepted as is.

## Validation Results

| Check      | Result                               |
| ---------- | ------------------------------------ |
| Type check | Skipped (no tsconfig)                |
| Lint       | Pass (changed files; 1 pre-existing) |
| Tests      | Pass (`npm test` switch off and on)  |
| Build      | Pass                                 |

## Files Reviewed

- `docs/prps/plans/yan-355-principal-sessions.plan.md` (Added)
- `src/app/api/auth/logout-all/route.js` (Added)
- `src/lib/users/session.js` (Added)
- `tests/unit/principal-sessions.test.js` (Added)
- `src/app/api/auth/{login,oidc/callback,oidc/test,reset-password,saml/acs,saml/test,status}/route.js` (Modified)
- `src/app/api/settings/route.js` (Modified)
- `src/dashboardGuard.js` (Modified)
- `src/lib/auth/trustedPeer.js` (Modified)
- `src/lib/db/index.js`, `src/lib/db/repos/usersRepo.js` (Modified)
- `tests/unit/{auth-status,dashboard-guard,local-request-peer-trust-3294,multi-user-switch}.test.js` (Modified)
