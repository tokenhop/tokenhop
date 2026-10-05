# YAN-358 — Multi-account password login UX (design only)

> Lane: UX/design. Backend plan (`yan-358-password-login.plan.md`) written
> independently by planner. This file documents the UI contract so the two can
> be reconciled. **API shapes below are assumptions for the backend owner, not
> decisions.**

Branch: `users/yan-358-password-login`. No new deps, no locale/i18n file edits
(literals bot owns those; all new strings are plain English JSX literals like
the rest of `src/app/login/`).

## Sources read

- `src/app/login/page.js` — current login (single password field, must-change
  flow, SSO buttons, rate limit, `?error=` handling)
- `src/app/login/loginErrors.js` — `describeLoginError` allowlist map
- `src/app/(dashboard)/dashboard/settings/sections/SecuritySection.js` —
  self-service password change (current/new/confirm)
- `src/app/api/auth/status/route.js` — already returns `multiUserActive`
  (absent when switch off)
- `src/app/api/auth/login/route.js` — `mustChangePassword` 403 pattern, no
  token issued, rate limiting
- `src/app/api/settings/route.js` (PATCH password block) — current-password
  verification + `revokeOwnerSessions`
- ADR-0003 (identity/bootstrap, login limiter keying, YAN-358 scope),
  ADR-0009 (switch-off = byte-for-byte today)

## Before / after

**Before (single-user, today):** password-only form. `?error=` from SSO
redirects mapped through `loginErrors.js` allowlist. Remote default password →
`mustChangePassword` 403 → restricted "Set password" form (New password only,
re-auth via the typed default as `currentPassword` against
`PATCH /api/settings`).

**After:**

1. **No visible change** when `multiUserActive` is absent or `false`
   (switch off, or on but single active user). Same DOM, same strings.
2. **`multiUserActive === true`** → an account field appears **above** the
   password field (autofill order: username then current-password):
   - Label `Email or username`, `name="username"`,
     `autoComplete="username"`, `required`, `autoFocus` moved from the
     password field to this field (password keeps `autoComplete
="current-password"`).
   - Hint text under the field: none (keep minimal; placeholder
     `you@example.com or username`).
   - Card subtitle switches to `Sign in with your account` only in this
     state (was `Enter your password to access the dashboard`).
