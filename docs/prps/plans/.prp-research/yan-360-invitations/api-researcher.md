# YAN-360 external research — invitations + admin user lifecycle APIs

Scope: server APIs only (UI lands M5). Trunk landing: behind switch. `TOKENHOP_MULTI_USER` off (default) → new routes answer 404; behavior identical to single-user install. v1.1.0 on `master`. No new dependencies.

Sources: issue text (GH tokenhop/tokenhop #228), `docs/users/README.md` + `spec.md` + `adr/`, worktree code (`src/lib/users/*`, `src/lib/db/repos/usersRepo.js`, `membershipsRepo.js`, `bootstrap.js`, `audit.js`, `src/lib/auth/routePolicy.js`, `passwordChangeSession.js`, `src/app/api/auth/login/route.js`), Context7 docs for Next.js route handlers + `next/headers` cookies (Next 16.x) and Node `crypto` (randomBytes/createHash/timingSafeEqual).

## Executive Summary

All building blocks already exist in-repo. Invitation tokens copy setup-token pattern (`bootstrap.js` `mintSetupToken`/`consumeSetupToken`): `crypto.randomBytes(32).base64url` (256 bits), store SHA-256 hex only, compare with `timingSafeEqual` after length check, burn inside SQLite transaction, `Cache-Control: no-store`. Plain SHA-256 OK here (256-bit entropy); legacy API keys needed HMAC only because ~31 bits entropy (ADR-0005).

Lifecycle piggybacks `usersRepo.js`: `updateUserUnscoped` already bumps `sessionVersion`, revokes user API keys on disable, blocks owner demote/disable/delete; `transferOwnership` already owner-only with dual `sv` bump. Missing pieces: invitation table + routes, admin list/approve/disable/delete handlers, membership add/remove/role handlers, ownership-transfer re-authentication step, audit event names. Bounded recommendation: mirror `bootstrap.js` + `passwordChangeSession.js` + `membershipsRepo.js` shapes exactly; add `ROUTE_POLICY` rows (route-policy test fails on unmapped routes).

## Primary APIs

### Next.js route handlers (Next 16.1.6, Node 22)

- Handlers: `export async function GET/POST/PATCH/DELETE(request, { params })` in `src/app/api/<path>/route.js`. Dynamic `[id]` segments via file path. Context7 (Next 15+ upgrade notes): `params` is async Promise — `await` before use.
- `cookies()` from `next/headers` is async in Next 15+: `const cookieStore = await cookies()`. Login route already does this pattern.
- Responses: `NextResponse.json(body, { status, headers })`. Switch-off guard: `const hidden = await requireMultiUser(); if (hidden) return hidden;` → 404 `{ error: "Not found" }`. Precedent: `src/app/api/auth/setup-token/route.js`.
- Sensitive responses set `Cache-Control: no-store` (setup-token, login do this).
- `ROUTE_POLICY` (`src/lib/auth/routePolicy.js`) needs one row per new route; pure object, no imports (proxy bundle). Capabilities from ADR-0002: `instance.users.manage`, `instance.ownership.transfer`, workspace member caps. `passwordChange: true` flag pattern admits restricted password-change token on POST only.
- Suggested routes (names for implementor; keep thin, repos do work):
  - `POST /api/invitations` (create; admin or workspace owner/manager for own workspace)
  - `GET /api/invitations` (list; scoped to caller visibility; no token hashes)
  - `POST /api/invitations/[id]/revoke`
  - `POST /api/invitations/accept` (PUBLIC + `requireMultiUser`; token in body, not URL log)
  - `GET /api/users` (paginated list; `COLS` projection only)
  - `PATCH /api/users/[id]` (approve pending, role change, disable/enable)
  - `DELETE /api/users/[id]`
  - `POST /api/users/transfer-ownership` (current-owner re-auth required)
  - `GET/POST /api/workspaces/[id]/members`, `PATCH/DELETE /api/workspaces/[id]/members/[userId]`

### Node crypto token hashing (Node 22, `node:crypto` only)

- Mint: `crypto.randomBytes(32).toString("base64url")` → 256-bit, URL-safe. Precedent: `mintSetupToken` (60-min TTL); invitations use 7-day TTL.
- Store: `crypto.createHash("sha256").update(token, "utf8").digest("hex")`. Raw token shown once, never stored/logged.
- Compare: length-check first, then `crypto.timingSafeEqual(stored, given)` — `timingSafeEqual` **throws** `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on length mismatch (Node docs via Context7). Precedent `bootstrap.js:78` does `stored.length !== given.length || !timingSafeEqual(...)`.
- Burn atomically: check-expiry + compare + clear inside `db.transaction()` (`consumeSetupToken` precedent) so concurrent accepts cannot both spend.
- Revoke = clear hash row / mark revoked; expiry check `expiresAt > Date.now()`.
- `crypto.hash()` one-shot exists (Node 22) but `createHash` matches codebase style; either fine.

### Invitation security

- Single-use, hashed, 7-day expiry, revocable, optionally email-bound (normalize: trim + lowercase; compare at accept).
- Accept paths: (a) new password account — `bcryptjs` hash via existing `userPassword.js` (`verifyPassword`, `MIN_PASSWORD_LENGTH`, `DUMMY_HASH` timing cover); (b) link SSO identity after SSO login — `resolveSsoUser` + identities UNIQUE `(provider, issuer, subject)`, never link by email alone (ADR-0003). Membership row `source = 'invite'`.
- Accept route is PUBLIC but must sit behind `requireMultiUser()` first, then rate-limit (see login: `loginLimiter.js` keys IP + account — reuse per-IP for accept to blunt enumeration).
- Manager cross-workspace negative: handler checks caller membership in invite's workspace; test: manager of A cannot invite into B.
- No token material in list/detail responses, logs, or audit `before/after` (one-api#2425 lesson; `COLS` excludes `passwordHash`; audit allow-list drops unknowns).

### Account lifecycle

- List: `listUsersUnscoped`-style projection (`COLS`), pagination (`limit`/`cursor` or `page`), never hashes/secrets. Add no-secrets assertion test.
- Approve: `pending` → role (`user` default), `updateUserUnscoped` bumps `sv` (revokes sessions) and clears IdP provenance to manual.
- Role change: same path; owner role immutable except via transfer (`OWNER_IMMUTABLE`).
- Disable/enable: status flip bumps `sv`, calls `revokeUserApiKeysSync`, `dropSession` (session cache invalidation; TTL ≤ 5 s per ADR-0004). Disabling revokes sessions + personal API keys.
- Ownership transfer: `transferOwnership(ctx, toUserId)` exists (owner-only, dual `sv` bump, audit `instance.ownership.transfer`). YAN-360 adds **current-owner re-authentication**: bounded recommendation — require fresh password verification at transfer time. Reuse shape: `verifyPassword` + short-lived proof. Precedent for short-lived purpose-scoped JWT: `passwordChangeSession.js` (`purpose: "password-change"`, 10 min, `amr: ["pwd"]`, `authenticated: false`, cookie path `/api/auth`). Options: (a) re-verify password inline in transfer POST body (simplest, no new cookie); (b) purpose-scoped `ownership-transfer` JWT mirroring password-change cookie. Prefer (a): one request, no cookie surface, password never persisted.
- Delete: `deleteUserUnscoped` + cascade: delete personal workspace + its connections/keys; shared-workspace resources stay, re-attributed (`adoptOwnerlessRowsUnscoped` precedent, YAN-361); workspace service keys survive; with encryption (M2) destroy DEK. Owner cannot be deleted (invariant).
- Memberships: `membershipsRepo.js` `addMembership`/`updateMembershipRole`/`removeMembership` + `assertNotLastManager` guard (cannot leave shared workspace without owner/manager). Enforce in handlers via these functions, not inline SQL.
- Audit: `audit(principal, action, target, { before, after })` — never throws, deny-by-default allow-list (`src/lib/users/audit.js`). New actions: `instance.users.*` (approve/role/disable/enable/delete/transfer), `workspace.members.*`, `invitations.*` (create/revoke/accept). Check `auditRepo.js` for action-name conventions first.

## Libraries and SDKs

| Need                          | Decision                                                            | Why                                                                |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Token random + hash + compare | `node:crypto` only (`randomBytes`, `createHash`, `timingSafeEqual`) | Already used; no dep; 256-bit tokens make plain SHA-256 sufficient |
| Password hash/verify          | `bcryptjs` (already dep, `^3.0.3`)                                  | Existing `userPassword.js` helpers; no new dep                     |
| JWT/session                   | `jose` HS256 (already dep, `^6.1.3`)                                | Existing `dashboardSession.js`; `sv` revocation already wired      |
| Validation                    | hand-rolled (codebase style) or existing helpers                    | No zod in `package.json`; do not add                               |
| Email sending                 | none                                                                | Issue requires no email delivery; token returned to creator        |

No new dependencies (handbook §8 forbids without maintainer approval).

## Integration Patterns

- **Guard order per handler**: `requireMultiUser()` → auth principal → capability check (`dashboardGuard` + `ROUTE_POLICY`) → workspace-scope check → repo call → `audit(...)` → `NextResponse.json(..., { headers: no-store })` for token-bearing responses.
- **Repo takes `ctx` principal** (handbook §7.5); only `*Unscoped` admin functions skip scoping. Invitation accept runs unauthenticated → use `*Unscoped`-style internals + token proof as authorization.
- **Setup-token file to copy**: `src/lib/users/bootstrap.js` lines ~38–84 (sha256 helper, mint, consume-in-transaction). Invitation repo mirrors this with `expiresAt = now + 7d` and `email`/`workspaceId`/`role` columns.
- **Re-auth proof for transfer**: inline `{ password }` in POST body → `verifyPassword(currentOwner, password)` → proceed in same request. Never log password; `MAX_PASSWORD_LENGTH = 1024` precedent in login route.
- **Single-user regression**: switch off → all new routes 404; existing login/session paths untouched. Tests run with `TOKENHOP_MULTI_USER=off` and `=on`.
- **Test harness**: `tests/unit/tenancy-isolation.test.js`, `principal-sessions.test.js`, `connection-ownership.test.js` (two-user patterns); route-policy test enforces `ROUTE_POLICY` coverage. New tests: invite accept/expiry/reuse/revoke, cross-workspace manager negative, disable-revokes-sessions-and-keys, deletion cascade, list-has-no-secrets.

## Constraints and Gotchas

1. `timingSafeEqual` throws on length mismatch — always length-check first (precedent `bootstrap.js:78`).
2. Next 15+ `params` and `cookies()` are async — `await` both; sync access deprecated.
3. `ROUTE_POLICY` must cover every new route/method or `tests/unit/route-policy.test.js` fails. Keep it import-free (proxy bundle).
4. `bootstrap.js` avoids oidc/saml imports (proxy bundle) — keep invitation-accept SSO-linking call at arm's length (call `resolveSsoUser`-level API, don't import provider code into proxy-loaded modules).
5. `updateUserUnscoped` blocks any direct owner assignment (`OWNER_IMMUTABLE`) — transfer only via `transferOwnership`.
6. Exactly-one-owner partial index (`idx_users_owner`) — demote-before-promote order inside transaction (precedent in `transferOwnership`).
7. Migrations must be idempotent (`001` builds current tables with `IF NOT EXISTS`; runner wraps in transaction; `syncSchemaFromTables` only adds columns). Invitation table creation belongs to this issue's migration; follow `migrations/` registry pattern.
8. `COLS` projection is the no-secrets enforcement — never `SELECT *` on users; `instanceRoleSource` stays internal.
9. Email-bound invite: normalize case/whitespace at create AND accept; treat mismatch as invalid token (no oracle).
10. Accept must be constant-time-ish on token lookup: hash then indexed `tokenHash` lookup; use `DUMMY_HASH`-style cover when invite id unknown (see `userPassword.js`) to avoid user-enumeration timing.
11. Login length caps (`MAX_LOGIN_LENGTH 320`, `MAX_PASSWORD_LENGTH 1024`) — apply same caps on accept inputs.
12. `assertNotSingleUserMode` (`createUserUnscoped`) — invite accept creating a second user must respect single-user-mode refusal semantics (ADR-0003); switch-on path only.
13. Audit `before/after` allow-list drops unknown keys silently — use allowed key names (`userId`, `role`, `status`, `workspaceId`, `email`, `reason`); token hashes never included by construction.

## Code Examples

Setup-token pattern to mirror (from `src/lib/users/bootstrap.js`):

```js
import crypto from "node:crypto";
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

export async function mintInviteToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token).toString("hex");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return { token, tokenHash, expiresAt };
}

