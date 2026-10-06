# Security Research: YAN-359 SSO identity linking, JIT provisioning, group mapping

Source: @oracle read-only review (session ses_ef16d59d5fferb3IvtP0k7pWrg), saved by parent. Branch state at review `dcae2aa3`: no JIT/group code exists yet; `sessionClaims()` (session.js:278) still refuses non-owner SSO links.

> **Attribution note.** The tables below are the parent's condensed version and mix the reviewer's findings with parent decisions (notably C6 and the C1/C4/C5 mitigations). The authoritative reviewer position, including severity regrades, is the **Reconciliation** section at the end of this file. Where they differ, Reconciliation wins.

## Executive Summary

Live OIDC/SAML verification is sound on the core path (PKCE+nonce+state, `validateInResponseTo: always`, HS* gated on advertised algs, `none` rejected). The risk is around it: identity binding, owner bootstrap, what `pending` can reach, revocation latency, unvalidated admin SSO config and host-header-derived redirect URIs. The highest-risk new surface is group → role/workspace sync: IdP-asserted group names must never escalate to owner-equivalent roles or unbounded memberships, and re-sync must never touch `source='manual'` rows.

## Findings by Severity

### CRITICAL — Hard Stops

| #   | Finding                                                                                      | File / function                                                                                | Required Mitigation                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Host-header-derived callback origin when `BASE_URL` unset; poisoned OIDC redirect / SAML ACS | `src/lib/auth/oidc.js:23-39` `getPublicOrigin`, `src/lib/auth/saml.js:79-107` `getSamlBaseUrl` | Pre-existing; gate forwarded headers like `getClientIp` (trusted peer). Candidate follow-up issue, not YAN-359 scope unless trivially shared    |
| C2  | `setupToken` in query string (logs/history/referer)                                          | `src/lib/users/bootstrap.js:51-57,273-288`, oidc/saml start routes                             | Existing single-use 256-bit 60-min hashed token limits impact; add `Referrer-Policy: no-referrer` on start routes if cheap; otherwise follow-up |
| C3  | `claimOwnerEmail` spent even when linking fails                                              | `src/lib/users/bootstrap.js:253-254` (ponytail admits)                                         | Pre-existing YAN-356 behaviour; follow-up issue                                                                                                 |
| C4  | Owner email link has no issuer pin; SAML asserts `emailVerified:true` unconditionally        | `bootstrap.js:234-271`, `saml/acs/route.js:59-67`                                              | Pre-existing; record as follow-up. YAN-359 must not widen email linking (no general email linking)                                              |
| C5  | SAML `wantAssertionsSigned:true` without `wantAuthnResponseSigned`                           | `saml.js:109-124` `createSamlInstance`                                                         | Pre-existing; follow-up with negative test                                                                                                      |
| C6  | Group → role elevation by default                                                            | new JIT code                                                                                   | Group map roles limited to `manager\|member\|viewer`, never`owner`; owner never synced;`adminGroups` explicit admin opt-in, audited             |

### WARNING — Must Address

| #   | Finding                                             | File / function                           | Suggested Mitigation                                                                         | Alternatives                                         |
| --- | --------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| W1  | SAML always "verified" email                        | `saml/acs/route.js:59-67`                 | No email-based linking for non-owner users in YAN-359                                        | Per-protocol admin flag later                        |
| W2  | UserInfo confused-subject                           | new `fetchOidcUserInfo`                   | Same access token; require `userinfo.sub === id_token.sub`; fail closed; one source only     | —                                                    |
| W3  | Pending reach                                       | `principal.js:81-92`, `session.js:95-100` | No full `auth_token` for pending; redirect to waiting page without session                   | Purpose-scoped token (passwordChangeSession pattern) |
| W4  | 5 s session cache window                            | `usersRepo.js:61-109`                     | Bump sv synchronously in login transaction; document window                                  | DB-backed cache later                                |
| W5  | IdP re-sync could touch owner                       | `usersRepo.js:235-270`                    | Owner exempt from sync                                                                       | —                                                    |
| W6  | OIDC callback lacks limiter; state oracle           | `oidc/callback/route.js`                  | Reuse existing limiter if cheap; generic codes                                               | Follow-up                                            |
| W7  | Discovery/JWKS per login, SSRF via admin issuer URL | `oidc.js:63-70`                           | UserInfo endpoint taken only from discovery of configured issuer; fetch timeout              | SSRF blocklist follow-up                             |
| W8  | SAML cert not validated at PATCH                    | `saml.js`, `validateSettings.js:91-93`    | Follow-up                                                                                    | —                                                    |
| W9  | Nested `groupsClaim` path / prototype pollution     | new reader                                | Read-only walk, depth ≤5, reject `__proto__/constructor/prototype`, accept string array only | —                                                    |
| W10 | Forwarded host trusted inconsistently               | `oidc.js:30-36`, `saml.js:90-100`         | Same as C1                                                                                   | —                                                    |
| W11 | JIT race                                            | `usersRepo.js:191-233`, schema UNIQUE     | Create user+identity in one transaction; on `IDENTITY_TAKEN` re-read and continue as login   | —                                                    |
| W12 | Membership writes don't bump sv                     | `membershipsRepo.js:90-142`               | Sync bumps sv once when role/memberships change                                              | —                                                    |
| W13 | Audit allowlist lacks issuer/groups                 | `users/audit.js:7-31`                     | Audit roles/counts/workspaceIds; no raw groups or tokens                                     | Extend allowlist deliberately                        |