3. **`?error=` stays sanitized plain text.** `loginErrors.js` MESSAGES gains
   grounded entries (exact wording, feel free to reconcile with backend):
   - `invalid_credentials` → `Invalid email/username or password.` (one
     generic message for unknown account AND wrong password — no
     enumeration; never echoes the typed account back)
   - `account_pending` → `This account is waiting for an admin to approve it.`
   - `account_disabled` → `This account has been disabled by an admin.`
   - `password_change_required` → `Your password must be changed before you
can sign in.`
   - unknown key keeps the existing `Sign-in failed. Try again.` fallback
     (crafted links still can't inject text). Display stays the existing
     `Callout variant="err" title="Sign-in failed"` block.
4. **Forced change before a normal session** (admin-set temporary password):
   reuses the existing restricted pattern, not a full session:
   - Login returns 403 + `mustChangePassword: true` (assumption: same flag
     the default-password path already uses; backend may add
     `reason: "temporary"` — UI ignores unknown fields).
   - No session cookie is issued (same CVE-2026-56679-class rationale as
     today's default-password branch).
   - Login page swaps to a restricted card (existing `mustChange` branch,
     extended): read-only account display line (`Signed in as
{account}` only when an account field was used), then the existing
     single `New password` Input (`autoComplete="new-password"`). The typed
     temporary password is re-sent as `currentPassword` on the change call —
     identical trust model to today's default-password flow, zero new
     credential surface.
   - Wording: `Password change required` / `An admin set a temporary
password. Choose your own password to continue.` (default-password
     case keeps its current wording).
5. **Self-service per-account password change** (dashboard):
   `SecuritySection.js` form already requires `currentPassword` + new +
   confirm — that shape is correct and stays. Only scope changes:
   - Copy `Change the dashboard password…` → `Change your password…` when
     `multiUserActive` (via `/api/auth/status`, already fetched by the
     dashboard shell — assumption; if the settings page doesn't already have
     it, pass `multiUserActive` down as a prop rather than a new fetch).
   - Submit contract stays `{ currentPassword, newPassword }`; endpoint
     assumption: still `PATCH /api/settings` for the owner, and the backend
     plan decides a `/api/users/me/password` route for non-owners. UI should
     target whichever route the backend plan lands on — flagged below.
   - Success/failure behavior unchanged (`Password updated successfully`,
     401 `Invalid current password` shown via the existing Callout).

## States matrix

| State                              | Trigger                                      | UI                                                                                                                                 |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Loading                            | `/api/auth/status` pending                   | Existing skeleton (unchanged)                                                                                                      |
| Single-user password               | `multiUserActive` falsy                      | Today's form, byte-for-byte                                                                                                        |
| Multi-user password                | `multiUserActive === true`                   | Account field + password                                                                                                           |
| Login failure                      | 401                                          | Generic error under password Input (`error` prop → `aria-invalid` + described-by); account field shows no error (anti-enumeration) |
| Rate limited                       | 429 + `retryAfter`                           | Existing countdown, `role="status"`, button `Wait Ns` (unchanged)                                                                  |
| Forced change (temp pw)            | 403 `mustChangePassword` after valid temp pw | Restricted card: account line + New password only                                                                                  |
| Forced change (default pw, remote) | existing path                                | Today's restricted card, unchanged                                                                                                 |
| SSO redirect error                 | `?error=`                                    | Existing sanitized Callout, extended MESSAGES                                                                                      |
| SSO-only mode                      | `passwordAvailable` false                    | Unchanged                                                                                                                          |

## Interactions & accessibility (all existing primitives — Card, Input, Field, Button, Callout; coral focus ring, `role="alert"` err Callout, Input error wiring)

- Account + password in one `<form>`; Enter submits; Tab order natural
  (account → password → Login). `autoFocus` on account field only when it is
  rendered; otherwise password keeps it (preserves today's single-user focus).
- Errors announced: login 401 uses the password Input's `error` prop
  (Field wires `aria-describedby`/`aria-invalid`); SSO `?error=` keeps
  `Callout variant="err"` (`role="alert"`). No toast, no new component.
- Anti-enumeration: one generic message covers wrong account and wrong
  password; account value never reflected in any error; timing
  normalization is a backend concern (noted for the backend plan).
- No new animations, no layout changes beyond the inserted field; restricted
  card keeps `Callout variant="warn"` header.

## Exact UI file scopes (implementation, later, this session)

| File                                                                 | Change                                                                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/login/page.js`                                              | `account` state; render field when `status.multiUserActive`; include `account` in login POST body when present; restricted card account line + temp-password wording |
| `src/app/login/loginErrors.js`                                       | Add 4 MESSAGES entries (allowlist stays closed)                                                                                                                      |
| `src/app/(dashboard)/dashboard/settings/sections/SecuritySection.js` | Per-account copy when multi-user; endpoint per backend plan                                                                                                          |
| tests (owner: parent)                                                | suggested: multi-user render (field present/absent), generic error, temp-password restricted flow                                                                    |

Nothing else. No `Input`/`Field`/`Callout` edits, no new components, no CSS.

## API contract assumptions (backend plan must confirm/replace)

1. `GET /api/auth/status` — already returns `multiUserActive` when the switch
   is on; UI treats absent/`false` identically. **No change needed.**
2. `POST /api/auth/login` — accepts optional `account` (email or username
   string) alongside `password`; with `multiUserActive`, missing/unknown
   account and wrong password both return 401 with one generic error (same
   text as `invalid_credentials` above); `account_pending`/`account_disabled`
   return 403 with those `error` codes; temp password returns
   403 `{ mustChangePassword: true }` and **no session cookie**. Rate limit
   still 429 + `retryAfter`.
3. Password change from the restricted card — today's flow PATCHes
   `/api/settings` with `{ currentPassword, newPassword }` while holding no
   JWT. Multi-user assumption: same body, backend-owned route (could be
   `/api/auth/login` with `newPassword`, or a `/api/auth/change-password`
   route that re-verifies the temp password). UI only needs: request body
   `{ currentPassword, newPassword }` (+`account` if field present) and
   401/400 `error` strings. Backend plan names the route.
4. Self-service change (signed-in session) — `{ currentPassword, newPassword }`
   in, `{ ok }` / 401 `Invalid current password` out; per-account scoping and
   `revokeOwnerSessions`-equivalent sv bump are backend concerns.

## Coordination notes for the backend plan

- Login limiter keys on IP + account (ADR-0003) — invisible to UI.
- Single-user byte-for-byte guarantee (ADR-0009 rule 2): the account field
  must not render on any code path where `multiUserActive` is falsy,
  including the `/api/auth/status` failure fallback (that fallback currently
  omits the flag → single-user UI — correct, keep).
- The restricted temp-password flow intentionally mirrors the default-password
  flow's no-token-before-rotation guarantee; if the backend plan instead
  issues a scoped change-only token, the UI change is limited to dropping
  `currentPassword` from the change call — same form either way.
- Admin UI that sets temporary passwords is a different issue; nothing here.

Validation owner: parent session.