export function tokensEqual(storedHex, presentedToken) {
  const given = sha256(presentedToken);
  const stored = Buffer.from(storedHex, "hex");
  if (stored.length !== given.length) return false;
  return crypto.timingSafeEqual(stored, given);
}
```

Consume-in-transaction (shape from `consumeSetupToken`):

```js
return db.transaction(() => {
  const row = db.get(`SELECT ... FROM invitations WHERE id = ?`, [id]);
  if (!row || row.revokedAt || Number(row.expiresAt) <= Date.now()) return false;
  if (!tokensEqual(row.tokenHash, token)) return false;
  if (row.email && row.email.toLowerCase() !== String(email).trim().toLowerCase()) return false;
  db.run(`UPDATE invitations SET usedAt = ?, ... WHERE id = ?`, [now, id]);
  // create user-or-link-identity + membership source='invite' here
  return true;
});
```

Route guard (shape from `setup-token/route.js`):

```js
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch";

export async function POST(request) {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  // ...capability + scope checks, repo call, audit...
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
```

## Open Questions

1. **Re-auth mechanism for transfer**: inline password in transfer POST (recommended) vs purpose-scoped short-lived JWT à la `passwordChangeSession.js`? Needs orchestrator call — affects cookie surface.
2. **Invite accept for existing users**: can a token be accepted by an already-registered user (link + membership only), or new-password-account + post-SSO-login link only? Issue text supports both ("creates a password account, or links an SSO identity after SSO login") — confirm existing-user accept path expected.
3. **Role ceiling on invites**: can an invite pre-assign instance `admin`, or workspace roles only (manager/member/viewer)? Recommend workspace roles only; instance admin via existing admin flow.
4. **List pagination shape**: cursor vs page-based — check what `auditRepo.js`/usage list endpoints use; stay consistent.
5. **Personal-workspace cascade exact table list**: `deleteUserUnscoped` current extent vs YAN-361 ownership work — verify against current `deleteUserUnscoped` + `ownership.js` before finalizing cascade (avoid double-delete with YAN-361 tables).
6. **Token hash algorithm**: plain SHA-256 (recommended, 256-bit entropy, matches setup-token precedent) vs HMAC-with-server-key (ADR-0005 API-key style). Plain is sufficient; HMAC adds server-secret rotation burden for no gain at 256 bits.
7. **Invite token length**: 32 bytes base64url (~43 chars) matches setup token; shorter would still be safe but no reason to diverge.
