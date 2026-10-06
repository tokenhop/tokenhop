# YAN-360 Invitations and User Lifecycle — Recommendations

## Executive Summary

YAN-360 can proceed on `master`, targeting v1.1.0, without backport. At research time, worktree HEAD and local `origin/master` are `926151d1`; YAN-358 is closed and merged through #767 (`36c0781f`). Rebrand v1.0.0 is an ancestor of `origin/master`; YAN-351 merged through #666 (`fb0dcd45`); YAN-350 is approved in main-checkout `docs/users/spec.md`, and its GitHub mirror #218 is closed. These observations establish code availability; Linear remains source of truth for Done status.

Most lifecycle invariants already exist in repositories. Smallest complete change adds invitations persistence/acceptance, thin protected lifecycle and membership routes, fresh re-authentication for ownership transfer, and narrowly repairs deletion/provenance gaps. Do not build UI, email delivery, a sessions table, or a second authorization system. Existing YAN-367 audit and YAN-359 SSO are merged; integrate them rather than treating them as future no-op dependencies. YAN-365 encryption (#233) remains open: delete current personal-workspace resources now; coordinate future DEK destruction without claiming cryptographic erasure today.

Sources: GitHub #228 and #226 read via `gh`; worktree `CLAUDE.md` and `RELEASING.md`; main-checkout `/home/yandy/Projects/github.com/tokenhop/tokenhop/docs/users/README.md` and `spec.md`. Handbook inventory predates current implementation; code wins for file paths and shipped behavior. Validation execution belongs to orchestrator; this lane ran no lint, tests, build, or brand check.

## Implementation Recommendations

### Reuse existing boundaries

- `src/lib/users/featureSwitch.js`: `requireMultiUser()` first in every new route. Default remains off; new API answers 404 even after hashed-security activation. Do not substitute `isUserSecurityEnforced()`: durable security latch intentionally stays true when rollout switch is later disabled.
- `src/lib/auth/routePolicy.js` and `src/lib/users/principal.js`: register exact routes/methods with existing `instance.users.manage`, `instance.ownership.transfer`, and `workspace.members.manage`. Recheck target workspace inside handler and write transaction. `workspaceScope()` intentionally returns null with one active user; unsuitable for mandatory gated administration authorization.
- `src/lib/db/repos/usersRepo.js`: reuse safe column projection, user-plus-personal-workspace creation, role/status `sv` bumps, disabled-user key revocation, owner protection, last-manager guard, and transactional ownership transfer. Add bounded SQL pagination, not pagination over `listUsersUnscoped()`'s full array. Preserve explicit field allow-lists; reject mass assignment.
- `src/lib/db/repos/membershipsRepo.js`: reuse last-manager and personal-workspace rules and user-key revocation on removal. Current scoped functions require membership, not management capability; public callers need role authorization. Make transaction-local helpers only where invite acceptance needs atomic composition, rather than nested asynchronous repository calls.
- `src/lib/auth/userPassword.js`, `sameOrigin.js`, and `src/app/api/users/[id]/password/route.js`: reuse password policy/hashing, same-origin JSON checks, full-session checks, no-store responses, bounded payloads, safe errors, and optimistic session-version checks.
- `src/lib/users/audit.js`: existing best-effort redacted audit interface. Emit safe events after commit; do not replace it with no-op plumbing. Existing membership and transfer helpers already emit events; avoid duplicates. Snapshot allow-list accepts `role`, not `instanceRole`, so map lifecycle snapshots deliberately.
- `tests/setup/tenancyHarness.js`, `tests/unit/tenancy-isolation.test.js`, `principal-sessions.test.js`, `sso-jit.test.js`, and `tenancy-guard.test.js`: reuse two-user fixtures, route callers, session/revocation assertions, IdP provenance assertions, and table classification guard.

### Invitations

Add one invitation table/repository, schema entry, idempotent next migration, and tenancy classification. Current chain ends at `011-sso-role-source.js`; allocate next version against rebased head, since YAN-365 may land concurrently. Store unique token hash, workspace, assigned workspace role, optional email binding, issuer, timestamps, seven-day expiry, and consumed/revoked state. Use Node `crypto.randomBytes(32)` and SHA-256 for high-entropy invite tokens; do not reuse low-entropy legacy gateway-key hashing assumptions. Return raw token once at creation only; never return token or hash in list/detail, logs, or audit.

Acceptance must atomically validate token state/expiry and current workspace eligibility, create or resolve account/verified identity, insert membership with `source='invite'`, and mark token consumed. Hash passwords before entering synchronous DB transaction; re-read every authorization-dependent value inside it. Reject expiry at `now >= expiresAt`; conditional consumption plus rollback prevents concurrent reuse. Failed account or membership insertion must leave invite unconsumed. Recheck issuer authority at acceptance if policy requires immediate invalidation after issuer demotion/removal; otherwise document capability-at-issuance semantics.

Unauthenticated password acceptance is intentionally narrow public access, not open registration. Apply bounded JSON/input validation, same-origin checks, rate limiting, generic invalid-token responses, and no-store/no-referrer protections. Unknown or duplicate account must never be silently attached by email; require existing-account authentication. Do not auto-grant instance admin from workspace role.

### SSO acceptance

YAN-359 #774 (`926151d1`) already owns admission/group mapping in `src/lib/users/ssoProvisioning.js`; OIDC/SAML callbacks use verified identity tuples. Carry invite proof through server-controlled short-lived SSO state, validated with existing nonce/PKCE or SAML request correlation. Do not accept client-supplied issuer/subject or use matching email as linking authority. Verified email may satisfy invite email restriction; it never establishes account identity.

Extend existing admission transaction rather than accepting invitation after unrelated JIT provisioning. Keep allow-list, disabled-user checks, identity uniqueness, owner bootstrap protection, group-claim failure handling, and IdP sync boundaries intact. Invitations require explicit approved-account behavior so successful invite does not create unusable `pending` membership by accident. `source='invite'` must survive later IdP login, including memberships converted from IdP provenance by intentional manual management.

### Lifecycle, membership, and deletion

Expose paginated users list, approval, constrained instance-role changes, disable/enable, deletion, and ownership transfer through explicit request schemas. Use existing `updateUserUnscoped()` so manual instance-role assignment clears `instanceRoleSource` and bumps `sv` correctly. Re-enabling user must not revive revoked personal keys. Admin versus owner target hierarchy needs explicit policy before exposing writes; match conservative temporary-password precedent unless maintainer decides otherwise.

Membership APIs must deny personal-workspace additions and cross-workspace managers, enforce last owner/manager and chosen workspace-owner policy, reject client-controlled `source`, and revoke removed user's keys for that workspace without touching service keys. Current role-update helper preserves `source='idp'`; explicit manual override needs provenance conversion or IdP sync can overwrite it on next login. Avoid demoting/replacing an existing higher-role membership implicitly during invite acceptance.

Deletion already cascades identities/memberships and deletes personal workspace in `deleteUserUnscoped()`. Scoped connections, nodes, combos, workspace settings, and hashed keys have workspace FKs; shared creator FKs use `ON DELETE SET NULL`. Verify every actual storage shape, including older upgraded fixtures. Explicitly remove personal `ws:<id>/` kv rows because text prefixes have no FK. Preserve shared resources and service keys; represent null creator as workspace-owned rather than inventing a fake user. User-owned keys in shared workspaces must also disappear or remain unusable. Preserve audit/history attribution. Add a focused `workspaceKeys` cleanup only when YAN-365 creates that table and its destruction contract; do not fabricate encryption now.

Ownership transfer requires fresh proof from current owner, not mere live cookie, JWT issuance time, `amr`, or CLI bypass. Reuse password verification and rate limiter for password owners; SSO-only owners need genuine re-authentication challenge/callback binding or documented fail-closed behavior. Bind proof to actor, target, current `sv`, operation, expiry, and single use. Recheck authority inside transfer transaction; demote current owner before promotion to satisfy unique owner index. Both users' old sessions must stop working.

## Improvement Ideas (Out of Scope)

- Invitation email transport, resend automation, branded acceptance pages, and admin UI: defer to M5 or dedicated delivery issue. Return one-time invite token for operator distribution now.
- Encryption, backup erasure, workspace DEK rotation, and import/export redesign: YAN-365/YAN-375; coordinate deletion contract only.
- General-purpose re-auth framework, sessions table, configurable ACLs, and organization hierarchy: unnecessary for YAN-360. Add only minimal operation-bound ownership proof.
- Broader audit retention/observability redesign: existing YAN-367 interface suffices; add event coverage only.

## Risk Assessment

| Risk                            | Existing behavior / consequence                                                                                     | Required mitigation                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin scope ambiguity           | Capability map grants workspace member management to admins only where they belong; #228 says admin creates invites | Resolve narrowly: privileged instance invite path may use `instance.users.manage`; ordinary workspace paths stay membership-scoped. Do not grant admins personal-resource use.                      |
| Off-switch guard ordering       | Middleware can return 401/403 before handler's 404                                                                  | Test real HTTP, authenticated and anonymous, all methods, both clean legacy and security-latched DB. Ensure intended off-switch 404 at guard boundary if needed, without bypassing legacy security. |
| Invite races / partial accounts | User/workspace/membership/consume spans several tables                                                              | One synchronous transaction; conditional consume, rollback, concurrency and failure-injection tests.                                                                                                |
| Privilege/provenance drift      | Instance roles track IdP source; manual membership role update retains IdP source                                   | Validate target hierarchy and write provenance explicitly; subsequent SSO login must not undo approval/manual decisions.                                                                            |
| Incomplete deletion             | kv scopes lack FK; shared creator becomes null; future DEKs absent today                                            | Enumerate resources, remove exact workspace-prefixed rows, preserve shared ownership/service keys, coordinate YAN-365.                                                                              |
| Stale actor authority           | Cached principal can outlive concurrent demotion/disable                                                            | Re-read actor/target/membership in sensitive write transaction and invalidate session cache after commit.                                                                                           |
| SSO hijack / pending dead end   | JIT defaults pending; no invite transport exists in SSO start/callback                                              | Operation-bound server state; verified tuple only; explicit invite-approved policy; no email-only merge.                                                                                            |
| Audit leakage / missing fields  | Audit scrubber allow-list excludes `instanceRole`; free text can still carry secrets under permitted keys           | Emit handcrafted IDs/roles/status/count snapshots and fixed reasons; test logs and persisted events, not only HTTP responses.                                                                       |

## Alternative Approaches

1. **Recommended: thin routes plus existing repositories and one invitations repository/service.** Smallest diff retaining single ownership/RBAC model. Add sync transactional helpers only where atomic acceptance requires them.
2. **Delay until encryption lands.** Unnecessary blocker: #228 depends on YAN-358, not YAN-365. Current deletion must work now; DEK destruction belongs to encryption integration. Revisit if maintainer makes cryptographic erasure immediate acceptance criterion.
3. **Password-only invitations.** Smaller but incomplete: issue explicitly requires SSO-linked acceptance. Reject as final delivery; may serve internal first implementation batch only.
4. **Generic lifecycle platform with new sessions/audit abstractions.** Higher surface and duplicated controls, contradicts approved ADRs. Reject.

## Task Breakdown Preview

1. Freeze endpoint schemas, actor/target hierarchy, invitation role/email semantics, owner re-auth flow, and personal/shared deletion matrix. Add failing security/isolation/off-switch tests using existing harness.
2. Add invitation schema/migration/classification and transaction-local token-state/account/membership operations. Test fresh install, legacy upgrade, rerun, rollback, expiry, revoke, and concurrent acceptance.
3. Add gated lifecycle and membership routes; register route policy; add SQL pagination, explicit projections, provenance handling, session/key revocation, exact kv cleanup, and redacted audit coverage.
4. Add ownership transfer re-authentication and invite acceptance for password and existing OIDC/SAML flows. Test actual cookies/state plus identity uniqueness and no email merge.
5. Orchestrator owns full validation and review. Rebase before final checks; coordinate YAN-365 migration/deletion integration and retain master-only v1.1.0 target.

Critical validation path:

- Run `npm run lint`, `TOKENHOP_MULTI_USER=off npm test`, `TOKENHOP_MULTI_USER=on npm test`, `npm run build`, and `npm run lint:brand` from worktree root. Use only isolated test configuration; focused runs use `npx vitest run -c tests/vitest.config.js ...`. Never run another config against real HOME/DATA_DIR.
- Require tenancy classification guard, route-policy coverage, baseline regression gate, and legacy-DB migration fixtures. No new known-fail entries for feature regressions.
- Security matrix: anonymous/pending/disabled/user/admin/owner × personal/shared-A/shared-B × owner/manager/member/viewer × read/create/update/delete/transfer; cookies versus gateway bearer/CLI/restricted password-change credentials; cross-site JSON and malformed/non-JSON bodies; switch off/on and security latch off/on.
- Invite matrix: success, seven-day boundary, reuse, revoke, concurrent accept/revoke, forged workspace/role/source, email mismatch/unverified email, duplicate account/identity, issuer demotion/removal policy, personal workspace target, and insertion rollback. Cover password plus OIDC/SAML round trips.
- Lifecycle matrix: owner invariants, admin escalation/peer target policy, fresh re-auth replay/wrong target/expiry, disable session and personal-key rejection, enable without key resurrection, role/provenance change, removed-membership key denial, sole-manager deletion rollback, and personal cascade versus shared/service-key survival.
- Assert no password/key/invite hashes or raw tokens in list/detail/log/audit; only create response reveals newly minted invitation token. Exercise real temporary-DATA_DIR HTTP flows to catch middleware ordering and cookie differences missed by direct-handler tests.
- Self code review and security review must fix every real finding. PR includes Decisions, Isolation matrix, Verification evidence, `Closes YAN-360`, behind-switch landing, and green CI in both states on rebased head. No UI validation required unless UI is added; UI remains out of scope.

## Key Decisions Needed

- Exact routes and verbs; whether instance-level invite management bypasses admin workspace membership through existing `instance.users.manage` capability.
- Invitation roles: allow workspace `owner`, or constrain to manager/member/viewer? Specify workspace-owner immutability separately from last-manager invariant; existing repository only enforces last-manager count.
- Accepted invitation's instance role, existing-member behavior, email-binding normalization/verification, and explicit existing-account acceptance proof.
- Admin target hierarchy for approve/role/disable/delete, including peers and self; only owner can transfer/promote instance owner.
- Ownership proof for SSO-only accounts; do not silently substitute setup-token bootstrap or old login session.
- Membership role overrides should become manual provenance; define conflict policy for existing invite/manual/IdP rows.

## Open Questions

- Linear Done confirmation for prerequisite chain is orchestrator responsibility; GitHub mirror and merge ancestry confirm local code, not live Linear state. No remote ref refresh was performed in this lane.
- Should outstanding invites die when creator loses membership/management authority, or remain valid as workspace-issued grants?
- Should pending existing SSO users be approved by invite acceptance, and how does group-driven role source interact with that approval on later login?
- Does shared-resource re-attribution mean existing `createdByUserId = NULL` plus workspace ownership, or an additional explicit representation? Current schema supports former without new column.
- What YAN-365 contract destroys wrapped DEK on personal-workspace deletion, and does its migration allocate version 012 before this branch? Recheck rebased schema before integration.
- Must ownership transfer support both OIDC and SAML re-authentication immediately? Issue requires re-auth; any unsupported path must fail closed and receive explicit scope decision, not undocumented bypass.
