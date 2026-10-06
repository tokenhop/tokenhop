# YAN-360 Invitations and User Lifecycle — Practices Research

## Executive Summary

YAN-360 adds invitations persistence/acceptance plus thin admin lifecycle/membership routes. Sibling research (`research-business.md`, `research-external.md`, `research-recommendations.md`) agrees: invariants already live in repos; missing pieces are one invitation table/repo, gated routes, SQL pagination, ownership re-auth, and exact `kv` cleanup. Smallest safe change: mirror `bootstrap.js` token pattern + `usersRepo.js`/`membershipsRepo.js` sync-transaction pattern, keep routes thin, add no dependencies.

## Existing Codebase Patterns

Verified in worktree (all files present):

- `src/lib/db/repos/usersRepo.js` (431 lines): `COLS` safe projection (excludes `passwordHash`, `instanceRoleSource`); `createUserWithPersonalWorkspaceSync(db,…)` caller-owned sync tx; `createUserUnscoped`, `updateUserUnscoped` (owner guards, `sv` bump, disable→`revokeUserApiKeysSync`, `dropSession`), `deleteUserUnscoped` (owner guard, `assertNotLastManager` per shared workspace, personal-workspace delete, cascade identities/memberships), `transferOwnership` (demote-before-promote, dual `sv` bump, `instance.ownership.transfer` audit). `listUsersUnscoped()` unbounded — needs bounded SQL pagination, not array slice.
- `src/lib/db/repos/membershipsRepo.js` (225 lines): sync helpers `membershipRole`, `assertNotLastManager`, `syncIdpMembershipsSync` (guards-before-writes, invite/manual rows untouched); async `listMemberships`/`addMembership`/`updateMembershipRole`/`removeMembership` with `sharedWorkspace` guard + key revocation on removal + `membership.*` audit. Public mutators check membership, not management capability — handler must check capability first.
- `src/lib/db/repos/identitiesRepo.js` (80 lines): `insertIdentitySync(db,userId,…)` tx-safe, `IDENTITY_TAKEN` mapping; `linkIdentityUnscoped` async wrapper. Stable `(provider,issuer,subject)` identity; never email-link.
- `src/lib/users/audit.js` (98 lines): deny-by-default `ALLOWED` allow-list, never throws, `audit(ctx,action,target,{before,after})`. Note: allow-list has `role` not `instanceRole` — map snapshots to `role`. No token/hash material in snapshots.
- `src/lib/users/bootstrap.js` (299 lines): `mintSetupToken`/`consumeSetupToken` pattern — `randomBytes(32).base64url`, SHA-256 hex stored, length-check + `timingSafeEqual`, consume-in-`db.transaction()`, `Cache-Control: no-store`. Copy shape with 7-day TTL and per-invite row (do not reuse singleton `_meta` storage).
- `tests/setup/tenancyHarness.js` (84 lines): `seedTenancy()` (owner A, user B, shared workspace), `callRoute(handler,path,{as,…})` with real JWT cookie, `denied()` negative helper. Reuse for all invite/lifecycle isolation tests.

## Existing Reusable Code

| Need                      | Reuse, not rebuild                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invite token mint/consume | `bootstrap.js` `sha256`/`randomBytes`/`timingSafeEqual`/tx-consume shape; new `invitations` table + repo                                                                                                                                      |
| Atomic accept             | `createUserWithPersonalWorkspaceSync` + `insertIdentitySync` + membership `INSERT source='invite'` + invite-consume in one caller-owned `db.transaction()`; hash password (`bcryptjs` via existing `userPassword.js`) before entering sync tx |
| Lifecycle writes          | `updateUserUnscoped` (approve/role/disable/enable), `deleteUserUnscoped`, `transferOwnership`; add only SQL pagination + explicit request schemas                                                                                             |
| Membership writes         | `addMembership`/`updateMembershipRole`/`removeMembership` + `assertNotLastManager`; add handler-level capability check + IdP-row rejection + client-`source` rejection                                                                        |
| Route guards              | `requireMultiUser()` first → principal → `ROUTE_POLICY` capability → exact-workspace check → repo → `audit()` → `NextResponse.json`; add one `ROUTE_POLICY` row per route/method (route-policy test fails otherwise)                          |
| Session/key revocation    | Existing `sv` bump + `dropSession` + `revokeUserApiKeysSync`; no new session system                                                                                                                                                           |
| Audit events              | `audit()` with new names `invitations.*`, `instance.users.*`, existing `membership.*`/`instance.ownership.transfer`; avoid duplicate emits from repo helpers                                                                                  |

