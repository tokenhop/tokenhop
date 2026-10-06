# Practices Research: YAN-359 SSO identity linking, JIT provisioning, group mapping

Source: practices-researcher read-only report (session ses_ef16c81afffeygX5DdbYL8JEsX), saved by parent. Codebase `dcae2aa3`.

## Executive Summary

Identity schema (`users`, `identities`, `workspaces`, `memberships` with `source IN ('manual','invite','idp')`) already exists via migration `004-identity-tenancy.js`; no new migration needed. Group knobs ride the instance settings blob (`DEFAULT_SETTINGS` in `src/lib/db/repos/settingsRepo.js`); `KNOWN_SETTING_KEYS` (`src/app/api/settings/validateSettings.js:216`) derives from it automatically. Integration seams: `sessionClaims` (`src/lib/users/session.js`) and `resolveSsoUser` (`src/lib/users/bootstrap.js`). `updateUserUnscoped` (`usersRepo.js:235`) already bumps `sessionVersion` on role/status change. Footprint: one new module, one repo function, small OIDC/SAML helpers, settings defaults + validation, two callbacks. Zero new dependencies.

## Existing Reusable Code

| Module/Utility   | Location                                                                                                                                                                                                       | Purpose                                                            | How to Reuse for This Feature                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Transactions     | `src/lib/db/driver.js` `getAdapter().transaction`                                                                                                                                                              | Sync tx                                                            | `mapConstraintErrors(() => db.transaction(...))` like `consumeSetupToken` |
| Typed errors     | `src/lib/users/errors.js` `mapConstraintErrors`, `TenancyError`                                                                                                                                                | `IDENTITY_TAKEN`, `EMAIL_TAKEN`, `LAST_MANAGER`, `OWNER_IMMUTABLE` | Race and invariant handling                                               |
| Users repo       | `src/lib/db/repos/usersRepo.js` `createUserUnscoped`, `updateUserUnscoped`, `getUserUnscoped`, `bumpSessionVersion`                                                                                            | User + personal workspace in one tx; auto sv bump                  | JIT create; role re-sync                                                  |
| Identities repo  | `src/lib/db/repos/identitiesRepo.js` `findIdentityUnscoped`, `linkIdentityUnscoped`                                                                                                                            | `(provider, issuer, subject)` UNIQUE                               | Link on JIT                                                               |
| Memberships repo | `src/lib/db/repos/membershipsRepo.js` `assertNotLastManager`, add/update/remove                                                                                                                                | ctx-scoped writes, invariants                                      | Add unscoped `syncIdpMemberships(db, userId, wanted)` here                |
| Workspaces repo  | `src/lib/db/repos/workspacesRepo.js` `listWorkspacesUnscoped`                                                                                                                                                  | Shared workspaces                                                  | Validate map targets                                                      |
| Settings         | `settingsRepo.js` `DEFAULT_SETTINGS`; `src/lib/settings/settingsScope.js` `classifyKey`                                                                                                                        | Instance keys default                                              | New `sso*` keys are instance scope                                        |
| Bootstrap        | `src/lib/users/bootstrap.js` `resolveSsoUser`, setup token helpers                                                                                                                                             | Owner linking                                                      | Keep untouched                                                            |
| Sessions         | `src/lib/users/session.js` `sessionClaims`, `validateSessionToken`                                                                                                                                             | SSO admission                                                      | Single JIT integration point                                              |
| RBAC             | `src/lib/users/principal.js` `can`; `src/lib/auth/routePolicy.js`                                                                                                                                              | Pending denied all; `/api/settings` = `instance.settings.manage`   | No new API routes                                                         |
| Switch           | `src/lib/users/featureSwitch.js` `isMultiUserEnabled`, `requireMultiUser`                                                                                                                                      | Only env reader (grep-tested)                                      | Gate everything                                                           |
| Audit            | `src/lib/users/audit.js` `audit`                                                                                                                                                                               | Allowlisted fields                                                 | Roles/counts/workspaceIds                                                 |
| OIDC             | `src/lib/auth/oidc.js` `verifyOidcIdToken`, `fetchOidcDiscovery`, `exchangeOidcCode`                                                                                                                           | Verified payload, `userinfo_endpoint`, access token                | Add `fetchOidcUserInfo`                                                   |
| SAML             | `src/lib/auth/saml.js` `validateSamlResponse`, `pickSamlEmail`                                                                                                                                                 | Profile attributes                                                 | Add `pickSamlGroups`                                                      |
| Login errors     | `src/app/login/loginErrors.js` `account_pending`                                                                                                                                                               | Pending copy                                                       | Reuse / extend                                                            |
| Tests            | `tests/unit/oidc-verify.test.js` (RS256 JWKS), `oidc-callback.test.js` (HS256 stubIdp), `saml.test.js`, `owner-bootstrap.test.js`, `principal-sessions.test.js` (switch load), `tests/setup/tenancyHarness.js` | Fixtures                                                           | Copy patterns                                                             |

