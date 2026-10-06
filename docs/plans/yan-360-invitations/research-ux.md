# UX Research: YAN-360 — invitations + admin user lifecycle APIs (GH #228)

Sources: GH #228 (YAN-360), `docs/users/spec.md` decisions 1–4/9, ADRs 0002/0003/0004 (binding), `docs/users/README.md` handbook §4/§5/§8, YAN-363 `research-ux.md` (show-once/prefix patterns). Code verified in worktree `.claude/worktrees/tokenhop-users-invitations` @ branch `users/yan-360-invitations`. YAN-373 owns all UI (M5); this lane covers server APIs only.

UI pattern precedent (YAN-363, adopted here): `CreatedBanner` show-once reveal, prefix-only lists, capability-driven chrome, `CopyStatus` live regions, `Modal` focus trap, no optimistic updates, single-user regression contract.

## Executive Summary

Today no invite/user APIs exist: one shared admin credential, no `users` table reads, memberships added via repo only. YAN-360 adds server-only invite + lifecycle + membership APIs behind `requireMultiUser()` (404 switch off). With switch off, byte-identical single-user behavior — hard regression contract.

Minimum complete API surface:

- `POST /api/invites` (capability `workspace.members.manage` in target workspace; admin/owner any workspace) — body: `workspaceId`, `role` (owner|manager|member|viewer), optional `email` binding. Returns **token once** (raw) + public metadata (id, workspace, role, expiresAt). List/detail never return token.
- `GET /api/invites` — rows the caller may manage only; token field absent, only `tokenLast4`/`tokenHint` for identification (same prefix-identification pattern as YAN-363 API keys).
- `DELETE /api/invites/:id` — revoke. Idempotent: second revoke returns 200 (not 404) so double-click/retry is safe.
- `POST /api/invites/accept` — public route, rate-limited (IP + token-hash key), accepts `{ token, password? }` for password accounts, or `{ token }` inside an SSO session to link identity with `source='invite'`. Same response shape for invalid/expired/revoked (no existence oracle).
- Admin lifecycle (`instance.users.manage`): `GET /api/users` (paginated list), `POST /api/users/:id/approve`, `PATCH /api/users/:id` (role), `POST /api/users/:id/disable|enable`, `DELETE /api/users/:id`, `POST /api/users/ownership-transfer` (owner only + re-auth).
- Membership (`workspace.members.manage`): `POST/DELETE /api/workspaces/:id/members`, `PATCH role`, enforcing last-manager/owner invariants via existing `assertNotLastManager`.

Judgment calls:

