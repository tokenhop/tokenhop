# YAN-360 — Security research: invitations + admin user lifecycle APIs

Scope: server APIs only (UI lands in M5). Threat-model + controls + test matrix for implementers.
Must-reads: `docs/users/README.md` §2 (one-api#2425 lesson)/§4/§8, `docs/users/spec.md`,
ADR-0002 (roles/capabilities), ADR-0003 (identity/bootstrap), ADR-0004 (sessions `sv`),
ADR-0005 (key hashing). Repos: `usersRepo.js`, `membershipsRepo.js`, `workspacesRepo.js`,
`identitiesRepo.js`, `apiKeysRepo.js`, `auditRepo.js`. Auth: `routePolicy.js`,
`dashboardSession.js`, `userPassword.js`, `loginLimiter.js`, `sameOrigin.js`.

## Executive Summary

Invitation + lifecycle APIs concentrate every privilege path in one place:
token minting, role assignment, session revocation, key revocation, ownership
transfer, deletion cascade. Biggest risks: invite token leakage/replay,
privilege escalation through role fields, cross-workspace management by
managers, stale sessions after disable, and secret leakage in list responses
(one-api#2425 repeat). All new routes sit behind `requireMultiUser()` (404
while off) and the route→capability table (YAN-357); handlers re-check the
row's workspace live against the DB.

Top controls: hash invite tokens at rest (HMAC, same master-key loader as
ADR-0005), single-use consume inside one transaction, pre-assigned workspace

- role only (no instance-role field on invites), re-authenticate owner on
  transfer, bump `sv` + tombstone personal keys on disable, owner-immutability
- last-manager guards kept in repo transactions, `apiKeyMetadata`-style
  projections on every response, audit deltas carry ids/roles only. See "Gaps in current
  code" below Findings — `membershipsRepo` role/source validation and the delete cascade
  are the load-bearing pieces still missing.

## Threat Model

Assets: invite tokens, `users.passwordHash`, session JWTs (`sub`/`sv`),
gateway API keys (raw shown once), workspace DEKs (M2), membership rows,
audit log. Attackers: anonymous internet (accept endpoint is public),
authenticated low-privilege user (member/viewer/pending), malicious manager
(cross-workspace), former user (stale session/key), DB/backup reader
(offline brute force).

Trust boundaries: public accept endpoint vs authenticated manage endpoints;
cookie session vs gateway key vs CLI token; personal workspace (admins see
metadata only, never secrets/use) vs shared workspace; manual/invite vs
`source='idp'` rows (IdP sync owns only its rows).

Invite lifecycle: create (ws owner/manager in that workspace, or instance
admin/owner with `instance.users.manage` in any shared workspace;
pre-assigned role ≤ caller's grantable set) → store hash only, return raw
once → accept within 7 days: (a) new password account, or (b) authenticated
SSO identity links `(provider, issuer, subject)` after SSO login, never by
email alone → membership `source='invite'` → token consumed (single use),
revocable before use. Optional email binding: accept only when request email
matches (case-insensitive).

Lifecycle: list (paginated, no hashes/secrets) → approve pending / change
instance role (owner immutable except via transfer) / disable-enable
(`sv` bump + personal key tombstone) / delete (personal workspace cascade,
shared resources re-attributed, service keys survive) / ownership transfer
(owner re-auth).

Out of scope: encryption/DEK destruction mechanics (YAN-365), UI (M5),
per-device revoke (deferred per ADR-0004), SSO JIT proper (YAN-359).

## Findings by Severity

### CRITICAL

1. **Invite token stored or returned raw after creation.**
   Leak via DB/backup/export/audit/log turns invite into account creation.
   Control: generate ≥128-bit `crypto.randomBytes`, store HMAC-SHA256 with
   master-key-derived hash key only; raw value in create response exactly
   once; never in list/detail/audit/log. Test: DB holds no raw token; list
   responses contain no token/hash.
2. **Invite replay / double-accept race.** Two concurrent accepts mint two
   accounts or escalate. Control: consume-then-create inside one DB
   transaction (`UPDATE … WHERE consumed IS NULL`, check `changes === 1`);
   second accept fails closed. Test: parallel accepts → exactly one succeeds.
3. **Privilege escalation via role fields.** Caller passes
   `instanceRole`, `role: 'owner'` on another workspace, or invites into a
   workspace they don't manage. Control: invite body carries only
   `{ workspaceId, role }` with role ∈ {manager, member, viewer}; no
   instance-role field; handler verifies live workspace management authority
   (`workspace.members.manage` on the exact workspace), with an exception for
   instance admins/owners holding `instance.users.manage` on any shared
   workspace; personal workspaces reject invites. Test: manager→other-workspace 403;
   member/viewer/pending create 403; `instanceRole` in body ignored/rejected.
4. **SSO accept links by email.** Email-takeover hands over invited slot.
   Control: link only by `(provider, issuer, subject)` UNIQUE; email binding
   compares verified IdP email informationally, never links on it.
   Test: SSO login with matching email but different `sub` does not claim
   invite.
5. **Ownership transfer without fresh re-auth.** Stolen session transfers
   instance. Control: require current password (bcrypt compare, dummy-hash
   timing path for unknown) or fresh SSO assertion; single transaction
   demote-then-promote (respects single-owner index); bump both `sv`.
   Test: transfer with wrong/stale password fails; both sessions die.
6. **Disable leaves sessions or keys alive.** Former user keeps gateway
   access. Control: `updateUserUnscoped`-style tx: `status='disabled'` +
   `sv` bump + `revokeUserApiKeysSync` tombstone in same transaction; drop
   session cache; eligibility query (`getEligibleApiKeySync`) rejects
   disabled/pending/unmembered keys. Test: disable → dashboard token and
   personal key rejected (modulo ≤5 s cache, then hard fail).
7. **List/detail leaks hashes or secrets (one-api#2425).** Admin user list
   returning `passwordHash`, key material, or keyHash enables escalation.
   Control: fixed allow-list projections (`COLS`-style, never `SELECT *`);
   keys via `apiKeyMetadata` only; no-secrets assertion test on every
   endpoint. Test: response JSON scanned for hash/key/secret fields.
8. **Switch-off exposure.** New routes reachable with
   `TOKENHOP_MULTI_USER=off`. Control: every new route through
   `requireMultiUser()` → 404 while off; route-policy rows added; single-user
   regression suite green. Test: all new routes 404 with switch off.

### WARNING

1. **Last-owner / last-manager violation, incl. races.** Removing/demoting/
   deleting last manager bricks workspace; deleting user orphans owned rows.
   Control: reuse `assertNotLastManager` inside the same transaction for
   remove/role-change/delete; owner row immutable (`OWNER_IMMUTABLE`);
   concurrent demotions serialized by tx (second gets `LAST_MANAGER`).
   Test: two concurrent last-manager removals → one fails; owner delete/
   disable/demote rejected.
2. **Accept-endpoint user enumeration.** Distinct errors/timing for
   invalid vs expired vs consumed lets attackers harvest invites.
   Control: single generic failure after same-cost work; rate-limit accept
   by IP + token-hash bucket; no existence oracle in list (invites listed
   only to managers of that workspace). Test: three token states return
   identical shape/latency class.
3. **Email binding bypass.** Case/whitespace tricks claim bound invite.
   Control: normalize (trim + lowercase) both sides; bound invite requires
   verified email match; unbound invite optionally claims any SSO identity
   but still links by `(provider, issuer, subject)`. Test: case-variant
   mismatch rejected; unverified email rejected for bound invite.
4. **Expired invite accepted (clock skew / TOCTOU).** Check-then-use gap.
   Control: expiry predicate inside consume transaction (`expiresAt > now`);
   7-day TTL from creation; UTC ISO compare. Test: just-expired token
   rejected even under concurrent accept.
5. **Revoked invite still usable.** Revoke writes but accept path reads
   stale. Control: `revokedAt` tombstone checked in same consume tx; revoke
   restricted to creator/manage-capable; audited. Test: revoke → accept
   fails; revoke of consumed token no-ops safely.
6. **CSRF on cookie-authed mutations.** `SameSite=lax` alone does not stop
   same-site POSTs. Control: `sameOrigin.js` check (Origin/Fetch-Metadata)
   - JSON content-type on all mutating routes; state-changing via POST/
     PATCH/DELETE only. Test: cross-site POST without Origin blocked.
7. **Rate-limit gaps on invite/login/transfer.** IP-only limiter lets one
   actor hammer many accounts, one account lock out many IPs.
   Control: `loginLimiter` IP + account buckets on login/accept/transfer/
   re-auth; progressive lockout; success clears account bucket only.
   Test: distributed guessing throttled; legitimate user unaffected.
8. **Session cache staleness after disable/role change.** ≤5 s window per
   ADR-0004. Control: drop cache entry in same process on every bump;
   document ≤5 s cross-process bound; security-sensitive handlers may
   bypass cache. Test: disable → in-process token fails immediately.
9. **IdP-sourced rows mutated by invite/member APIs.** Manual manage
   clobbers SSO sync. Control: `source='idp'` rows excluded from
   invite/member add/remove/role-change (sync owns them per ADR-0003).
   Test: IdP row untouched by member APIs.
10. **Deletion cascade wrong direction.** Personal workspace survives, or
    shared resources deleted, or service keys killed with user.
    Control: delete tx: destroy personal workspace + its connections/keys +
    user keys; re-attribute shared-workspace rows to workspace (never
    delete); service keys (`userId NULL`) survive. Test: cascade fixture
    asserts each class.
11. **Owner demoted/deleted through role patch.** `PATCH role=admin` on
    owner steals instance. Control: repo-level `OWNER_IMMUTABLE` on any path
    touching `instanceRole`/`status` of owner; only `transferOwnership`
    changes owner. Test: direct role/status patch on owner rejected.

### ADVISORY

- **1. Audit rows capture secrets.** Invite token, password, key in
  before/after. Control: audit deltas carry ids/roles/workspace only;
  shared redaction helper; no raw material in `auditEvents`.
- **2. Pagination DoS / unbounded list.** `pageSize` huge dumps users.
  Control: clamp page/pageSize (≤100) as `auditRepo.list` does.
- **3. Weak invitee password.** Accept path skips policy. Control: reuse
  `validateNewPassword` + async bcrypt cost 10; reject default/72-byte+
  passwords; `mustChangePassword` honored.
- **4. Personal workspace confusion.** Invites/membership APIs accept
  personal `workspaceId`. Control: reject with `PERSONAL_WORKSPACE` for
  all multi-member operations.
- **5. Pending users gain access.** JIT/invite default wrong. Control:
  default `pending` (no capabilities, no session); approve is explicit
  admin action, audited.

### Gaps in current code (verified; must close in YAN-360)

- **C-A (CRITICAL) `membershipsRepo.addMembership/updateMembershipRole/removeMembership`
  check membership only, not manager role** (file header defers role checks to YAN-357).
  Any plain `member` or `viewer` of a shared workspace passes `sharedWorkspace()`.
  Also accept caller-supplied `role` (incl. `owner`) and `source` (incl. `idp`/`invite`)
  unvalidated. Control: handler/repo asserts caller role ∈ {owner, manager} (or instance
  admin) live in the same tx; allow-list role ∈ {manager, member, viewer}; force
  `source` server-side (`manual` for direct add, `invite` for accept); managers may not
  change an owner row or grant `owner`; reject targets with `source='idp'`.
- **C-B (CRITICAL) `usersRepo.updateUserUnscoped` does not validate `instanceRole` /
  `status` values** and lets any admin set `instanceRole='admin'` on others or demote
  other admins. Control: allow-list values; `admin` grant/demote of another admin owner-only
  (ADR-0002 lists only owner for escalation-sensitive acts); never accept `owner`;
  `pending→user` approve is separate audited action.
- **C-C (CRITICAL) `deleteUserUnscoped` does not revoke/delete the user's API keys,
  does not re-attribute `createdByUserId` on shared resources, and relies on cascade
  for identities/memberships.** Personal-workspace `workspaceId`-scoped connections/keys
  must be deleted explicitly if no FK cascade exists; shared rows must be re-attributed
  before the user row goes (otherwise orphan `createdByUserId` or FK failure). Control:
  one tx: guards → `revokeUserApiKeysSync` → delete personal-ws rows → re-attribute
  shared rows → delete user; `dropSession`. Test T14.
- **C-D (WARNING) `transferOwnership(ctx, toUserId)` has no re-authentication;** `ctx`
  is a principal object. The handler must verify current password (`verifyPassword` against
  `getUserPasswordHashUnscoped`) behind the limiter, never JWT `amr` alone.
- **C-E (WARNING) `removeMembership` calls `assertNotLastManager` before checking the
  membership exists and allows a manager to remove an owner/self silently;** also
  `revokeUserApiKeysSync` is workspace-scoped (good) but only no-ops while storage is
  `legacy`, so disable/remove with unhashed keys leaves keys valid (switch-on migration
  ordering). Control: invite/lifecycle APIs refuse to run until hashed key storage is
  active, or disable also sets `isActive=0` on legacy rows.
- **C-F (WARNING) `getUserUnscoped`/`listUsersUnscoped` use explicit `COLS` (no
  `passwordHash`) — keep it.** `apiKeysRepo.rowToKey/getApiKeys` still return raw `key`;
  never reuse for admin responses.
- **C-G (ADVISORY) `loginLimiter` is in-memory, bounded 10k entries, evicts oldest;** an
  attacker flooding random identifiers can evict a victim's lock entry. Accept routes need
  their own bucket keyed on token-hash plus IP, and `getClientIp` returns `"unknown"`
  without `custom-server.js` stamping (single shared bucket → self-DoS of accept).
- **C-H (ADVISORY) `isCrossSite` lets requests with no `Origin` and no `Sec-Fetch-Site`
  through** (by design for non-browser). Mutating cookie-authed handlers must also require
  `application/json` (`isJson`); a form POST cannot set it.

## Secure Coding Guidelines

- Every repo function takes `ctx` principal; only explicitly named
  `*Unscoped` functions skip scoping, admin-only. Reuse `assertCtx`,
  `mapConstraintErrors`, `TenancyError` codes.
- Compose lifecycle writes as one `db.transaction`: guards first, writes
  after (see `syncIdpMembershipsSync` pattern); consume-then-create for
  tokens; demote-before-promote for single-owner index.
- Hash secrets with server-held key (HMAC-SHA256 via master-key loader);
  never `SELECT *` on users/keys; project allow-lists; `apiKeyMetadata`
  for keys; dummy-hash compare for unknown accounts.
- Bump `sv` on disable / password change / role change / transfer /
  link-unlink; drop session cache in-process; eligibility checks read
  status + membership live.
- Capability checks twice: route-policy row + live handler re-check of the
  row's workspace (scoped rows). Unmapped routes fail closed.
- Normalize emails (trim/lowercase); compare invite binding against
  verified IdP email only; link identity by stable triple.
- No secret/token/hash/key material in responses, logs, audit, errors.
  Generic accept failures; constant-shape error codes.
- Switch-off: `requireMultiUser()` on every new route; no behavior change
  single-user (raw keys, legacy tokens untouched).

## Dependency Security

- `bcryptjs` (pure JS): cost-10 compare per login/accept/re-auth — CPU DoS
  vector; mitigated by IP+account limiter; keep async (`hash`/`compare`
  only, never `*Sync` on request path). No argon2 (new native dep, rejected
  per ADR-0005).
- `jose` HS256 sessions: secret from `JWT_SECRET` or `DATA_DIR/jwt-secret`;
  weak/default secret = session forgery; document rotation; 24 h expiry
  bounds theft; no per-device revoke in v1.1.0.
- `node:crypto` only for tokens/hashing (no new deps per handbook §8);
  `uuid` v4 for ids (not secrets — tokens must be `randomBytes`).
- SQLite transactions are the concurrency control: last-manager and
  single-use races rely on tx serialization, not app locks. Multi-process
  sharing `DATA_DIR` gets ≤5 s session-cache staleness (documented limit).

## Critical Test Matrix

| #   | Case                      | Setup                                         | Action                                | Expect                                                                         |
| --- | ------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| T1  | Accept happy (password)   | Valid invite, ws W role member                | POST accept + password                | 200, membership `source='invite'`, token consumed                              |
| T2  | Accept happy (SSO)        | Valid invite, authenticated SSO               | POST accept                           | Linked by `(provider,issuer,subject)`, membership applied                      |
| T3  | Reuse                     | Consumed token                                | POST accept again                     | Generic failure, no new account                                                |
| T4  | Expiry                    | `expiresAt` past                              | POST accept                           | Rejected (tx predicate)                                                        |
| T5  | Revoke                    | Revoked token                                 | POST accept                           | Rejected                                                                       |
| T6  | Double-accept race        | One token, 2 parallel accepts                 | Concurrent POST                       | Exactly one succeeds                                                           |
| T7  | Cross-workspace manager   | Manager of A, invite into B                   | POST invite                           | 403                                                                            |
| T8  | Role escalation           | Member crafts `role:'manager'`/`instanceRole` | POST invite/accept                    | Ignored or 403; stored role ≤ allowed                                          |
| T9  | Personal workspace invite | `workspaceId` = personal                      | POST invite                           | `PERSONAL_WORKSPACE`                                                           |
| T10 | Email bind match/mismatch | Bound invite                                  | Accept w/ matching vs other email     | Match ok; mismatch rejected                                                    |
| T11 | SSO email-only link       | Same email, different `sub`                   | Accept                                | Does not claim invite                                                          |
| T12 | Disable kills access      | Active user + session + key                   | Admin disable                         | Dashboard 401 (immediate in-process), gateway key 401                          |
| T13 | Enable re-admits          | Disabled user                                 | Admin enable                          | New login works; old tokens still dead                                         |
| T14 | Delete cascade            | User with personal ws + keys + shared rows    | Admin delete                          | Personal ws/conns/user-keys gone; shared rows re-attributed; service keys live |
| T15 | Last-manager guard        | Sole manager                                  | Remove/demote/delete                  | `LAST_MANAGER`; concurrent pair → one fails                                    |
| T16 | Owner immutability        | Owner row                                     | Disable/demote/delete via patch       | `OWNER_IMMUTABLE`                                                              |
| T17 | Transfer + re-auth        | Owner session                                 | Transfer w/ wrong then right password | Wrong fails; right succeeds; both `sv` bumped                                  |
| T18 | No-secrets list           | Admin lists users/keys/invites                | GET each                              | No `passwordHash`/token/`keyHash`/raw key in body                              |
| T19 | Switch off                | `TOKENHOP_MULTI_USER=off`                     | Hit every new route                   | 404; single-user flows unchanged                                               |
| T20 | Rate limit + enumeration  | Invalid/expired/consumed tokens               | Burst accepts                         | Throttled; identical failure shape                                             |
| T21 | CSRF                      | Cross-site POST to mutate                     | POST without Origin/lax bypass        | Blocked by origin check                                                        |
| T22 | IdP rows untouched        | `source='idp'` membership                     | Member API role/remove                | IdP row unchanged                                                              |
| T23 | Pagination clamp          | `pageSize=10000`                              | GET list                              | Clamped ≤100                                                                   |
| T24 | Audit redaction           | All mutations                                 | Read `auditEvents`                    | Ids/roles only; no secrets                                                     |

## Open Questions

1. Invite-list visibility: managers see pending invites for their workspaces
   only — confirm no cross-workspace metadata leak via pagination counts.
2. Bound-invite claim by existing user: can an invite target an already
   active user (membership add), or new/SSO-link only? Recommend: allow
   existing-user add through same consume tx, audited.
3. Transfer re-auth method: password-only, or also fresh SSO assertion for
   SSO-only owner? Recommend either, verified live (never trusted from JWT
   `amr` alone).
4. Invite quota per workspace / per inviter to bound spam — needed for v1.1.0
   or follow-up?
5. `TOKENHOP_MULTI_USER` switch-off must also hide invite-accept public
   route (404) — confirm accept route is switch-gated, not public-open.
6. Master-key loss story for invite HMAC key: same as API-key hashes (keys
   unverifiable until re-issued) — document alongside ADR-0005/0008.