### ADVISORY — Best Practices

| #     | Finding                                    | Benefit           | Recommendation                                                | Defer Justification      |
| ----- | ------------------------------------------ | ----------------- | ------------------------------------------------------------- | ------------------------ |
| A1    | Token endpoint parsed as JSON only         | Compatibility     | Accept form                                                   | Fails closed today       |
| A2    | Client-secret probe oracle                 | —                 | Keep admin-only                                               | Admin-only               |
| A3    | Setup token length regex                   | Forward compat    | Derive from constant                                          | Size fixed               |
| A4/A5 | Alg allowlist and pre-verify header        | —                 | No change                                                     | Safe                     |
| A6    | SAML replay cache single-process           | —                 | Keep                                                          | ADR-0004 single process  |
| A7    | Switch-off parity                          | Releasable trunk  | All JIT behind `isMultiUserEnabled()`; switch-off matrix test | Required, not deferrable |
| A8    | JIT username collisions / reserved `owner` | Login reliability | Derive sanitized username, suffix on collision, never `owner` | —                        |
| A9    | Pin-once precedent (`samlIssuer`)          | —                 | Reuse                                                         | —                        |
| A10   | `account_pending` existence signal         | —                 | Reuse existing code                                           | Accepted                 |

## Authentication and Authorization

- Identity key `(provider, issuer, subject)` UNIQUE already (schema.js:197). OIDC issuer from verified `payload.iss`; SAML issuer from validated assertion, pinned issuer setting.
- Never link by email alone. Owner link stays `TOKENHOP_OWNER_EMAIL` one-shot or setup token (bootstrap.js).
- `can()` denies pending everything; never add pending exceptions.
- Sync touches only `source='idp'`; `assertNotLastManager` still applies.
- `defaultRole ∈ {pending, user}` validated.

## Data Protection

New settings are non-secret, admin-only via `instance.settings.manage`. Audit roles/counts, not raw group arrays or tokens. Log `error.message` only.

## Dependency Security

| Dependency           | Version | Known Issues                                | Risk Level      | Alternative                   |
| -------------------- | ------- | ------------------------------------------- | --------------- | ----------------------------- |
| jose                 | ^6.1.3  | none relevant                               | Low             | —                             |
| @node-saml/node-saml | ^5.1.0  | response-signature not required (C5 config) | Medium (config) | Keep; set option in follow-up |

No new dependencies; nested path reader and normalization are stdlib.

## Input Validation

| Setting               | Validation                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| groups claim          | string ≤256, `.`-segments `[A-Za-z0-9_:-]+`, depth ≤5, reject proto segments                       |
| allowed/admin groups  | string arrays, each ≤256, capped count                                                             |
| group workspace map   | entries `{group, workspaceId (existing shared workspace), role ∈ manager\|member\|viewer}`, capped |
| default role          | enum `pending\|user`                                                                               |
| SAML groups attribute | same as attribute selectors                                                                        |

Runtime groups: accept array of strings (or single string); drop others; cap 100 × 256; exact match.

## Infrastructure Security

Switch-off parity mandatory. SSRF and forwarded-host trust are pre-existing; UserInfo uses discovery endpoint with timeout. Single-process caches documented.

## Secure Coding Guidelines

1. One transaction per JIT provision; UNIQUE race re-read.
2. Diff sync, never wipe; sv bump iff changed.
3. Owner exempt; pending gets no full session; allowedGroups miss gets no session.
4. Role ceilings enforced at validation and sync.
5. UserInfo sub cross-check.
6. Audit every branch with allowlisted fields.
7. No new dependencies.

## Trade-off Recommendations

- Pending: no session + waiting page (simplest, safest).
- `allowedGroups` empty: no group restriction (documented); JIT still yields `pending` by default, so admins approve.
- `adminGroups`: explicit list grants admin (issue scope); only demote admins whose admin came from IdP (needs provenance) — see spec decisions.
- UserInfo fetched per login only when claim absent.

## Open Questions

1. Empty `allowedGroups` semantics.
2. Manual admin provenance on demotion.
3. SAML transient NameID handling.
4. `sub` rotation recovery (YAN-360 adjacent).
5. Owner issuer pin (follow-up).
6. Group normalization (exact match v1).

## Decisive negative tests

1. UserInfo `sub` ≠ id_token `sub` → login fails, no groups applied.
2. Groups `["__proto__", huge string, object]` → ignored safely.
3. Concurrent same-sub first login → one user, one identity.
4. All groups removed → idp rows deleted, manual rows survive, sv bumped.
5. Owner outside adminGroups → still owner, sync skipped.
6. Pending JIT user → no auth cookie; dashboard/API denied.
7. Switch off → OIDC/SAML behaviour identical to today, no JIT rows.
8. Settings PATCH with map role `owner` / unknown workspace / bad claim path → 400.
9. Same email, different sub → distinct account, no link.