## Modularity Design

### Recommended Module Boundaries

- `src/lib/auth/oidc.js` + `fetchOidcUserInfo(endpoint, accessToken)`.
- `src/lib/auth/saml.js` + `pickSamlGroups(profile, settings)`.
- NEW `src/lib/users/ssoProvisioning.js`: `readGroups` (nested path, safe), pure `resolveAssignments(groups, settings)`, `provisionSsoUser`, `syncSsoUser`.
- `membershipsRepo.js` + `syncIdpMemberships(db, userId, wanted)` (owns `LAST_MANAGER`).
- `session.js` `sessionClaims`: linked non-owner → sync; unlinked → JIT.
- `settingsRepo.js` defaults; `validateSettings.js` validation; callbacks pass groups.

### Shared vs. Feature-Specific Code

| Component                                       | Shared or Feature-Specific | Rationale                           |
| ----------------------------------------------- | -------------------------- | ----------------------------------- |
| `resolveAssignments`                            | Feature                    | One caller, pure, table-testable    |
| `syncIdpMemberships`                            | Shared repo                | Invariant lives in memberships repo |
| UserInfo fetch                                  | Shared auth helper         | Protocol-level                      |
| `principal.js`, `featureSwitch.js`, owner rules | Untouched                  | Grep/purity constraints             |

## KISS Assessment

| Area           | Current Proposal | Simpler Alternative                                                | Trade-off               |
| -------------- | ---------------- | ------------------------------------------------------------------ | ----------------------- |
| Config storage | New tables       | Settings blob keys                                                 | No migration            |
| Mapping        | Rules engine     | Three lists + map + pure function                                  | Less flexible, enough   |
| Nested path    | Library          | 10-line getter                                                     | —                       |
| sv bump        | Custom           | `updateUserUnscoped` auto bump + one bump for membership-only diff | —                       |
| Pending        | Purpose token    | No session + redirect to page                                      | Page shows generic text |
| `lastLoginAt`  | Write            | Skip (not scope)                                                   | —                       |

## Abstraction vs. Repetition

### Extract (Worth Abstracting)

- Groups resolution + JIT/sync orchestration called from `sessionClaims` (both protocols share).

### Repeat (Acceptable Duplication)

- `pickSamlGroups` coercion mirrors `pickSamlEmail` (3 lines).
- Per-key settings validation in existing flat style.

## Interface Design

### Public API Surfaces

- `sessionClaims(method, identity, opts)` stays the only admission API; `opts.groups` (or a lazy loader) carries groups.
- `resolveAssignments(groups, settings) → { admit, instanceRole, memberships[] }` pure.
- `syncIdpMemberships(db, userId, wanted) → { changed }`.
- Settings: `ssoGroupsClaim` (`"groups"`), `ssoAllowedGroups` ([]), `ssoAdminGroups` ([]), `ssoGroupWorkspaceMap` ([]), `ssoDefaultRole` (`"pending"`), `samlAttributeGroups`.

### Extension Points

- YAN-373 admin UI edits the same settings keys; YAN-360 approval flips `pending → user`.

## Testability Patterns

### Recommended Patterns

- Run via `npm test` / `-c tests/vitest.config.js` (HOME isolation).
- Switch on/off via `vi.resetModules()` + env `load(state)`.
- Pure `resolveAssignments` via `test.each`.
- One new file `tests/unit/sso-jit.test.js`; extend existing OIDC/SAML/bootstrap tests minimally.

### Anti-patterns to Avoid

- New `TOKENHOP_MULTI_USER` readers (breaks grep test).
- New API routes without `ROUTE_POLICY` rows.
- Calling real IdPs.

## Build vs. Depend

| Need        | Build Custom     | Use Library   | Recommendation | Rationale                       |
| ----------- | ---------------- | ------------- | -------------- | ------------------------------- |
| UserInfo    | `fetch` + Bearer | openid-client | Build          | jose already verifies; one call |
| Nested path | 10 lines         | lodash.get    | Build          | Pollution history               |
| Mapping     | Object lookups   | RBAC lib      | Build          | `principal.js` enforces         |

## Open Questions

1. Pending session mechanics (no session vs restricted token).
2. Empty `allowedGroups` semantics.
3. Map keyed by workspace id vs name.
4. SAML groups attribute default.
5. JIT while `requireLogin=false` (refuse).
6. Audit group names vs counts.
7. `defaultRole: user` admission requirements.
8. Waiting page route.
