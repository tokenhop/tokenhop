# YAN-359 Business Research — SSO identity linking and JIT

## Executive Summary

SSO must identify each person, not grant every authenticated IdP user the owner session. YAN-359 adds stable identity linking, pending/user JIT defaults, group admission and instance/workspace role reconciliation on every login, preserving operator-controlled ownership and non-IdP memberships. All new behavior stays behind the multi-user switch; current single-user SSO and separately shipped patch fixes remain intact.

Sources read: full Linear YAN-359 description and relations; main-checkout `docs/users/README.md`, `docs/users/spec.md`, `docs/users/adr/0003-identity-and-bootstrap.md`; business-analyzer template at `/home/yandy/.config/opencode/skills/feature-research/templates/research-agents.md`; current worktree auth, bootstrap, session, tenancy repositories and schema. Approved spec/ADR override handbook proposals. `RELEASING.md` overrides old branch wording.

### Preconditions verified, 2026-10-06

Fetched `origin`; `HEAD` and `origin/master` both resolve to `dcae2aa3de5143f88b0ef494a3dbb68f138f0768`. Linear statuses retrieved directly: every listed prerequisite and blocker is **Done**. Attached GitHub PRs were checked with `gh pr view`: all below report **MERGED**, base **master**. `git merge-base --is-ancestor <merge> origin/master` succeeds for every listed code merge.

