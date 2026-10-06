# Feature Spec: YAN-359 SSO identity linking, JIT provisioning and group mapping

## Executive Summary

With multi-user on, OIDC and SAML logins resolve each person by a stable IdP identity, `(issuer, sub)` or `(issuer, NameID)`, instead of granting the owner session. Unknown identities are provisioned just in time as `pending` (default) or `user`. Admin-only instance settings decide which groups may sign in, which become admins, and which shared workspaces they join. Role and IdP-sourced memberships are re-evaluated on every login in one transaction, with `sv` bumped on change. Main risks: owner takeover, partial writes, UserInfo subject mismatch, and deleting manual grants. Everything is inert while the switch is off.

## External Dependencies

### APIs and Services

#### OpenID Connect (configured IdP, e.g. authentik)

- **Documentation**: [OIDC Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) (§2 ID token, §5.3 UserInfo, §5.3.2 `sub` must match)
- **Authentication**: authorization code + PKCE (existing); UserInfo with `Authorization: Bearer <access_token>`
- **Key Endpoints**:
  - discovery `userinfo_endpoint`: groups fallback when the configured claim is absent from the verified id_token
- **Rate Limits**: one extra request per login, and only when the claim is absent
- **Pricing**: none

#### SAML 2.0 (configured IdP)

- **Documentation**: [SAML Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf), [node-saml](https://github.com/node-saml/node-saml)
- **Authentication**: signed assertion, `InResponseTo` binding (existing)
- **Key Endpoints**: existing ACS; identity is `profile.issuer` + `profile.nameID`; groups come from the configured attribute
- **Rate Limits**: existing ACS limiter
- **Pricing**: none

### Libraries and SDKs

| Library                                | Version | Purpose                                                    | Installation      |
| -------------------------------------- | ------- | ---------------------------------------------------------- | ----------------- |
| jose                                   | ^6.1.3  | id_token verification (existing; nonce check stays manual) | already installed |
| @node-saml/node-saml                   | ^5.1.0  | assertion validation (existing)                            | already installed |
| native `fetch` + `AbortSignal.timeout` | Node    | UserInfo call                                              | stdlib            |

No new dependencies.

### External Documentation

- [authentik OAuth2 provider](https://docs.goauthentik.io/docs/add-secure-apps/providers/oauth2/): groups scope and "include claims in id_token". The exact behaviour is unverified, so the UserInfo fallback covers it.
- [Open WebUI SSO notes](https://docs.openwebui.com/features/auth/sso/): email-merge takeover and group sync deleting manual groups, the pitfalls this spec avoids.

## Business Requirements

### User Stories

**Primary User: team member**

- As a team member, I want to sign in with my company IdP so that I get my own account, not the owner's.
- As an unapproved member, I want a clear "waiting for approval" message so that I know what happens next.
- As a returning member, I want to be recognised even after my email changes so that my access persists.

**Secondary User: instance admin / owner**

- As an admin, I want to restrict SSO to allowed groups, grant admin via groups, and map groups to shared workspaces so that access follows the IdP.
- As the owner, I want no SSO login ever to take over my account so that the instance stays mine.
- As a workspace manager, I want manually granted memberships kept so that IdP sync never removes people I added.

### Business Rules

1. **Stable identity**: OIDC `('oidc', verified iss, sub)`; SAML `('saml', validated issuer, NameID)`. A missing issuer or subject fails the login. Email is never a linking key.
   - Validation: lookup through `findIdentityUnscoped`; UNIQUE `(provider, issuer, subject)`.
   - Exception: the owner link via `TOKENHOP_OWNER_EMAIL` (verified, one-shot) or a setup token stays exactly as in YAN-356.
2. **Admission first**: a non-empty `ssoAllowedGroups` rejects non-members of every SSO login, the owner included, before any write or setup-proof consumption. An empty list means no restriction.
3. **JIT**: an unlinked, admitted identity creates user + personal workspace + identity atomically, with role `ssoDefaultRole ∈ {pending, user}` (default `pending`).
4. **Pending**: gets no session or cookie of any kind. The browser goes to a public generic waiting page.
5. **Admin groups**: a match promotes `pending`/`user` → `admin` immediately, recorded as IdP-derived. Losing the match demotes only IdP-derived admins to `user`. Manually appointed admins and the owner are never changed by sync.
6. **Approved users stay approved**: sync never resets `user` → `pending`.
7. **Memberships**: the desired set is built from `ssoGroupWorkspaceMap` (stable shared-workspace IDs; roles `manager|member|viewer`; never `owner`; never personal workspaces). If several groups map to one workspace, the highest role wins: `manager > member > viewer`. Sync only adds, updates or removes `source='idp'` rows. An existing manual or invite row always wins and is never changed.
8. **Session version**: exactly one `sv` bump per login if the role or any IdP membership changed; none if nothing changed. Removing a membership also revokes the user's API keys in that workspace (existing behaviour).
9. **Atomic sync**: the whole provision + sync runs in one transaction. A last-manager violation or any failure rolls everything back and **denies the login** with a visible error.
10. **Disabled accounts** stay disabled regardless of groups.
11. **Duplicate email**: a JIT user whose email already exists is created with `email=NULL`; the claimed email is kept in `identities.emailAtLink`. No merge.
12. **Switch**: admission, JIT and sync run only when security is enforced (`isUserSecurityEnforced()`, latch-aware). The enabled path never falls back to the owner session. A pristine switch-off install behaves exactly as today. New settings and UI are hidden while `isMultiUserEnabled()` is false.

### Edge Cases

| Scenario                                                   | Expected Behavior                                                          | Notes                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| Claim present but empty `[]`                               | Treated as "no groups"; no UserInfo call                                   | key presence, not truthiness      |
| Claim absent, UserInfo fails or `sub` mismatches           | Login denied before any write                                              | fail closed                       |
| Groups contain objects, `__proto__`, huge strings          | Ignored; only strings ≤256 chars, max 100                                  | read-only path walk, depth ≤5     |
| Concurrent first login, same identity                      | One user; the loser re-reads the winner                                    | `IDENTITY_TAKEN`                  |
| `requireLogin=false` and a JIT would add a 2nd active user | Login denied, operator told to enable login                                | existing `SINGLE_USER_MODE` guard |
| SAML transient NameID                                      | Denied, server log explains persistent NameID is required                  | unstable identity                 |
| Mapped workspace deleted                                   | Settings PATCH validates IDs; at login a missing ID is skipped and audited | stale config never grants access  |
| Protocol switched OIDC ↔ SAML                              | The active protocol owns all `source='idp'` rows                           | single sync authority, documented |

### Success Criteria

- [ ] An authentik-style user in an allowed group gets their own account with mapped roles and workspaces.
- [ ] A user outside the allowed groups is rejected with a visible message and nothing is created.
- [ ] A new SSO login never becomes or takes over the owner; with the switch on, no unlinked SSO login gets owner claims.
- [ ] Manual memberships and manual admins survive group changes.
- [ ] Old sessions are invalid after a role or membership change.
- [ ] Switch off: OIDC/SAML behave exactly as before; lint, tests with the switch off and on, build and brand guard all pass.

## Technical Specifications

### Architecture Overview

```text
OIDC callback / SAML ACS (existing verification)
   │ identity {provider, issuer, subject, email}
   │ groups: id_token claim → UserInfo fallback (OIDC) | configured attribute (SAML)
   ▼
src/lib/users/ssoProvisioning.js
   resolveAssignments(groups, settings)          pure: admit, adminMatch, memberships
   ssoAdmit(identity, groups, opts)
     1 security not enforced → legacy path (unchanged)
     2 admission (allowedGroups)                  deny → nothing written
     3 linked identity → user | owner-link (resolveSsoUser) | JIT provision
     4 one db.transaction: provision? + role sync + syncIdpMemberships + sv bump
   ▼
sessionClaims → {sub, sv, wid, amr} | pending → /login/pending | denied → /login?error=…
```

### Data Models

#### users (migration `011-sso-role-source.js`)

| Field              | Type | Constraints            | Description                                            |
| ------------------ | ---- | ---------------------- | ------------------------------------------------------ |
| instanceRoleSource | TEXT | NULL, CHECK IN ('idp') | `'idp'` when sync granted admin; NULL = manual/default |

Rules: sync sets `'idp'` when it promotes. Any manual role change (`updateUserUnscoped` with `instanceRole`) clears it to NULL. Demotion on group loss only applies when the value is `'idp'`.

#### Settings blob (instance scope, no DDL)

| Key                  | Type                           | Default     | Validation                                                                                      |
| -------------------- | ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| ssoGroupsClaim       | string                         | `"groups"`  | ≤256 chars, dot segments `[A-Za-z0-9_:/-]+`, depth ≤5, no `__proto__`/`constructor`/`prototype` |
| samlAttributeGroups  | string                         | `"groups"`  | attribute key; exact match first                                                                |
| ssoAllowedGroups     | string[]                       | `[]`        | ≤100 entries, each ≤256 chars, deduplicated                                                     |
| ssoAdminGroups       | string[]                       | `[]`        | same                                                                                            |
| ssoGroupWorkspaceMap | `{group, workspaceId, role}[]` | `[]`        | ≤100; existing shared workspace; role ∈ manager/member/viewer                                   |
| ssoDefaultRole       | enum                           | `"pending"` | `pending` or `user`                                                                             |

**Relationships:** `memberships.source='idp'` rows are owned by sync; `identities` unchanged.

### API Design

#### `PATCH /api/settings`

**Purpose**: write the new SSO keys (existing route, `instance.settings.manage`).
**Authentication**: admin session.

**Request:**

```json
{
  "ssoAllowedGroups": ["tokenhop-users"],
  "ssoAdminGroups": ["tokenhop-admins"],
  "ssoGroupWorkspaceMap": [{ "group": "team-a", "workspaceId": "ws_123", "role": "member" }],
  "ssoDefaultRole": "pending"
}
```

**Response (200):** the updated settings, secrets omitted (existing shape).

**Errors:**

| Status  | Condition                                                | Response                 |
| ------- | -------------------------------------------------------- | ------------------------ |
| 400     | invalid shape, owner role, unknown or personal workspace | `{ "error": "…" }`       |
| 401/403 | non-admin                                                | existing guard           |
| 404     | keys sent while multi-user is off                        | rejected as unknown keys |

#### SSO callback outcomes

| Case                                    | Redirect                              | Cookie            |
| --------------------------------------- | ------------------------------------- | ----------------- |
| active user/admin                       | `/dashboard`                          | full `auth_token` |
| pending                                 | `/login/pending`                      | none              |
| outside allowed groups                  | `/login?error=sso_group_denied`       | none              |
| groups unavailable / UserInfo mismatch  | `/login?error=sso_groups_unavailable` | none              |
| sync failed (last manager, invalid map) | `/login?error=sso_sync_failed`        | none              |
| disabled                                | `/login?error=account_disabled`       | none              |

### System Integration

#### Files to Create

- `src/lib/users/ssoProvisioning.js`: groups parsing, `resolveAssignments`, admission, JIT + sync transaction.
- `src/lib/db/migrations/011-sso-role-source.js`: `users.instanceRoleSource`.
- `src/app/login/pending/page.js`: generic waiting page, 404 when the switch is off.
- `tests/unit/sso-jit.test.js`: critical admission, JIT and sync tests.

#### Files to Modify

- `src/lib/auth/oidc.js`: `fetchOidcUserInfo` (sub/iss match, timeout).
- `src/lib/auth/saml.js`: `pickSamlGroups`.
- `src/app/api/auth/oidc/callback/route.js`, `src/app/api/auth/saml/acs/route.js`: groups, admission outcomes, limiter (account bucket), audit.
- `src/app/api/auth/oidc/start/route.js`, `src/app/api/auth/saml/start/route.js`: `Referrer-Policy: no-referrer`.
- `src/lib/users/session.js`: enabled path admits linked non-owner users, no owner fallback.
- `src/lib/db/repos/membershipsRepo.js`: `syncIdpMembershipsSync(db, userId, wanted)`.
- `src/lib/db/repos/usersRepo.js`: clear `instanceRoleSource` on manual role change; internal sync helpers.
- `src/lib/db/schema.js`, `src/lib/db/migrations/index.js`: new column and migration.
- `src/lib/db/repos/settingsRepo.js`, `src/app/api/settings/validateSettings.js`, `src/app/api/settings/route.js`: defaults, validation, hidden while off.
- `src/app/login/loginErrors.js`: new error codes.
- `src/lib/users/audit.js`: allow `groupCount`, `workspaceId`, `roleSource` fields.

#### Configuration

- `TOKENHOP_MULTI_USER`: existing switch, read only by `featureSwitch.js`.

## UX Considerations

### User Workflows

#### Primary Workflow: first SSO login

1. **Sign in**
   - User: clicks Sign in with SSO.
   - System: verifies, admits, provisions.
2. **Pending**
   - User: lands on `/login/pending`.
   - System: shows "Waiting for approval. An administrator needs to approve your account. Sign in again once you've been approved." plus a Back to sign-in button.
3. **Success State**
   - Approved or `user`-default people land on the dashboard with their own workspace.

#### Error Recovery Workflow

1. **Error Occurs**: outside allowed groups, groups unavailable, or sync failed.
2. **User Sees**: a login-page callout with a plain message that never names groups or reveals whether an account exists.
3. **Recovery**: the admin fixes groups or mapping; the user signs in again.

### UI Patterns

| Component     | Pattern                               | Notes                                                |
| ------------- | ------------------------------------- | ---------------------------------------------------- |
| Pending page  | Login shell + `EmptyState` + `Button` | neutral tone, not an error; generic text; no session |
| Login errors  | existing `loginErrors.js` callout     | new keys only                                        |
| Admin mapping | API only in YAN-359                   | the editor is YAN-373                                |

### Accessibility Requirements

- WCAG 2.2 AA: the pending page has an `h1`, a `role="status"` message and a keyboard-reachable button.
- Error callouts use the existing announced alert pattern.

### Performance UX

- **Loading States**: none new; the redirects are server-side.
- **Optimistic Updates**: not applicable.
- **Error Feedback**: immediate, on redirect.

## Recommendations

### Implementation Approach

**Recommended Strategy**: one SSO admission module that both callbacks call after the existing verification, backed by synchronous transactional repo seams. No new routes besides the static pending page.

**Phasing:**

1. **Phase 1 - Foundation**: migration, settings defaults and validation, groups parsers, UserInfo fetch.
2. **Phase 2 - Core Features**: admission + JIT + sync transaction; `sessionClaims` change; callback wiring.
3. **Phase 3 - Polish**: pending page, login errors, audit fields, limiter, `Referrer-Policy`.

### Technology Decisions

| Decision         | Recommendation                                                                   | Rationale                                          |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Admin provenance | `users.instanceRoleSource`                                                       | approved: preserve manual admins                   |
| Policy storage   | settings blob                                                                    | no new tables; auto-known keys                     |
| Pending          | no session + public page                                                         | approved; smallest surface                         |
| Map keying       | workspace IDs                                                                    | renames can't redirect grants                      |
| Gate             | `isUserSecurityEnforced()` for admission; `isMultiUserEnabled()` for UI/settings | a latched install never reopens the owner fallback |

### Quick Wins

- Reuse `account_pending`-style copy and the login callout.
- Reuse the `oidc-callback` and `oidc-verify` fixtures (HS256, RS256 JWKS) and the SAML fixtures.

### Future Enhancements

- Follow-up issues: SAML response signing, forwarded-host gating, owner-email claim atomicity, SAML cert validation at PATCH, form-encoded token responses.
- Per-issuer membership provenance once multi-IdP exists.

## Risk Assessment

### Technical Risks

| Risk                           | Likelihood | Impact | Mitigation                                                 |
| ------------------------------ | ---------- | ------ | ---------------------------------------------------------- |
| Enabled owner fallback remains | Med        | High   | removed on the enabled path; negative test                 |
| Partial writes                 | Med        | High   | async work first, then one sync transaction; rollback test |
| Manual grant deletion          | Med        | High   | `source='idp'` only; collision test                        |
| Switch-off regression          | Low        | High   | off and latched-off tests; CI both states                  |

### Integration Challenges

- `oidc-callback.test.js` mocks `sessionClaims`; real admission needs DB-level tests in `sso-jit.test.js`.
- `validateSessionToken` keeps rejecting pending users; the pending page must not need a session.

### Security Considerations

#### Critical — Hard Stops

| Finding                                              | Risk                 | Required Mitigation                  |
| ---------------------------------------------------- | -------------------- | ------------------------------------ |
| Enabled unlinked-SSO → owner fallback (`session.js`) | owner takeover       | remove on the enabled path           |
| UserInfo subject binding                             | privilege escalation | exact `sub`/`iss` match, fail closed |

#### Warnings — Must Address

| Finding                            | Risk               | Mitigation                     | Alternatives           |
| ---------------------------------- | ------------------ | ------------------------------ | ---------------------- |
| Nested claim path pollution        | crash or pollution | read-only bounded walk         | none                   |
| JIT race                           | duplicate users    | one transaction + re-read      | none                   |
| sv not bumped on membership change | stale sessions     | one bump per changed login     | none (binding)         |
| OIDC callback lacks limiter        | abuse              | IP + account bucket            | none                   |
| Setup token in URL referer         | leak               | `Referrer-Policy: no-referrer` | POST start (follow-up) |

#### Advisories — Best Practices

- Issuer pinning for owner email: covered by single-issuer config (deferral justification: no multi-IdP yet).
- SSRF blocklist for admin IdP URLs: timeout now (deferral justification: admin-only setting).

## Task Breakdown Preview

### Phase 1: Foundations

**Focus**: data, settings, protocol readers.
**Tasks**:

- Migration 011 + schema + clear-on-manual-change.
- Settings defaults, validation, hidden while off.
- `fetchOidcUserInfo`, `pickSamlGroups`, safe groups reader.
  **Parallelization**: DB/settings lane ∥ protocol lane.

### Phase 2: Admission

**Focus**: JIT + sync + session.
**Dependencies**: Phase 1.
**Tasks**:

- `ssoProvisioning.js` + `syncIdpMembershipsSync`.
- `sessionClaims` + callback wiring + limiter + audit.

### Phase 3: Presentation and verification

**Focus**: pending page, errors, tests.
**Tasks**:

- Pending page and login errors (@designer).
- Critical tests; lint, tests with the switch off and on, build, brand guard.

## Decisions Needed

All decisions approved by the maintainer on 2026-10-06:

1. **Manual admins**
   - Options: preserve via provenance; IdP controls all admins
   - Impact: migration 011
   - Recommendation: preserve (approved)
2. **Pending user in admin groups**
   - Options: promote immediately; wait for approval
   - Impact: sync rules
   - Recommendation: promote immediately (approved)
3. **Owner vs allow-list**: applies to every SSO login (approved).
4. **Last-manager / sync failure**: roll back and deny login (approved).
5. **Defaults**: empty allow-list = no restriction, generic no-cookie waiting page, workspace IDs, roles manager/member/viewer, manual wins, `manager > member > viewer`, no email linking, duplicate email → NULL, editor in YAN-373 (approved).

## Research References

For detailed findings, see:

- [research-external.md](./research-external.md): OIDC/SAML/authentik details
- [research-business.md](./research-business.md): business rules and preconditions
- [research-technical.md](./research-technical.md): technical design (D3 rejected: `sv` bump on membership change is mandatory)
- [research-ux.md](./research-ux.md): pending page and errors
- [research-security.md](./research-security.md): severity findings; see the Reconciliation section
- [research-practices.md](./research-practices.md): reuse and KISS
- [research-recommendations.md](./research-recommendations.md): lanes and risks
