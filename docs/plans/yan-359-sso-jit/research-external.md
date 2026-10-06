# YAN-359 SSO JIT Provisioning — External Docs Research

Scope: verified external documentation for OIDC (jose) and SAML (node-saml) identity extraction supporting JIT user/group provisioning. Versions verified against worktree `package.json`: `jose ^6.1.3`, `@node-saml/node-saml ^5.1.0`. No new dependencies proposed.

## Executive Summary

- **OIDC identity anchor is the verified id_token `sub`.** OIDC Core requires `iss` to exactly match the discovery issuer and `aud` to contain the client_id; `sub` is a case-sensitive, ≤255-ASCII-char, locally unique, never-reassigned identifier within the issuer. `jose.jwtVerify` with `{ issuer, audience, algorithms }` covers signature + these claims today (`src/lib/auth/oidc.js:268`).
- **UserInfo is optional and secondary.** If used, OIDC Core §5.3.2 mandates the UserInfo `sub` MUST be verified to exactly match the id_token `sub`; on mismatch the UserInfo values MUST NOT be used. Token exchange (`exchangeOidcCode`) already returns `access_token`; a UserInfo call is a plain `fetch` with `Authorization: Bearer` — no new SDK needed.
- **Groups claim location varies by provider config.** With authentik, claims come from OAuth2/OIDC scope mappings (e.g. a `groups` scope mapping emitting group names). Whether claims appear in the id_token vs only via UserInfo is controlled by the provider's "Include claims in id_token" setting (see Open Questions for verification caveat).
- **SAML identity anchor is `(issuer, NameID)` with signature-validated InResponseTo binding**, already enforced in `src/lib/auth/saml.js` via `validateInResponseTo: always` plus a pre/post InResponseTo double-check. `@node-saml/node-saml` v5 supports an optional `idpIssuer` option that rejects responses whose Issuer mismatches (`verifyIssuer`, node-saml `src/saml.ts:1160-1174`); tokenhop does not set it today — that is the trusted-issuer gap.
- **Missing vs empty group claims must be treated differently** for JIT sync: absent claim = provider said nothing (leave user's groups untouched); empty array = explicit "no groups" (demote). OIDC Core says claims with no value SHOULD be omitted, not JSON null — but defensive code must reject `null`/non-array shapes.
- **SAML multivalued attributes are arrays in node-saml profiles** (single value → scalar, repeated `AttributeValue` → array); group attributes must normalize both shapes. NameID format defaults to `emailAddress` in node-saml — email is mutable, so stable identity for JIT needs the IdP configured for `persistent` NameID (authentik supports NameID property mapping selection).

## Primary APIs

| API                                                                      | Role                                                                      | Reference                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET {issuer}/.well-known/openid-configuration`                          | Discovery: endpoints, `id_token_signing_alg_values_supported`, `jwks_uri` | OIDC Discovery; used by `fetchOidcDiscovery` (`src/lib/auth/oidc.js:63`)          |
| `POST token_endpoint` (authorization_code + PKCE S256)                   | Code exchange → `id_token`, `access_token`                                | OIDC Core §3.1.3; `exchangeOidcCode` (`src/lib/auth/oidc.js:107`)                 |
| `GET/POST userinfo_endpoint` with `Authorization: Bearer <access_token>` | Optional richer claims (groups)                                           | OIDC Core §5.3.1/§5.3.2 — <https://openid.net/specs/openid-connect-core-1_0.html> |
| JWKS (`jwks_uri`)                                                        | Signing keys for id_token verification                                    | `createRemoteJWKSet` in `verifyOidcIdToken` (`src/lib/auth/oidc.js:264`)          |
| SAML HTTP-POST ACS (`/api/auth/saml/acs`)                                | Assertion consumer                                                        | `validatePostResponseAsync` (`src/lib/auth/saml.js:190`)                          |

Verified spec text (fetched 2026-10-06 from <https://openid.net/specs/openid-connect-core-1_0.html>):

- ID Token validation: "The Issuer Identifier for the OpenID Provider … MUST exactly match the value of the `iss` (issuer) Claim." Client MUST validate `aud` contains its `client_id` (aud MAY be an array; single-audience case MAY be a string). `sub` is "locally unique and never reassigned identifier within the Issuer … MUST NOT exceed 255 ASCII characters … case-sensitive string."
- UserInfo sub check: "… MUST be verified to exactly match the `sub` Claim in the ID Token; if they do not match, the UserInfo Response values MUST NOT be used."
- Null/missing: claims "with no value SHOULD be omitted from the object and not represented by a JSON null value."

## Libraries and SDKs

### jose (declared `^6.1.3`)

Docs: <https://github.com/panva/jose> (Context7 `/panva/jose`, verified current docs for `jwtVerify`, `createRemoteJWKSet`, `decodeJwt`).

- `jwtVerify(jwt, getKey, options?)` — verifies JWS signature + JWT Claims Set. Options include `issuer`, `audience` (string | string[]), `algorithms`, `clockTolerance`, `maxTokenAge`. Throws `JWTClaimValidationFailed` on claim mismatch; invalid/expired signatures and claims reject. **No `nonce` option** — nonce must be checked manually on the returned `payload` (tokenhop already does, `src/lib/auth/oidc.js:269`).
- `createRemoteJWKSet(new URL(jwksUri))` — remote JWKS resolver passed as `getKey`; caches keys, refetches on unknown `kid`.
- `decodeProtectedHeader(idToken)` — safe read of `alg`/`kid` before key selection.
- `decodeJwt(token)` — decode claims WITHOUT signature validation; never use for identity decisions.

### @node-saml/node-saml (declared `^5.1.0`)

Docs: <https://github.com/node-saml/node-saml> (Context7 `/node-saml/node-saml`, autodocs from master).

- `new SAML(options)` — required: `callbackUrl`, `issuer`, `idpCert` (string | string[] | callback; array = rollover support). Throws `TypeError` at construction if required options missing.
- `validatePostResponseAsync(container)` → `Promise<{ profile, loggedOut }>`. Rejects on signature, audience, expiry, InResponseTo failures; `SamlStatusError` for IdP-reported status failures.
- `Profile`: `issuer`, `nameID`, `nameIDFormat`, `sessionIndex?`, `nameQualifier?`, `inResponseTo` (runtime), plus every `AttributeValue` copied top-level by attribute `Name`. **Single values are scalars; repeated `AttributeValue`s become arrays** (`attributes` map, runtime). `getAssertionXml()` returns assertion XML exactly as covered by the verified signature; `getAssertion()` returns parsed assertion — prefer these over re-parsing raw response.
- Validation options: `wantAssertionsSigned` (default `true`), `wantAuthnResponseSigned` (default `true`), `validateInResponseTo` (`ValidateInResponseTo.never|ifPresent|always`, default `never`), `requestIdExpirationPeriodMs` (default `28800000`), `acceptedClockSkewMs`, `audience` (defaults to `issuer`), `idpIssuer` — optional trusted IdP issuer string; mismatch/missing Issuer rejects with "Unknown SAML issuer…" / "Missing SAML issuer" (`verifyIssuer`, node-saml `src/saml.ts:1160-1174`).
- `identifierFormat` default: `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`.
- `InMemoryCacheProvider` from `@node-saml/node-saml/lib/in-memory-cache-provider.js` — request-ID cache (tokenhop wraps it globally in `src/lib/auth/saml.js:10-15`).

### authentik

- Property mappings (incl. OAuth2/OIDC scope mappings that emit claims like `groups`): <https://docs.goauthentik.io/add-secure-apps/providers/property-mappings/>
- OAuth2/OIDC provider: <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/> — verified: claims are produced by scope mappings requested via `scope`; since 2025.10 `email_verified` defaults to False unless a custom mapping asserts it.
- SAML provider NameID: <https://docs.goauthentik.io/add-secure-apps/providers/saml/> — verified: "The NameID attribute … is persistent and should never change"; the NameID Property Mapping field selects the mapping; when empty the SP's NameID policy in the request is respected.

## Integration Patterns

1. **OIDC verified identity (already implemented, keep):** verify id_token via `verifyOidcIdToken` (signature + iss + aud + alg allow-list + nonce). Use `payload.sub` as the immutable user key; prefix or namespace it per-issuer if multiple IdPs can be configured over time (e.g. `oidc:{iss}::{sub}`) — `sub` is only unique _within_ an issuer.
2. **Optional UserInfo enrichment:** call `userinfo_endpoint` with the access token only when group claims are absent from the id_token. Verify `userinfo.sub === idTokenPayload.sub` before trusting anything (spec-mandated). `sub` values are case-sensitive — compare with `===`, never `.toLowerCase()`.
3. **Group claim resolution:** support a configurable claim name (`groups` default) plus optional dot-path for nested providers (`e.g. resource_access.account.roles` for Keycloak-style). authentik's scope mapping emits a flat array of group-name strings; normalize to `string[]` and reject `null`/non-array/non-string entries.
4. **Missing vs empty:** `undefined` (claim absent) → "provider made no assertion", skip group sync (don't wipe); `[]` → explicit empty, remove memberships; `null`/bad shape → treat as misconfiguration, fail sign-in or skip-with-log rather than coerce.
5. **SAML verified identity:** keep the existing double InResponseTo check; add `idpIssuer: <configured trusted issuer>` to `createSamlInstance` options so node-saml rejects assertions from any other issuer. Key users on `(profile.issuer, profile.nameID)` — not email — and record `nameIDFormat`. For authentik, configure the SAML provider's NameID property mapping to a stable identifier (e.g. the user's UUID via expression like `return request.user.pk`) rather than relying on default email format.
6. **SAML groups:** read multivalued attribute (e.g. `groups` or `http://schemas.xmlsoap.org/claims/Group`); node-saml yields scalar-or-array — use `Array.isArray(v) ? v : [v]` (same normalization `pickSamlEmail` already applies to email).

## Constraints and Gotchas

- **jose has no `nonce` option** — manual post-verify check required (present at `src/lib/auth/oidc.js:269`); keep.
- **`iss` must be an exact, case-sensitive string match** (OIDC Core string operations). Discovery-derived issuer (`trimTrailingSlashes` at `src/lib/auth/oidc.js:53`) must not be re-normalized differently at verify time.
- **UserInfo `sub` mismatch = discard all UserInfo values** (spec MUST NOT). Do not partially trust a mismatched UserInfo.
- **`access_token` introspection/JWT-decoding is NOT a substitute:** `decodeJwt` is unverified; if access tokens are JWTs they may be for a different audience. Only id_token (and UserInfo behind sub-check) are identity sources.
- **authentik "Include claims in id_token"**: when off (non-default for some setups), claims like `groups` are only available at the UserInfo endpoint — the id_token alone cannot drive JIT groups. Verification caveat in Open Questions.
- **`email_verified` from authentik is `False` by default since 2025.10** — do not auto-trust email for identity or matching to local accounts.
- **node-saml `validateInResponseTo` default is `never`** — tokenhop correctly sets `always` (`src/lib/auth/saml.js:120`); any refactor must preserve it. Also note the documented race: node-saml checks then removes the request ID, so two concurrent posts of one response can both pass — tokenhop's `inFlightRequestIds` set (`src/lib/auth/saml.js:18`) closes this; preserve.
- **node-saml audience defaults to the SP `issuer`** (`ACTIVE.samlIssuerDefault`) — assertion AudienceRestriction must contain it or validation throws "SAML assertion has no AudienceRestriction" / "audience mismatch".
- **`wantAuthnResponseSigned` default `true` means unsigned IdP error responses can be rejected as "Invalid document signature"** before `SamlStatusError` — expected behavior, not a bug to code around.
- **Multivalue asymmetry:** single `AttributeValue` → string; repeated → array. Any attribute consumer must handle both or group sync breaks on one-user-group edge cases.
- **NameID format `emailAddress` (node-saml default, authentik respects SP request policy) is mutable** — emails change; using them as the stable JIT key causes duplicate accounts. Require/record `nameIDFormat`; treat non-persistent formats as a configuration warning.
- **No `wantAssertionsEncrypted`-style option exists** in node-saml v5 SamlOptions; encryption is opt-in via `decryptionPvk` only — out of scope here.

## Code Examples

OIDC UserInfo call with mandated sub check (no new deps — plain fetch + existing verified id_token payload):

```js
// idTokenPayload = result of verifyOidcIdToken(); userinfoEndpoint from discovery
export async function fetchOidcUserInfo(userinfoEndpoint, accessToken, idTokenPayload) {
  const res = await fetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`UserInfo request failed (${res.status})`);
  const userinfo = await res.json();
  // OIDC Core 5.3.2: sub MUST exactly match id_token sub, else discard all values.
  if (userinfo.sub !== idTokenPayload.sub) {
    throw new Error("UserInfo sub does not match id_token sub; values must not be used");
  }
  return userinfo;
}
```

Group claim resolution: missing vs empty vs nested path:

```js
// dot-path lookup, e.g. claimPath "groups" or "resource_access.account.roles"
function claimByPath(payload, path) {
  return path
    .split(".")
    .reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), payload);
}

// Returns: { mode: "absent" | "asserted", groups: string[] }
export function resolveOidcGroups(payload, claimPath = "groups") {
  const raw = claimByPath(payload, claimPath);
  if (raw === undefined) return { mode: "absent", groups: [] }; // provider said nothing — do not sync
  if (!Array.isArray(raw)) return { mode: "invalid", groups: [] }; // null/string/object → misconfig, fail closed
  return { mode: "asserted", groups: raw.filter((g) => typeof g === "string" && g) };
}
```

SAML: trusted issuer + multivalue attribute normalization (extends existing `createSamlInstance` / profile):

```js
// src/lib/auth/saml.js — createSamlInstance additions (trusted-issuer pinning)
return new SAML({
  // ...existing options...
  idpIssuer: settings?.samlIdpIssuer || undefined, // node-saml verifyIssuer rejects mismatches
});

// Multivalue-safe attribute read from validated profile
export function samlAttrList(profile, name) {
  const v = profile?.[name];
  return v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String);
}
// JIT identity key: `${profile.issuer}::${profile.nameID}` + record profile.nameIDFormat
```

## Open Questions

1. **authentik "Include claims in id_token" verification caveat:** the OAuth2 provider docs page (<https://docs.goauthentik.io/add-secure-apps/providers/oauth2/>) fetched successfully but the exact phrase/setting text was not present in the served HTML (likely rendered via UI screenshots/schema rather than prose). The toggle is known in the provider model as `include_claims_in_id_token` (advanced protocol settings). Parent should confirm behavior in a live authentik instance: with it disabled, are `groups` claims present only in UserInfo? Design should not assume id_token carries groups.
2. **Which endpoint is authoritative when both id_token and UserInfo carry `groups`?** Spec permits either; recommend UserInfo-wins-when-present-with-matching-sub, id_token-fallback — needs product decision.
3. **Account-linking key for OIDC:** bare `sub` vs namespaced `iss::sub` (multiple concurrent IdPs?) — depends on product stance on multi-IdP, out of scope here.
4. **SAML trusted issuer configurability:** should `samlIdpIssuer` be a new settings field validated against the IdP metadata, or derived from the entrypoint? (UI/validation owned by parent lanes.)
5. **Group-name collisions:** OIDC group names (strings) vs SAML attribute values vs local role names — mapping table vs literal match not covered by external docs; product decision.