## Modularity Assessment

Good seams: repos own invariants/transactions; routes own auth/shape; audit never throws; sync `*Sync(db,…)` helpers compose atomically. Keep: one new invitations repo/service, thin routes, transaction-local helpers only where accept needs atomic composition (no nested async repo calls inside tx). Do not add: UI, email delivery, sessions table, generic re-auth framework, second RBAC, placeholder encryption. Ownership transfer re-auth: inline password re-verify in POST body (one request, no cookie surface); SSO-only owners need genuine challenge/callback binding or fail-closed scope decision.

## Dependency Analysis

No new dependencies. Use `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`), existing `bcryptjs`, `jose`, hand-rolled validation (no zod in tree). Migrations: idempotent, next version after `011-sso-role-source.js`; add tenancy table classification for new table. Proxy-bundle caution: keep invitation-accept SSO-linking at `resolveSsoUser`-level call; do not import provider code into proxy-loaded modules.

## KISS Recommendations

1. Thin routes + existing repos + one invitations repo; bounded SQL pagination (`limit`/`offset` or cursor, stable tie-breaker) mirroring `auditRepo.js` pattern.
2. Explicit allow-listed request schemas; reject mass assignment (`instanceRoleSource`, `source`, expiry/consumption state, instance admin via invite).
3. Accept: re-read invite/account/workspace inside tx; `now >= expiresAt` rejects; conditional consume; failed insert leaves invite unconsumed; concurrent accept has one winner.
4. Email binding: normalize (trim+lowercase) at create and accept; mismatch = generic invalid-token (no oracle).
5. Deletion: existing cascade + explicit `ws:<id>/` kv cleanup + shared `createdByUserId=NULL` + service-key survival (`userId IS NULL`); preserve audit rows; no `workspaceKeys`/DEK code until YAN-365 defines it.
6. Provenance: manual writes clear `instanceRoleSource`; manual membership override of `source='idp'` needs explicit conversion or IdP sync will overwrite; never silently overwrite stronger role/IdP row on accept — explicit conflict.
7. Off-switch: `requireMultiUser()` 404 on all new routes, both legacy and security-latched DBs; test real HTTP ordering.

## Testing Strategy

Run only via isolated config (`npx vitest run -c tests/vitest.config.js …` or `npm test`); orchestrator owns execution — no tests run in this lane. Critical new/updated tests using `tenancyHarness.js` (`seedTenancy`, `callRoute`, `denied`):

- Invite: success (password + SSO-link), 7-day boundary, reuse, revoke, concurrent accept/revoke, forged workspace/role/source, email mismatch, personal-workspace target, insertion-rollback leaves invite unconsumed.
- Isolation: manager-A cannot invite/manage members in B; member/viewer/pending denied; `ROUTE_POLICY` coverage; switch-off 404 anonymous+authenticated.
- Lifecycle: owner demote/disable/delete fail; disable revokes sessions+keys (enable does not resurrect); approve/role `sv`+provenance; transfer dual-`sv`, exactly-one-owner, re-auth replay/wrong-target/expiry fail.
- Deletion: personal cascade + kv cleanup vs shared/service-key/audit survival; sole-manager deletion rollback.
- No-secrets: assert no password/key/invite hash or raw token in list/detail/log/audit; only create response reveals token once.

## Open Questions

1. Global admin invite authority: instance-level override via `instance.users.manage` vs strict membership-scoped `workspace.members.manage`?
2. Invite role ceiling: workspace roles only, or may invite pre-assign `owner`/instance `admin`?
3. Accepted invite's instance role (`pending` vs `user`) and whether valid invite auto-approves pending SSO users.
4. Existing-account accept proof and conflict semantics (no silent overwrite; idempotent response vs single-use burn).
5. Admin target hierarchy (peer/self changes, self-disable) and disabled-last-manager rule.
6. SSO-only owner re-auth mechanism (challenge/callback binding vs fail-closed).
7. Orphan-invite policy on inviter demotion/removal/workspace deletion; `workspaceKeys`/DEK contract with YAN-365 (migration version allocation on rebase).
