# YAN-356 — owner bootstrap, Default workspace, single-user compatibility

Target `v1.1.0` → PR into `master`, no backport (RELEASING.md; ADR-0009).
Trunk landing: **behind the switch** (`isMultiUserEnabled()`); switch off = today.
Binding design: ADR-0003 (bootstrap, setup token, single-user mode, CLI principal),
ADR-0009 (irreversible step only with switch on, after a backup, idempotent).

## Design

### Bootstrap (lazy, idempotent, switch-on only)

- Not a schema migration: migrations are sync, settings-blind and run with the
  switch off. `ensureOwnerBootstrap()` (`src/lib/users/bootstrap.js`) runs when
  the switch is on: at startup (`instrumentation.js`) and lazily from
  `session.js` (`multiUserOn()`, `sessionClaims`, `revokeOwnerSessions`) so a
  runtime flip of the stored setting is covered. Memoised per process on
  `globalThis` once it succeeds; a failure is logged and retried next call.
- Owner missing → pre-bootstrap backup (`makeBackupDir("users-bootstrap")` +
  `backupDbLite` + `pruneOldBackups`; abort on failure) → one transaction
  `bootstrapOwnerUnscoped({ passwordHash })` in `usersRepo`:
  owner (`instanceRole owner`, `username "owner"`, `passwordHash =
settings.password ?? null`), personal workspace + owner membership,
  `password` identity (`issuer ""`, `subject = owner.id`), shared workspace
  **"Default"** + owner membership; Default id stored in `_meta.defaultWorkspaceId`.
- Owner present → done (owner and Default are created in one transaction, so
  one never exists without the other). A concurrent second insert fails on
  the UNIQUE owner index (`OWNER_EXISTS`) and is treated as done. Restoring a
  deleted Default is out of scope (workspace management, YAN-373).
- Login keeps verifying against `settings.password` / `INITIAL_PASSWORD` /
  default, so `mustChangePassword` is unchanged. Password change and
  `/api/auth/reset-password` copy the new hash (or null) to the owner through
  `updateUserUnscoped(owner, { passwordHash })`, which bumps `sv`
  (`revokeOwnerSessions`).

### SSO owner linking (never first-login-wins)

- OIDC callback passes `{ provider: "oidc", issuer: payload.iss, subject:
payload.sub, email, emailVerified: payload.email_verified === true }`; SAML
  ACS passes `{ provider: "saml", issuer: profile.issuer, subject:
profile.nameID, email, emailVerified: true }` (signed assertion from the
  configured IdP) plus the `setup_token` cookie value, into
  `sessionClaims(method, identity)`.
- `resolveSsoUser(identity)`: identity already linked → its user. Else link to
  the owner when (a) `TOKENHOP_OWNER_EMAIL` is set, not yet consumed
  (`_meta.ownerEmailConsumed`), the email is verified and matches
  (case-insensitive) — then mark consumed; or (b) a valid setup token was
  presented — then consume it. Otherwise nothing is linked.
- Claims: linked to owner → owner claims (also with ≥2 users). Unlinked →
  today's YAN-355 rule (owner while ≤1 active user, else refuse). Linked to a
  non-owner → refuse (YAN-359).
- Setup token: `randomBytes(32)` base64url, SHA-256 hash + expiry (60 min) in
  `_meta.ownerSetupToken*`, single use, compared with `timingSafeEqual`.
  Minted at bootstrap only when SSO is configured, the owner has no SSO
  identity and `TOKENHOP_OWNER_EMAIL` is unset and no live token exists;
  printed once (`console.log`). `POST /api/auth/setup-token` (local-only,
  `requireMultiUser`) mints a fresh one for `tokenhop auth setup-token`.
  Presented as `?setupToken=` on `/api/auth/{oidc,saml}/start`, carried in an
  httpOnly 10-minute `setup_token` cookie, cleared in the callback.

### Single-user mode

- `singleUserMode(settings)` in `session.js`: `requireLogin === false` and
  (switch off, or ≤1 active user). Used by the guard (`isAuthenticated`,
  dashboard branch) and `resolvePrincipal` — a restored DB with two users and
  `requireLogin=false` no longer opens the instance.
- `PATCH /api/settings` `requireLogin: false` → 409 while switch on and >1
  active users. `createUserUnscoped` throws `TenancyError("SINGLE_USER_MODE")`
  when `requireLogin === false` and an active user already exists.

### UI gating flag

- `multiUserActive()` = switch on and (active users ≥ 2 or shared workspaces ≥ 2).
  `/api/auth/status` adds `multiUserActive` next to `principal` (switch on only).

### CLI

- `tokenhop auth setup-token`: new `cli/src/cli/commands/authSetupToken.js`,
  dispatched in `cli/cli.js` like `xai video`; uses `api.mintSetupToken()`
  (`POST /api/auth/setup-token`) and prints token + expiry + start URLs.

## Files

| File                                                                                | Change                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/db/repos/usersRepo.js`                                                     | `bootstrapOwnerUnscoped`, single-user refusal in `createUserUnscoped`                 |
| `src/lib/db/repos/workspacesRepo.js`                                                | `countSharedWorkspacesUnscoped`                                                       |
| `src/lib/db/index.js`                                                               | barrel exports                                                                        |
| `src/lib/users/errors.js`                                                           | `SINGLE_USER_MODE` code                                                               |
| `src/lib/users/bootstrap.js` (new)                                                  | bootstrap, setup token, SSO resolve, `multiUserActive`                                |
| `src/lib/users/session.js`                                                          | bootstrap hooks, `sessionClaims(method, identity)`, `singleUserMode`, owner hash sync |
| `src/dashboardGuard.js`                                                             | `singleUserMode`                                                                      |
| `src/app/api/auth/{oidc,saml}/start/route.js`                                       | `setupToken` → cookie                                                                 |
| `src/app/api/auth/oidc/callback/route.js`, `saml/acs/route.js`                      | pass identity                                                                         |
| `src/app/api/auth/setup-token/route.js` (new)                                       | mint token (local-only, gated)                                                        |
| `src/app/api/auth/status/route.js`                                                  | `multiUserActive`                                                                     |
| `src/app/api/settings/route.js`                                                     | `requireLogin` refusal                                                                |
| `src/instrumentation.js`                                                            | startup bootstrap                                                                     |
| `cli/cli.js`, `cli/src/cli/commands/authSetupToken.js`, `cli/src/cli/api/client.js` | CLI command                                                                           |
| `tests/unit/owner-bootstrap.test.js` (new)                                          | fixtures + flows below                                                                |
| `tests/unit/multi-user-switch.test.js`                                              | add setup-token route to `GUARDED_ROUTES`                                             |

## Tests (one new file, critical only)

- Legacy fixtures (switch on): password set → owner hash equals it; unset →
  owner hash null, login default path unchanged; OIDC configured / SAML
  configured → no SSO identity linked, setup token minted once.
- Idempotent re-run: exactly one owner, one Default, one password identity.
- Setup token: valid → links + consumed, second use fails, expired fails.
- `TOKENHOP_OWNER_EMAIL`: verified match links once; unverified / mismatch don't.
- First unlinked SSO login is NOT linked (negative).
- Single-user refusals: PATCH 409 with 2 users; `createUserUnscoped` throws.
- `multiUserActive` false single-user, true with 2 users; absent switch off.
- Switch off: bootstrap is a no-op (no users rows), status has no new fields.

## Validation

`npm run lint`, `npm test` with `TOKENHOP_MULTI_USER=off` and `=on`,
`npm run build`, `npm run lint:brand`; manual upgrade under a temp `DATA_DIR`.
