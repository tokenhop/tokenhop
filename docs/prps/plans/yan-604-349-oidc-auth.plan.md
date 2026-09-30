# Plan: OIDC HS256 id_tokens + SSO-only auth-mode lockout (YAN-604 / #391, YAN-349 / #217)

## Summary

Two `v0.5.x` patch bugs in single-user SSO, shipped together (same target, both touch
`src/lib/auth/oidc.js`). Not gated by any switch: they repair shipped behavior.

- **YAN-604**: `verifyOidcIdToken` only verifies through the remote JWKS, so HS256 id_tokens
  signed with the client secret (authentik with no signing key) always fail. Also found in
  research: jose v6 `jwtVerify` has **no `nonce` option**, so the nonce passed today is silently
  ignored and never checked.
- **YAN-349**: the Settings UI saves `authMode: "sso"`, but `getOidcRuntimeConfig()` only
  accepts `oidc`/`both`, so "SSO only" makes `/api/auth/oidc/start` redirect to
  `oidc_not_configured` while password login is refused: total lockout.

## Branching

Target `v0.5.x` → branch `fix/yan-604-oidc-auth-hs256-and-mode-lockout` off `origin/master`,
PR into `master`, label `backport:0.5`, then cherry-pick to `release/0.5` (RELEASING.md rule 4).

## Design

### 1. One auth-mode helper — `src/lib/auth/authModes.js` (new, pure, client-safe)

```js
resolveAuthModes({ authMode, ssoType }) → { password, oidc, saml, protocol, ssoOnly }
```

- `password` mode → password only. `both` → password + SSO. `sso` / legacy `oidc` / legacy
  `saml` → SSO only.
- Protocol: legacy `oidc`/`saml` modes name their protocol; `sso`/`both` use `ssoType`
  (`oidc` default when missing/unknown).
- Used by: `getOidcRuntimeConfig`, `/api/auth/login`, SAML start + ACS (new mode gate, same as
  OIDC), `/api/auth/status` (`ssoType: modes.protocol`), `loginVisibility.js`, login page (drops
  its inline duplicate), settings PATCH guard.

### 2. Lockout guard — `PATCH /api/settings`

When the body touches `authMode`, `ssoType`, or OIDC/SAML config keys: merge body over current
settings; if the result is SSO-only and the chosen protocol is not configured
(`isOidcConfigured` / `isSamlConfigured`), return **400** with the reason. `authMode: "password"`
(the CLI recovery path) always passes. Patches that don't touch auth keys are not blocked.

### 3. id_token verification — `verifyOidcIdToken`

- Allowed algs = discovery `id_token_signing_alg_values_supported` minus `none`; when absent,
  default to the asymmetric set (RS/PS/ES/EdDSA), so existing RS256 setups behave as before.
- Read the header alg (`decodeProtectedHeader`); reject `none` / unadvertised algs.
- `HS256/384/512` → verify with the client secret's UTF-8 octets (OIDC Core §10.1); else
  `createRemoteJWKSet(jwks_uri)`. `jwtVerify(..., { issuer, audience, algorithms: [alg] })`.
- Enforce `payload.nonce === nonce` explicitly.

### 4. `/api/auth/oidc/test`

Adds `signingAlgs`, `jwksKeyCount` (fetch of `jwks_uri`, `null` when unreachable) and
`warnings[]` (HS-only → verified with client secret; empty JWKS; `none` advertised). The OIDC form
appends warnings to its test message.

### 5. Visible and logged failures

- `/login` reads `?error=`, maps known codes to plain-English messages (unknown text shown
  truncated, rendered as text), shows a `Callout variant="err"`, and strips the param from the
  URL. Pure mapper in `src/app/login/loginErrors.js`.
- OIDC callback and SAML ACS/start log `console.warn("[OIDC] …", reason)` — reason only, never
  tokens or assertions.

### 6. Recovery docs

`gitbook/content/en/troubleshooting.md`: "Locked out after enabling single sign-on" — CLI
`9router` → Settings → Reset Auth Mode to Password (PATCH `/api/settings` with the machine CLI
token, local host only).

## Tasks (parallel, disjoint regions)

| Task        | Scope                                      | Files                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (YAN-604) | §3, §4, OIDC callback wiring + logging     | `src/lib/auth/oidc.js` (verify section only), `src/app/api/auth/oidc/callback/route.js`, `src/app/api/auth/oidc/test/route.js`, `.../sso/OidcForm.js` (`testMessage`), `tests/unit/oidc-verify.test.js`, `tests/unit/oidc-test-route.test.js`                                                 |
| B (YAN-349) | §1, §2, §5 (login page + SAML logging), §6 | `src/lib/auth/authModes.js`, `src/lib/auth/oidc.js` (`getOidcRuntimeConfig` line only), login/status/saml routes, `loginVisibility.js`, `login/page.js`, `loginErrors.js`, settings route, troubleshooting doc, `tests/unit/auth-modes.test.js`, settings-validation + login-visibility tests |

## Tests (critical only, local fixtures, no real IdP)

- RS256 token vs local JWKS server; HS256 token signed with the client secret; `alg: none`,
  unadvertised alg and nonce mismatch rejected.
- Test route: alg list, empty-JWKS and HS-only warnings.
- Every `authMode` × `ssoType` combination for OIDC start, SAML start and password login.
- Lockout guard 400 / allowed cases; login error mapping.

## Validation

`npm run lint`, `npm test` (baseline gate, known-fails empty), `npm run build`.

## Risks

- Enforcing nonce may reject an IdP that drops `nonce` (spec-required when sent) — security fix,
  called out in the PR.
- SAML now requires an SSO auth mode to start, matching OIDC; SAML buttons were already hidden in
  password mode.
- The guard changes UX: pick "Password + SSO", configure and test, then switch to "SSO only".