| Requirement                | Linear / GitHub evidence                                                                                                               | Merge ancestor                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Rebrand shipped            | YAN-345 Done; attachments [#577](https://github.com/tokenhop/tokenhop/pull/577), [#579](https://github.com/tokenhop/tokenhop/pull/579) | `689b7d1f`, `edf0f50c`; `v1.0.0` contains release commit and is merged into trunk |
| Switch present             | YAN-351 Done; attachment [#666](https://github.com/tokenhop/tokenhop/pull/666)                                                         | `fb0dcd45`                                                                        |
| Bootstrap blocker          | YAN-356 Done; attachment [#735](https://github.com/tokenhop/tokenhop/pull/735)                                                         | `046b67b0`                                                                        |
| RBAC blocker               | YAN-357 Done; attachment [#745](https://github.com/tokenhop/tokenhop/pull/745)                                                         | `2fee25ae`                                                                        |
| Auth-mode / HS256 blockers | YAN-349 and YAN-604 Done; both attach [#392](https://github.com/tokenhop/tokenhop/pull/392)                                            | `d20b4e41`; #393 is maintenance backport, not trunk evidence                      |
| Session foundation         | YAN-355 Done; attachment [#715](https://github.com/tokenhop/tokenhop/pull/715)                                                         | `e2c86ed3`                                                                        |
| Identity schema foundation | YAN-353 Done; attachment [#700](https://github.com/tokenhop/tokenhop/pull/700)                                                         | `5ecf2844`                                                                        |

**Design exception:** YAN-350 is Done, approved 2026-10-02. Attached [GitHub #218](https://github.com/tokenhop/tokenhop/issues/218) is CLOSED; maintainer [approval comment](https://github.com/tokenhop/tokenhop/issues/218#issuecomment-5962432709) explicitly says accepted ADRs, docs-only, **no PR**. Spec and ADRs are untracked local/Linear documents, so claiming a design merge commit would be false. Human approval prerequisite satisfied; literal git ancestry cannot apply to untracked design documents.

Current release model: release-branches, trunk `master`, maintenance `release/1.0`; feature targets next minor v1.1.0 on `master`, not maintenance. No branch-model conversion, patch reimplementation, release actions or default-switch flip belong here.

## User Stories

- **New team member:** authenticate through configured IdP; receive own account/personal workspace, not access to owner resources.
- **Unapproved member:** see waiting-for-approval outcome without receiving usable dashboard/API access.
- **Approved member:** return through same stable identity even after email/display name changes or with no email claim.
- **Instance admin:** constrain eligible groups, assign admin groups and shared-workspace roles, and choose first-login default `pending` or `user`.
- **Workspace manager:** retain manually assigned access when IdP group membership changes.
- **Owner:** link SSO only through explicit bootstrap assertion; never lose ownership through group demotion or first-login race.
- **Single-user operator:** upgrade without altered SSO authorization while multi-user switch remains off on pristine install.

## Business Rules

### Core rules

1. **Stable identity:** OIDC `(provider=oidc, verified issuer, sub)`; SAML `(provider=saml, trusted idpEntityId, NameID)`. Never resolve an account by email alone. Missing stable subject must fail, not mint anonymous owner claims.
2. **Email is metadata:** preserve `emailAtLink` informationally. General opt-in email linking, if supported, requires explicit admin policy and verified email; owner-email bootstrap is narrower, already implemented and one-shot. Scope does not justify silently enabling general email merges.
3. **Admission before provisioning:** configured `allowedGroups` rejects nonmatches visibly, before creating JIT users/memberships or consuming owner-link credentials. Whether owner recovery bypasses admission is unresolved below.
4. **Groups:** default path `groups`, nested paths supported. OIDC uses verified id_token claim first; UserInfo fallback only when claim absent. SAML uses configured attribute from validated assertion. Empty groups are not equivalent to absent groups.
5. **JIT:** first accepted unlinked login creates user + identity and automatic personal workspace. Default instance role `pending`; only alternative configured default is `user`. No default `owner` or arbitrary role.
6. **Pending is role, not status:** schema has `instanceRole=pending` and `status=active|disabled`. Pending user has no application access until approved. Disabled existing account remains disabled despite valid IdP login or admin group.
7. **Per-login sync:** group policy determines admin promotion/demotion and desired shared-workspace memberships every login, not just JIT. Admin group must never assign owner. Owner role stays unchanged.
8. **Membership provenance:** only reconcile `source='idp'`. Preserve `manual` and `invite` rows, their role and source, including collision with desired IdP mapping. Preserve personal workspace's manual owner row.
9. **Session revocation:** effective role/membership change bumps `sessionVersion` before fresh claims; unchanged login does not bump. Existing user-role repository already bumps on real role change; avoid double bump. Membership-only changes need explicit revocation/cache invalidation.
10. **Atomic result:** identity link, JIT account/personal workspace and group reconciliation must not leave orphan users or partly applied authorization. Concurrent same-identity logins converge on one account.
11. **Settings are instance admin authority:** regular user/pending cannot read or change policy through workspace preferences or config-import bypasses. Full admin SSO mapping UI belongs to YAN-373; waiting-for-approval outcome belongs here.
12. **Switch off:** new policy/JIT/claim-fetch behavior must be inert; new routes return 404 and new UI stays hidden. Reuse central switch, not another env gate. Existing auth-mode normalization, lockout protection, visible errors and HS256 verification remain active patch behavior.

### Edge cases and policy constraints

- **Email collisions:** `users.email` is UNIQUE case-insensitively. Different stable subjects sharing email must not merge or take over existing user. Choose documented non-linking outcome: create distinct account with nullable email metadata, or reject visibly; current repo will otherwise raise uniqueness error.
- **Multiple matching groups:** one `(workspaceId,userId)` membership row means overlapping mappings need deterministic role precedence; duplicate mapping must not create duplicate rows. Do not rely on object iteration order.
- **Manual collision:** existing manual/invite viewer plus IdP manager mapping must remain manual/invite viewer unless explicit operator-approved rule says otherwise. No provenance overwrite.
- **Last manager:** repository rejects removal/demotion of final owner/manager. IdP sync must not silently bypass invariant; validate configuration or fail reconciliation visibly and transactionally. Retaining stale elevated access silently contradicts demotion promise.
- **Workspace targets:** reject missing/shared-workspace mismatches and other users' personal workspaces. No automatic creation of arbitrary workspaces from groups required.
- **Changed membership and keys:** removal currently revokes user's keys in that workspace; direct reconciliation must preserve existing security consequences, not only JWT revocation.
- **No-login install:** `createUserUnscoped` refuses another active user while `requireLogin=false`; even pending uses active status. Choose visible recovery to enable login first, not silent bypass.
- **Missing/malformed groups:** validate strings/arrays deliberately; do not coerce objects or scalar text into privilege-bearing group names. UserInfo transport failure is not proof of group removal.
- **UserInfo identity:** fallback cannot replace verified issuer/sub; returned subject must correspond to verified id_token subject. Avoid using untrusted fallback email as owner assertion.
- **Multiple identities/IdPs:** current memberships record `idp`, not which identity/issuer produced grant. Logging into another provider could erase first provider's grants; choose documented reconciliation authority before broad multi-IdP support.
- **Revocation timing:** loss of allowed group is checked on login; claim changes do not automatically invalidate earlier sessions. Immediate IdP lifecycle/webhook revocation is not specified here. Do not claim it exists.

## Workflows

### Primary login

1. Resolve existing auth mode; complete current OIDC state/nonce/PKCE/token validation or SAML request/signature/issuer validation.
2. If rollout switch is off, keep existing legacy SSO path; skip new provisioning/policy work.
3. Resolve stable identity and trustworthy group claims; apply configured admission policy.
4. Resolve existing identity; otherwise use existing explicit owner-link bootstrap; otherwise JIT configured pending/user account. Never use unlinked one-user fallback to grant owner under new JIT path.
5. Refuse disabled accounts. Reconcile non-owner instance role and IdP-only shared memberships, retaining non-IdP rows and invariants.
6. Commit effective changes and session-version update together. Pending outcome displays waiting-for-approval and does not issue full auth cookie.
7. Approved active user gets own `sub`, current `sv`, valid workspace `wid`, and method `amr`; dashboard uses own resources.

### Error recovery

- Outside allow-list: visible non-admission message, no account or privilege changes. Operator can adjust IdP groups/policy; user retries.
- Pending: visible approval state; admin approval uses lifecycle facilities from YAN-360/YAN-373, not new unscoped approval bypass.
- Invalid/missing identity or claim-fetch failure: fail closed with safe visible error; no raw assertions/tokens in logs or audit.
- Mapping conflict/last-manager/invalid target: transaction abort; operator fixes policy or appoints alternate manager. Do not issue fresh elevated session from stale partial state.
- Owner bootstrap token expired/consumed: host mints another; current resolver intentionally spends assertion even if later identity linking fails.

## Domain Model

| Entity          | Business meaning / invariant                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- |
| User            | One person; instance role independent from active/disabled status; owns personal workspace        |
| Identity        | Stable provider/issuer/subject login handle associated with exactly one user; email informational |
| Workspace       | Personal or shared resource boundary; mapped groups target shared workspace only                  |
| Membership      | One row per workspace/user; role plus provenance `manual`, `invite`, `idp`                        |
| SSO policy      | Instance-level admission groups, admin groups, workspace mapping, groups claim and JIT default    |
| Session version | Revokes prior authorization after effective privilege/status changes                              |
| Owner assertion | Explicit one-shot verified email assertion or hashed single-use setup token; not JIT default      |

State transitions: unknown identity becomes linked owner only with explicit assertion, otherwise JIT pending/user; pending becomes approved through admin or explicitly chosen group policy; non-owner user becomes admin on admin-group match, admin loses group-derived elevation on loss; disabled remains disabled; owner changes only by ownership transfer. Exact approval/demotion precedence needs decision below.

## Existing Codebase Integration

- `src/lib/users/bootstrap.js`: `resolveSsoUser`, `stashSetupToken`, `takeSetupToken`, one-shot owner linking already exist. Reuse; no second bootstrap implementation.
- `src/lib/users/session.js`: `sessionClaims` currently rejects linked non-owner and falls back to owner for unlinked SSO with at most one active user. This is precise unsafe legacy fallback YAN-359 replaces **only in enabled JIT path**. Pending rejected by session validator; waiting page must not need full dashboard session.
- `src/app/api/auth/oidc/callback/route.js`, `src/app/api/auth/saml/acs/route.js`: already construct stable identity, call session claims, audit outcomes and display `sso_not_linked`. Issue's statement that SAML retains only email/name is stale after YAN-356: ACS already passes `profile.nameID` and issuer. Verify trusted issuer rather than duplicating extraction.
- `src/lib/auth/oidc.js`, `src/lib/auth/saml.js`, `src/lib/auth/authModes.js`: verified protocols, SAML issuer pin and mode helper; no existing UserInfo reader found under auth.
- `src/lib/db/repos/usersRepo.js`, `identitiesRepo.js`, `membershipsRepo.js`: automatic personal workspace, stable identity uniqueness, immutable owner, session cache invalidation, last-manager and workspace-key revocation behavior.
- `src/lib/db/migrations/004-identity-tenancy.js`: nullable unique user email, stable identity triple, single membership row and provenance constraints define policy collisions.
- `src/lib/auth/routePolicy.js`, `src/dashboardGuard.js`: declarative admin capability and pending/session enforcement already landed. `src/app/login/loginErrors.js` already has `account_pending` text to reuse.
- `src/lib/users/securityState.js`: durable security can remain enforced after switch reads off once key hashing occurred. Preserve inherited security guarantees; distinguish pristine switch-off legacy regression from previously activated marker-latched install. Do not turn off revocation as compatibility shortcut.
- Tests to extend: `tests/unit/owner-bootstrap.test.js`, `principal-sessions.test.js`, `oidc-callback.test.js`, `oidc-verify.test.js`, `saml.test.js`, `saml-issuer-pin.test.js`, `db-tenancy-schema.test.js`, `tenancy-isolation.test.js`.

## Success Criteria

Parent owns execution and validation. Research proposes testable matrix; no tests run here.

| Case                            | Required evidence                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Default pending / explicit user | Own identity/user/personal workspace; pending visible waiting state, no full session; user receives own scoped claims                       |
| Allow-list                      | Matching user admitted; nonmatching/missing groups rejected visibly before JIT; existing identity also reevaluated                          |
| Identity without email          | Repeated issuer/sub or issuer/NameID resolves same user; distinct subjects never merge by same email                                        |
| Admin group                     | Promotion and loss-driven demotion on successive logins; owner unaffected; disabled account not reactivated                                 |
| Membership sync                 | Add/remove/change only IdP rows; manual/invite collisions and personal ownership preserved; no cross-workspace privilege leak               |
| Session version                 | Real role or membership change invalidates earlier tokens and mints current `sv`; unchanged login keeps version                             |
| OIDC groups                     | Nested claim, id_token precedence, absent-only UserInfo fallback, subject mismatch/failure handling; local RS256 and HS256 fixtures         |
| SAML                            | Signed issuer + NameID stable identity and configured group attribute; missing NameID/issuer mismatch rejected                              |
| Owner linking                   | Env email requires verification and one-shot use; valid setup token links once; unmatched first login never owner                           |
| Concurrency/invariants          | Same-identity race leaves one user; failed sync leaves no partial account/grants; last-manager and key revocation honored                   |
| Compatibility                   | Pristine off preserves legacy SSO and ignores new policy/JIT; both switch states pass baseline; marker-latched security remains fail closed |

Full finish line remains parent responsibility: lint, baseline tests off/on, build, brand guard, isolated real-flow checks, code/security review and CI; never call real IdP in CI or touch production.

## Open Questions

1. **Approval versus live group role:** do admin groups approve pending automatically? Does admin-group loss demote to `user` or configured `pending`? Must manually approved user remain user when default pending? Spec says default provisioned role, not reset every login; indiscriminately resetting defeats approval.
2. **Manual instance admin provenance:** user schema has no source for instanceRole. How distinguish IdP-derived admin from manually granted admin without silently removing manual elevation? Explicit policy needed; membership provenance rule alone does not answer this.
3. **Owner allow-list recovery:** does explicit owner bootstrap bypass allowedGroups? Existing setup token exists for recovery, but issue says allowedGroups rejects everyone else. Decide before token consumption or new account writes.
4. **Conflicting workspace roles / last manager:** choose deterministic precedence and safe failure/recovery policy. Do not silently violate either group-removal contract or existing manager invariant.
5. **Duplicate email and multiple IdP sync:** choose non-linking email-collision behavior; establish which identity controls existing `idp` rows. Existing schema cannot record simultaneous grant sources per membership.
6. **Malformed/failed groups source:** define accepted claim shapes and whether failed UserInfo rejects whole login when no group policy configured; absence-only fallback is binding, failure treatment not specified.
7. **Waiting page:** existing `account_pending` login message may satisfy minimal outcome or dedicated page may be required by issue's wording. Neither outcome may grant pending full session or expose identity details through query strings.

These are policy ambiguities, not missing prerequisite merges. Resolve explicitly in parent plan; do not quietly expand scope into invitations, lifecycle UI, multi-IdP grant tracking or immediate external deprovisioning.
