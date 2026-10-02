# YAN-353 — identity and tenancy schema

Target: v1.1.0 (trunk `master`, no backport). Trunk landing: ships anytime,
inert — nothing on the request path reads the new tables or repos; no switch
needed (handbook §5). Sources: `docs/users/README.md` §4, spec rows 1–3,
ADR-0001, ADR-0002, ADR-0003.

## Design

1. **Migration `004-identity-tenancy`** (next free version; the issue's "002"
   predates YAN-352's renumbering). Frozen literal DDL, `IF NOT EXISTS`
   everywhere, so reruns and restored DBs are no-ops. `TABLES` in
   `schema.js` mirrors it (drift test already enforces chain == `TABLES`).
   - `users(id PK, email UNIQUE COLLATE NOCASE NULL, username UNIQUE COLLATE
NOCASE NULL, displayName, instanceRole CHECK owner|admin|user|pending,
status CHECK active|disabled DEFAULT active, passwordHash, sessionVersion
INTEGER NOT NULL DEFAULT 1, createdAt, updatedAt, lastLoginAt)`.
     Partial unique index `idx_users_owner ON users(instanceRole) WHERE
instanceRole = 'owner'`: at most one owner, enforced by SQLite.
   - `identities(id PK, userId → users ON DELETE CASCADE, provider CHECK
password|oidc|saml|header, issuer NOT NULL DEFAULT '', subject NOT NULL,
emailAtLink, createdAt, lastLoginAt, UNIQUE(provider, issuer, subject))`.
     `issuer` is NOT NULL because SQLite treats NULLs as distinct in UNIQUE.
   - `workspaces(id PK, name NOT NULL, kind CHECK personal|shared, createdBy →
users ON DELETE SET NULL, createdAt, updatedAt)`. Partial unique index
     `idx_workspaces_personal ON workspaces(createdBy) WHERE kind =
'personal'`: one personal workspace per user.
   - `memberships(workspaceId → workspaces ON DELETE CASCADE, userId → users
ON DELETE CASCADE, role CHECK owner|manager|member|viewer, source CHECK
manual|invite|idp DEFAULT manual, createdAt, PK(workspaceId, userId))`,
     index on `userId`.
2. **Typed errors** `src/lib/users/errors.js`: `TenancyError(code, message)`;
   codes `INVALID`, `NOT_FOUND`, `EMAIL_TAKEN`, `USERNAME_TAKEN`,
   `IDENTITY_TAKEN`, `MEMBERSHIP_EXISTS`, `OWNER_EXISTS`, `OWNER_IMMUTABLE`,
   `LAST_MANAGER`, `PERSONAL_WORKSPACE`. SQLite `UNIQUE constraint failed:
   <table>.<col>` messages are mapped to these (same text on all 4 drivers).
3. **Principal** `src/lib/users/principal.js`: JSDoc `Principal` typedef
   `{ userId, instanceRole, workspaceIds, activeWorkspaceId, apiKeyId?, via }`
   and a pure `can(principal, capability, resource)` stub (owner-only allow;
   YAN-357 replaces it with the ADR-0002 matrix).
4. **Repos** (`src/lib/db/repos/`), scoped functions take `ctx` (a
   Principal) first; `*Unscoped` functions are admin/bootstrap-only and the
   caller asserts that. `passwordHash` is never in returned user objects.
   - `usersRepo`: `getUser(ctx, id)` (self only), `getUserUnscoped`,
     `listUsersUnscoped`, `getOwnerUnscoped`, `getUserPasswordHashUnscoped`,
     `createUserUnscoped` (user + personal workspace + owner membership in one
     transaction), `updateUserUnscoped` (bumps `sessionVersion` on role,
     status or password change), `deleteUserUnscoped`, `transferOwnership(ctx,
toUserId)`.
   - `identitiesRepo`: `listIdentities(ctx)`, `findIdentityUnscoped`,
     `linkIdentityUnscoped`, `unlinkIdentity(ctx, id)`.
   - `workspacesRepo`: `listWorkspaces(ctx)`, `getWorkspace(ctx, id)`,
     `listWorkspacesUnscoped`, `createSharedWorkspace(ctx, {name})`,
     `renameWorkspace(ctx, id, name)`, `deleteWorkspace(ctx, id)`.
   - `membershipsRepo`: `listMemberships(ctx, wsId)`, `addMembership`,
     `updateMembershipRole`, `removeMembership` (all `ctx`-scoped to
     workspaces the principal belongs to).
   - Invariants: exactly one owner (index + repo); owner can't be deleted,
     disabled or demoted except via `transferOwnership` (old owner → admin,
     both `sessionVersion`s bump); a workspace always keeps ≥ 1 owner/manager
     (`LAST_MANAGER` on remove/demote/user delete); personal workspaces can't
     be deleted or gain members; deleting a user removes their personal
     workspace.
     Role/capability checks are not repo invariants — YAN-357 owns them.
5. **Barrel**: export from `@/lib/db/index.js`. Not added to `localDb`.
   Not added to `exportDb`/`importDb` (YAN-375); tables stay empty while the
   switch is off.

## Tasks

| #   | File                                                                | Change                         |
| --- | ------------------------------------------------------------------- | ------------------------------ |
| 1   | `src/lib/db/migrations/004-identity-tenancy.js`                     | frozen DDL                     |
| 2   | `src/lib/db/migrations/index.js`                                    | register 004                   |
| 3   | `src/lib/db/schema.js`                                              | 4 tables in `TABLES`           |
| 4   | `src/lib/users/errors.js`, `principal.js`                           | typed errors, Principal, `can` |
| 5   | `src/lib/db/repos/{users,identities,workspaces,memberships}Repo.js` | repos                          |
| 6   | `src/lib/db/index.js`                                               | barrel exports                 |
| 7   | `tests/unit/db-tenancy-schema.test.js`                              | migration + repo + invariants  |
| 8   | `docs/ARCHITECTURE.md`                                              | one-line update                |

## Validation

`npm run lint`, `npm test` (switch off + on), `npm run build`,
`npm run lint:brand`. Existing suite = single-user regression.