- **Token hashed server-side (SHA-256 minimum; HMAC preferred per ADR-0005 key precedent), single-use, 7-day expiry.** Raw token exists exactly once in create response. Accept endpoint consumes atomically (compare-and-delete in one transaction) to block double-accept races.
- **No email enumeration.** Accept failures (bad/expired/revoked/used token) return one generic 400 literal. Invite bound to email that doesn't match login identity → same generic 400, not "wrong email".
- **List endpoints never leak secrets/hashes** (one-api#2425 lesson, ADR-0002 metadata-vs-secrets split). Assert in tests: response JSON contains no `token`, `passwordHash`, `hash`, `secret` keys.
- **Disable bumps `sv` + revokes personal API keys** (existing `revokeUserApiKeysSync`); delete cascades personal workspace + DEK destroy, re-attributes shared rows to workspace, service keys survive.
- **Ownership transfer requires re-authentication** (fresh password verify or short-lived step-up token), not just session cookie. Never "whoever calls first".

## User Workflows

### Primary flows (API contract level; YAN-373 renders these)

1. **Admin invites by email.**
   - `POST /api/invites { workspaceId, role: "member", email: "sam@x.com" }` → `201 { id, workspaceId, role, email, expiresAt, token }` (`token` present only here).
   - Admin copies token into out-of-band channel (email delivery is YAN-373/out-of-scope; API returns token for admin to relay). Future UI shows same `CreatedBanner` show-once pattern as YAN-363.
   - Invitee `POST /api/invites/accept { token, password }` → account created (`instanceRole: user` or `pending` per JIT default — recommend `user` when arriving via valid invite since admin pre-authorized), membership `{ source: 'invite' }` applied, session cookie set. Response: `{ user, workspaceId }` only.
2. **Open invite (no email binding, household hand-out).**
   - Same create without `email`. Anyone with token accepts. Revoke any time. Future UI must warn "anyone with link can join" (same affordance as share-link warnings).
3. **SSO link via invite.**
   - Invitee SSO-logs-in first (JIT → `pending`), then `POST /api/invites/accept { token }` with session cookie → links membership `source='invite'`, upgrades from `pending` if invite grants access. Email-bound invite + SSO: match on verified IdP email only as authorization check, never as identity link key (ADR-0003: link by `(issuer, sub)`).
4. **Approve pending.**
   - `POST /api/users/:id/approve { instanceRole: "user" }` → user active. Pending users hold no session beyond awaiting-approval (ADR-0002).
5. **Disable / enable.**
   - `POST /api/users/:id/disable` → `status: disabled`, `sv` bump (sessions die ≤5s via cache TTL), personal keys revoked, response `{ success: true }`. Gateway calls with their keys → `401 Invalid API key` (indistinguishable literal, per YAN-363).
   - Enable reverses status + bumps `sv` again (old sessions stay dead; must re-login).
6. **Delete user.**
   - `DELETE /api/users/:id` → personal workspace + its connections/keys deleted (DEK destroyed post-M2), shared rows re-attributed, service keys survive, `sv` irrelevant (row gone). Response `{ success: true }`; GET afterward → 404. Owner cannot be deleted (403).
7. **Ownership transfer.**
   - `POST /api/users/ownership-transfer { targetUserId, password }` (owner session + fresh password proof) → roles swap atomically in one transaction. Old owner becomes admin. Audit event written. Without valid re-auth → 401, no state change.
8. **Membership change / remove.**
   - `PATCH /api/workspaces/:id/members/:userId { role }`, `DELETE ...` → enforce: cannot demote/remove last owner/manager (`LAST_MANAGER` → 409 with literal). IdP-sourced rows (`source='idp'`) rejected with 409 "managed by identity provider" (ADR-0003).

### Alternative / edge flows

- **Expired invite (7d):** accept → generic 400 "invalid or expired". List shows `Expired` pill (future UI); no resend endpoint in minimum — admin creates new invite, revokes old. (Recommend `POST /api/invites/:id/resend|rotate` as follow-up.)
- **Revoke then accept:** same generic 400. Revoke is idempotent 200.
- **Double accept race:** first wins 200+session; second gets generic 400 (token consumed). No partial account.
- **Manager invites into another workspace:** 403 (capability check is per-workspace `workspace.members.manage`). Cross-workspace invite IDs are 404 to non-members (invisible, not forbidden-looking).
- **Duplicate email invite:** create succeeds (new token each time); old tokens stay valid until expiry/revoke, or rotate-on-recreate (recommend: creating a second active invite for same email+workspace revokes prior — prevents token pile-up).
- **Self-removal:** leaving own workspace allowed unless last manager (409). Owner leaving owned workspace → 409.
- **Delete-while-logged-in:** target's sessions die (row gone); their in-flight gateway keys → 401 on next call.
- **Single-user mode:** all routes 404 switch off. No behavior change, no new literals.

## UI/UX Best Practices

### Industry standards (server enables, YAN-373 renders)

- **Show-once secret (GitHub PAT / Stripe pattern):** raw invite token in create-201 body only. List/detail carry `tokenHint` (last 4) + metadata. Reuse YAN-363 `CreatedBanner` + "won't be shown again" copy verbatim.
- **Prefix/hint identification:** `INV-…ab12` style hint in lists so admins distinguish multiple open invites without seeing secrets.
- **Capability-driven chrome:** future UI renders Create/Revoke/Approve/Disable/Delete controls only when caller holds the capability (ADR-0002 matrix). Server still enforces; hidden ≠ unprotected.
- **Destructive confirm:** future delete/disable/transfer dialogs need explicit typed or two-step confirm (transfer types workspace name or target email). Server requires re-auth for transfer regardless.
- **ARIA APG + live regions (future UI must follow):** `role="alert"` on accept-failure banner, `aria-invalid`+`aria-describedby` on password/email fields, `CopyStatus` polite region on copy-token button, focus trap in create modal, least-destructive default focus in delete confirms — all existing codebase patterns (see YAN-363 doc), no new patterns invented.

### Accessibility (future affordances the API must not block)

- Every failure returns a stable machine `code` + human `error` literal (mirrors `describeLoginError` map in `src/app/login/loginErrors.js`): UI maps codes to localized strings without parsing English. Unknown codes → generic fallback so crafted tokens can't inject text (same rule as login `?error=`).
- Token input accepts copy-paste with surrounding whitespace trimmed server-side; case preserved (tokens case-sensitive — UI must say so via code `invite_token_case_sensitive` hint).
- Password policy on accept reuses `validateNewPassword` codes (`password_too_short`, `password_too_long`, `password_reused`, `password_default`) so the accept form shows identical inline errors as login/change-password.
- RTL-safe: token/hint rendered `dir="ltr"` mono (same as YAN-363 prefix rule).

### Responsive / progressive

- No new polling. Invite list fetch-on-mount + refresh-after-mutation (existing `useApiKeys` pattern).
- Accept page works without JS beyond form POST (public route; future UI degrades to plain form + server redirect to `/login?accepted=1`).

## Error Handling

All errors: `{ error: "<human literal>", code: "<stable_snake>" }`, `Cache-Control: no-store`. Codes are the contract; literals are English defaults mapped in a future `inviteErrors.js` mirroring `loginErrors.js`.

| Endpoint                             | Trigger                                         | Status + code                            | Note                                                            |
| ------------------------------------ | ----------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| create                               | missing/invalid workspaceId, role, email        | 400 `invalid_request`                    | exact-field literal, mirrors `validateKeyName` style            |
| create                               | caller lacks `workspace.members.manage` there   | 403 `forbidden` (non-member target: 404) | no workspace-existence oracle for outsiders                     |
| create                               | role above caller's own (member inviting owner) | 403 `forbidden_role`                     | cannot grant what you don't hold                                |
| create                               | `source='idp'`-managed slot                     | 409 `idp_managed`                        | IdP sync owns it                                                |
| list/get                             | unknown id / other workspace                    | 404 `not_found`                          | identical body both cases                                       |
| revoke                               | already revoked/used/expired                    | 200 `{ success: true }`                  | idempotent by design                                            |
| revoke                               | no capability                                   | 403/404 as above                         | —                                                               |
| accept                               | bad/expired/revoked/consumed token              | 400 `invite_invalid`                     | one literal for all; no timing oracle (constant-time compare)   |
| accept                               | email-bound, identity mismatch                  | 400 `invite_invalid`                     | same literal, never "wrong email"                               |
| accept                               | weak/default password                           | 400 `password_too_short` etc.            | reuse `validateNewPassword` codes                               |
| accept                               | rate-limited                                    | 429 + `Retry-After`                      | IP + token-hash keys (YAN-358 limiter pattern)                  |
| users list                           | —                                               | 200 paginated `{ users, nextCursor }`    | cursor, not offset; no hash/secret keys present (test-asserted) |
| approve                              | already active                                  | 200 idempotent                           | —                                                               |
| approve/role                         | target is owner / demote owner                  | 403 `forbidden_target`                   | mirrors password-reset `mayReset` rule                          |
| disable                              | self / owner target                             | 403 `forbidden_target`                   | owner can't be disabled                                         |
| delete                               | owner target / last-manager violation           | 403/409                                  | `forbidden_target` / `last_manager`                             |
| transfer                             | not owner                                       | 403 `forbidden`                          | —                                                               |
| transfer                             | bad/missing re-auth                             | 401 `reauth_required`                    | no state change                                                 |
| transfer                             | target pending/disabled                         | 409 `invalid_target`                     | must be active user                                             |
| members add                          | already member                                  | 409 `membership_exists`                  | reuse `TenancyError` code                                       |
| members patch/remove                 | last manager/owner                              | 409 `last_manager`                       | existing `assertNotLastManager` literal                         |
| members                              | `source='idp'` row                              | 409 `idp_managed`                        | —                                                               |
| gateway (disabled/deleted user keys) | any call                                        | 401 `Invalid API key`                    | indistinguishable from bad key (YAN-363 rule)                   |
| login (pending)                      | password ok, not approved                       | 403 `account_pending`                    | existing `loginErrors.js` literal                               |
| login (disabled)                     | —                                               | 403 `account_disabled`                   | existing literal                                                |

Validation patterns: strict-shape bodies (reject unknown keys, same as password-reset route's `keys.length` check); `415` on non-JSON; `403 forbidden_origin` on cross-site (existing `isCrossSite`/`isJson` guards). No optimistic updates in future UI — mutate only after server confirm.

Privacy rules (binding): token/hash/password never in list/detail/audit/log; audit allow-list (`src/lib/users/audit.js` `ALLOWED`) gains only `inviteId`, `role`, `email` — never token. `GET /api/users` rows = `COLS` selection only (existing `usersRepo.js` excludes hash by construction).

## Performance UX

- Invite accept is one transactional POST (hash-compare + consume + create membership + optional user create). No extra round-trips; session cookie set on same response.
- Lists paginated (cursor, `limit` default 50, max 200) — user tables grow; offset pagination drifts under concurrent approve/delete.
- `sv` cache TTL ≤5s means disable/revoke lands on next request without a sessions table (ADR-0004); future UI needs no "force logout" spinner — one status refetch suffices.
- Rate limiter bounded (`MAX_ENTRIES` pattern from `loginLimiter.js`) keyed IP + token-hash so random-token probing can't grow memory.
- No new polling/long-poll for invite status; expiry computed from `expiresAt`, no sweeper required for correctness (lazy-expire on read; optional janitor later).

## Competitive Analysis

| Product                | Pattern worth copying                                                           | What we avoid                                                        |
| ---------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GitHub org invitations | Email-bound invite + role preset; accept links identity; failed invites generic | Their email-as-identity link — we bind `(issuer, sub)` (ADR-0003)    |
| GitLab group invites   | Expiry + revoke + re-invite; `source` tracking of how membership arose          | Invite privilege escalation — role capped at inviter's own           |
| Open WebUI RBAC        | `pending` default, admin approves                                               | Group sync wiping manual rows — our sync touches only `source='idp'` |
| LiteLLM Proxy          | Key lifecycle follows ownership (user key dies with user; service survives)     | Three-way ownership sprawl — single `workspaceId` column (ADR-0001)  |
| Slack/Notion invites   | Single-use link, revoke-anytime, idempotent revoke UX                           | Link-guessing enumeration — generic accept failures, hashed storage  |
| one-api #2425          | — (negative example)                                                            | Admin list leaking tokens/secrets — test-asserted absence            |

Consensus followed: **hash the token, show once, fail generically, revoke visibly, scope role at creation, lifecycle keys with user.**

## Recommendations

### Must have (ship with YAN-360)

1. Token: ≥128-bit random, stored hashed, single-use atomic consume, 7-day expiry, revocable, idempotent revoke-200.
2. Generic accept failure (`invite_invalid` single literal, constant-time compare); email mismatch indistinguishable.
3. Strict body shapes + `isCrossSite`/`isJson` guards on all new routes; `no-store` headers.
4. `GET /api/users` test asserting absence of `token|passwordHash|hash|secret` substrings in raw JSON.
5. Disable → `sv` bump + personal-key revoke; delete → cascade personal workspace, re-attribute shared, service keys survive; owner immutable except via transfer.
6. Transfer requires fresh re-auth, atomic role swap, audit write.
7. Last-manager/owner invariants on every membership mutation; `idp` rows rejected.
8. Audit hooks through existing `audit()` allow-list (add `inviteId` only — no token/email expansion beyond `email`).
9. Rate limit accept on IP + token-hash; 429 with `Retry-After`.
10. Switch-off 404 on every new route (`requireMultiUser`), single-user regression test.

### Should have (same PR if cheap, otherwise follow-up)

- Rotate-on-recreate: new invite for same email+workspace+role revokes prior active ones.
- `expiresAt` editable at create (1/7/30 days presets, default 7); keep 7-day max unless admin.
- Accept inside SSO session links identity without password (documented flow §3 above).
- `nextCursor` pagination shared helper if users list is first cursor-paginated endpoint.

### Nice to have (explicitly deferred to YAN-373 or later)

- Email delivery of invites; resend/rotate endpoint; invite usage dashboard.
- Setup-token reuse for first-SSO owner link display (ADR-0003 path, separate route).
- Expiry janitor job (correctness doesn't need it — lazy expiry suffices).
- Bulk invite (CSV); SCIM.

## Open Questions

1. Invite default `instanceRole` on accept: `user` (pre-authorized by inviter) vs `pending` (JIT default)? Recommendation: `user` when invite valid — inviter already approved — but needs maintainer confirm (touches YAN-359 JIT default).
2. Should creating a duplicate active invite revoke the old one, or allow multiples? Recommendation: revoke prior (prevents token pile-up); confirm.
3. Token hash algorithm: plain SHA-256 vs HMAC-with-master-key (ADR-0005 uses HMAC for low-entropy legacy keys; invite tokens are ≥128-bit so plain SHA-256 suffices — confirm security lane agrees).
4. `tokenHint` format: last-4 vs `INV-…ab12`? Recommendation: last-4 of hex, prefixed `invite_`, mirroring `th_` prefix display rule.
5. Email delivery in scope for YAN-373 only, or never (admin relays manually)? Affects whether create response needs a `mailto:`/copy affordance vs full send pipeline.
6. Ownership transfer re-auth mechanism: password re-verify vs short-lived step-up token? Recommendation: password re-verify (code exists: `verifyPassword`), no new token type.
7. Should `GET /api/users` include membership/workspace summary inline, or require per-user fetch? Recommendation: flat list now (privacy-minimal); YAN-373 fetches memberships per workspace.