## Reconciliation (authoritative reviewer position)

Source: @oracle reconciliation pass (same session), read-only, verified against `dcae2aa3`. **[S]** = reviewer recommendation; parent decisions are recorded separately in `feature-spec.md`.

### Corrections to the condensed tables above

1. **C6** — reviewer's original text recommended _against_ `adminGroups` → admin. Withdrawn: it contradicts the binding issue (adminGroups setting plus promotion/demotion tests). Groups only reach authorization through a verified id_token, a sub/iss-matched UserInfo response, or a signed assertion from the configured IdP. So escalation requires IdP key compromise or `instance.settings.manage`, both already full instance control. **adminGroups → admin is in scope.** Hard ceilings stay: never `owner` (instance or workspace); map roles ≤ `manager`; `ssoDefaultRole ∈ {pending, user}`; every promote/demote audited.
2. **C1/C4/C5 regraded** (no constructed exploit on the current single-issuer, IdP-registered-redirect path; all pre-existing):
   - C1 host-header origin → **WARNING**. Code capture is blocked by IdP exact redirect-URI matching and SAML audience checks. Residual: attacker-host redirect on error paths when `BASE_URL` and settings `baseUrl` are both unset. Follow-up issue.
   - C4 owner-link issuer pin → **ADVISORY**. `getOidcRuntimeConfig` and `jwtVerify` accept exactly one configured issuer; a second IdP has no code path. Hardening for future multi-IdP.
   - C5 `wantAuthnResponseSigned` → **WARNING** hardening. InResponseTo is enforced twice, audience is checked and skew is 60 s. Follow-up with an unsigned-response negative test (may break IdPs that sign only assertions).
3. **C2** — firmer than the condensed text: do the two cheap mitigations in YAN-359 because the start routes are touched anyway: `Referrer-Policy: no-referrer` on the start routes, and redact `setupToken` from any request log.
4. **W6** — in scope, not a follow-up: OIDC callback limiter parity with account-bucket keys `provider:issuer:sub`, since JIT admission denial is a new abuse surface.
5. **sv on membership change** — mandatory (issue text: "Bump `sv` when role or memberships change"). Technical research D3 (no bump on membership-only change) must not be implemented.
6. **Pending cookie** — reviewer recommends against any display-name/email cookie on the public pending page.

### Verified, in YAN-359 scope

Remove the enabled-path unlinked-SSO → owner fallback (`session.js:289-296`, the issue's opening bug); UserInfo `sub` binding (W2); `sv` bump on role or membership change; pending gets no session; safe nested-path reader (W9); JIT race/atomicity (W11); audit fields (W13); OIDC limiter plus account bucket; switch-off and marker-latched-off matrices; setup-token cheap mitigations.

### Verified, pre-existing → follow-up issues

C3 claim-before-link (`bootstrap.js:253-254`); C5 response signing; W8 SAML cert parse at PATCH; C1 residual forwarded-host gating; A1 form-encoded token response.

### Speculative hardening

C4 issuer pinning; C1 as originally filed; SSRF blocklist beyond an issuer-scoped UserInfo endpoint with a timeout.

### Reviewer decision recommendations [S]

| #   | Topic                  | Recommendation                                                                                                                                                       |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pending                | Public generic waiting page, no cookie, 404 when off; `validateSessionToken` keeps rejecting pending                                                                 |
| D2  | sv                     | One bump per login when role or any idp membership changes; none when unchanged                                                                                      |
| D3  | Owner fallback         | Removed on the enabled path; pristine switch-off unchanged                                                                                                           |
| D4  | Gates                  | Admission/JIT/sync gated on latch-aware `isUserSecurityEnforced()`; UI/settings visibility on `isMultiUserEnabled()`                                                 |
| D5  | Manual admins          | Demote admin→user when outside adminGroups, plus a save-time guard refusing settings that would demote existing non-owner admins (alt: `users.roleSource` migration) |
| D6  | Pending in adminGroups | Promote straight to admin, audited (alt: wait for human approval)                                                                                                    |
| D7  | Empty allow-list       | Allow everyone; pending default still gates                                                                                                                          |
| D8  | Owner vs allow-list    | Owner assertion bypasses allow-list, audited; nothing consumed on a plain denial                                                                                     |
| D9  | Last manager           | Roll back whole sync, login proceeds with prior state, audited (alt: deny login)                                                                                     |
| D10 | Map keying             | Store workspace id; resolve name→id at save; unknown/ambiguous → 400                                                                                                 |
| D11 | Duplicate email        | Create with `email=NULL`, keep `emailAtLink`; never merge                                                                                                            |
| D12 | Multi-IdP              | Single sync authority (one active protocol); protocol flip clears old idp rows on next login, audited                                                                |
| D13 | UserInfo               | Only when claim key absent; exact sub/iss match; fail closed before writes; timeout; no token logging                                                                |
| D14 | SAML email             | Owner-link semantics unchanged; no general email linking in YAN-359                                                                                                  |
