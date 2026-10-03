# YAN-355: request principal and revocable sessions

Trunk landing: behind the switch (`isMultiUserEnabled()`). Switch off = today's
guard, cookie and status behaviour, byte for byte. Binding design: ADR-0003, ADR-0004.

## Decisions

- Claims `sub`, `sv`, `wid`, `amr` (`["pwd"]`, `["oidc"]`, `["saml"]`, RFC 8176 per ADR-0004).
  Minted only while the switch is on and an owner row exists (YAN-356 bootstraps it);
  before that, logins mint today's claim set. An SSO login with two or more active users
  is refused (`/login?error=sso_not_linked`) until YAN-359 links identities.
- `resolvePrincipal(request)` order: session cookie, CLI token (owner, `via: "cli"`),
  `requireLogin=false` (owner, `via: "local"`). Gateway keys: hook left for YAN-363.
- Handlers call `getPrincipal()`, which resolves from the request's own cookie/headers
  through the same validated path as the guard. No forwarded principal header: every
  `NextResponse.next()` path would have to strip a spoofed one.
- Validation cache in `usersRepo` (`getSessionUserUnscoped`: `id, instanceRole, status,
sessionVersion`; `countActiveUsersUnscoped`), TTL 5 s, on `globalThis` because the proxy
  and route handlers are separate bundles; every write in `usersRepo` that changes them
  drops it. Single process: another process sees a bump within the TTL.
- The switch read is cached 5 s in `session.js`, so the guard does no DB read for
  requests without a cookie or CLI token and at most one per 5 s otherwise.
- Legacy `sub`-less token (`// legacy: pre-users session`): accepted while ≤ 1 active user
  exists (zero = pre-bootstrap sole admin), rejected from the second user on.
- CLI token: owner principal; accepted only from a loopback peer once a second user exists
  (ADR-0003). Loopback helpers move to `src/lib/auth/trustedPeer.js`.
- Until YAN-357 lands RBAC, the guard counts only owner principals as authenticated.
- SSO logins mint owner claims only while ≤ 1 user exists; YAN-359 maps SSO identities.
- Bump triggers: logout-all (`POST /api/auth/logout-all`, 404 while off), password change
  (`PATCH /api/settings`, current cookie re-minted), password reset, and the role/status
  writes `updateUserUnscoped` already bumps.

## Tasks

1. `usersRepo`: `countActiveUsersUnscoped`, `getSessionUserUnscoped`, `bumpSessionVersion`; cache drop on every relevant write.
2. `src/lib/users/session.js`: `sessionClaims`, `hasValidSession`, `isLiveSession`, `cliTokenAccepted`, `resolvePrincipal`, `getPrincipal`, `revokeOwnerSessions`, `describePrincipal`.
3. Guard: token + CLI checks through the session module.
4. Mint claims in login, OIDC callback, SAML ACS; bump in settings PATCH and reset-password; logout-all route; status adds `principal` while on.
5. Tests: `tests/unit/principal-sessions.test.js`; guard/status mocks gain `getDashboardAuthSession`; `GUARDED_ROUTES` gains logout-all.
