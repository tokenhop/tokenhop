# YAN-370 final PR review (#779, 4f3fea61) — read-only

Scope: `git diff origin/master...HEAD` (98 files), incl. tests. The 3 new test
files pass locally (16 tests); no file was edited except this report.

## A. Verification of the fixes

- **#18 live-routes, admin non-member — no 500, but a silently empty panel.**
  `listConnectionsMetadata(ctx, ws)` / `listNodesMetadata` call
  `memberWorkspaceId` (`ownership.js:124-134`), which throws
  `TenancyError NOT_FOUND` for a non-member (admin oversight). The route wraps
  both in `.catch(() => [])` (`live-routes/route.js:27-33`), so the route does
  not 500. Result: for an instance admin not in the selected workspace,
  `connections=[]`, `providerNames={}` → no cooldown/lock state, provider ids
  shown raw. Functional degradation only (see #3). No leak. OK.
- **#18 fallbackRecorder** — `chat.js:276,320,596` all pass `gateway?.workspaceId`;
  `recordFallbackHop` stores it (`usageRepo.js:602`); filter at
  `getLiveRoutesFeed` matches `ctx.workspaceId`. Correct. No test covers it (#9).
- **scope.js** — owner/manager → bodies; instance admin non-manager →
  `bodies:false`, `userId:null`; `canSeeBodies` has no admin branch. Matches
  ADR-0002 and the PR body. `scope.bodies` is now an unused field (nothing reads
  `.bodies`; the route uses `canSeeBodies` per row). Dead, harmless.
- **#8 014 residual `"*"` key** — correct: `add()` writes both
  `day\0provider\0model` and `day\0*\0model`; blob keys with no provider look up
  `"*"`. Residual remains `Math.max(0, …)` so no negative rows. One edge, see #6.
- **#1** `includeBodies` gone from route; stale comment remains (#12).
- **#17** TTS `characters` guarded (`tts.js:151,214`). No test asserts 0 for
  non-string input.
- **#19** doc matches D9.

## B. Remaining issues

### 1. Instance admin gets an empty live-routes/provider-name panel and a mismatched scope model [medium]

`live-routes/route.js:27-33` + `ownership.js:124`. Scenario: admin (not a member
of ws-X) selects `?workspaceId=ws-X`. The usage rows come back (oversight), but
`connections`/`nodes` are `[]` because `memberWorkspaceId` throws and the
`.catch` swallows it → `providers` list only contains providers seen in rows,
no cooling/`cooldownUntil`, no node display names. Also hides real errors (any
DB error is swallowed the same way, pre-existing pattern).
Minimal fix: for an instance admin non-member, use the unscoped list filtered
by `workspaceId` (read-only `SELECT … WHERE workspaceId = ?`) or document it as
a known limit in the PR Decisions. Not blocking.

### 2. `listConnectionsMetadata` returns metadata incl. cooldown locks via `modelLock_*` — verify it carries them [medium, verify]

`rowToConnMetadata` (`connectionsRepo.js:126-133`) decodes with `mode:"metadata"`
and spreads `data`. `buildLiveRoutes.activeLockUntil` reads `modelLock_*` keys
off each connection. If metadata mode redacts or drops non-allow-listed `data`
keys, scoped users lose the "cooling" state entirely (regression vs. switch-off
and vs. the old unscoped list). No test asserts a cooling provider appears in a
scoped feed. Fix: add one assertion in a route test (seed a connection with
`modelLock_x` in the shared ws; expect `state:"cooling"` for member B).

### 3. `getApiKeyUsage` for `/api/keys` is not user-narrowed, but key list is manager-only — safe [low, no fix]

`keys/route.js:82` passes `{workspaceId}` only; `listApiKeys` already requires
manage (`apiKeyManagement.js:117-128`, "only managers list"), so a member gets a
403 before usage. Not a leak. (Accepted #20 holds.)

### 4. Legacy JSON import path stores a raw key in `usageHistory.apiKey` [high — verify, data integrity / secret at rest]

`migrate.js:365-383` (`importLegacyUsage`) still `INSERT … apiKey = e.apiKey`
(raw legacy usage file value) and leaves `apiKeyId` NULL; then
`rebuildRollupFromHistoryUnscoped` groups on `apiKeyId` (NULL → `local-no-key`).
Consequences when a legacy `usage.json` with raw `apiKey` is imported after 014:
(a) raw keys land in `usageHistory.apiKey`, contradicting ADR-0005 / the PR
claim "Raw keys are no longer stored" and 014's "apiKey NULL everywhere";
(b) per-key attribution is lost (all rows → `local-no-key`); (c) readers only
look at `apiKeyId`, so the raw never shows but persists on disk.
Reachable: `hasLegacy && !storageHashed && !alreadyImported && legacyTablesEmpty`
(fresh install migrating from the pre-SQLite JSON layout) — real but narrow.
Fix: in `importLegacyUsage` write `apiKey = NULL` and resolve `apiKeyId` with
the same raw→id / `historical:` logic (extract `keyResolver` from 014 into a
shared helper) before the rollup rebuild; add a test with a raw `apiKey` in the
fixture asserting no raw in any column.

### 5. `getUsageStats` still reads full `usageHistory` since cutoff on every call [medium, perf — pre-existing pattern, now worse for "all"]

`usageStatsRepo.js:274-277`: the rollup path overlays "precise lastUsed" by
`SELECT … FROM usageHistory WHERE timestamp >= cutoff` (cutoff = epoch 0 for
`period=all`, `/api/usage/history`) — O(all history) per request, was the same
in master, but history no longer carries the whole pre-SQLite days, and each row
now also builds 4 key strings. With 100k+ rows the dashboard poll is O(N).
Not a regression; flag. Minimal fix: replace the row loop with
`SELECT provider, model, connectionId, apiKeyId, endpoint, MAX(timestamp) … GROUP BY` .

### 6. 014 residual: `"*"` key conflates providers for the same model [low]

`014:…add(…\0*\0model)` sums history across all providers for that model on that
day. A blob key with no provider subtracts that total from the blob's count —
correct for pre-YAN-64 data (no provider). But a **provider-less blob key whose
model also exists under two providers in history** over-subtracts from one
bucket and under-subtracts from none → undercount residual (never negative).
Accept; document in the `ponytail:` comment.

### 7. Tests: the "owner A sees all" route test passes with an owner who is also instance owner [medium, partial vacuity]

`usage-scoped-readers.test.js:159-175`. `seedTenancy` makes A `instanceRole:"owner"`
and ws-owner of Shared. So A's `bodies:true` could come from either the
workspace-owner role or an instance-admin branch; the post-fix code has no admin
branch for bodies, and A is also owner of Shared, so the test cannot distinguish
"workspace owner sees bodies" from a regression that re-adds an admin override.
The **admin-non-member** case (the very thing fix #2 changed) is covered only
by a pure-function `canSeeBodies` call with a hand-built ctx
(`:184-187`) — not by a route call. No route test with an instance admin who is
not a Shared member selecting `?workspaceId=shared` (expect rows visible, bodies
redacted, live-routes not 500). Fix: seed a third user C (`instanceRole:"admin"`,
no membership) and add three route assertions.

### 8. Tests: members-see-own-only is asserted, but viewer is not [medium]

Isolation matrix claims viewer = own rows only (PR table). `usageScope` handles
viewer via the fall-through `userId: ctx.userId`, but no test seeds a viewer. A
regression making `viewer` fall into the owner/manager branch is unguarded. Fix:
`addMembership(..., role:"viewer")` for a user D, assert 1 own row.

### 9. Tests: `usage-live-feed-scoped.test.js` covers only the in-memory feed; no test for the stream route, `getLiveRoutesFeed` scoping, `fallbackRecorder` threading, or `lastErrorFor` [medium]

`:19-40` calls `getLiveSnapshot` directly with a hand-built ctx — no
`usageScope`, no route, no SSE frame filtering (plan §5 promised "SSE stream
route emits filtered frames per subscriber principal"). The ring is seeded via
`pushToRing` with `workspaceId`, and `_recentRing.initialized = true`, so the DB
ring init path is never exercised. The listed live-routes fix (#18) has zero
test coverage. Fix: one route test for `/api/home/live-routes` as B (assert no
foreign providers/locks) and one for `fallbackHops` filtering by workspace.

### 10. Tests: the writer in `usage-scoped-readers` passes `apiKeyId: null` and never exercises key-name/connection-name leakage [low]

`writeUsage` writes `apiKeyId:null` → `local-no-key`; no row has a key or
connection, so `byApiKey`/`byAccount` names (the leak vector in review #1/#18)
are untested. Fix: write one row per workspace with a distinct `apiKeyId` and
`connectionId`; assert B's stats contain none of A's key names/connection names.

### 11. Tests: media test mocks `@/lib/usageDb.js` so it proves call arguments only [low, acceptable]

`usage-attribution-media.test.js:40` replaces the sink; assertions check the
entry the handler built, not what the writer persists. That is the intended
unit boundary, and `gateway-key-usage-sinks.test.js` covers the writer. Gaps: no
test that combo/fallback paths record once (plan §7.7), none for the legacy
`auth.legacy:true` raw-key passthrough (`apiKey: "raw-client-secret"` is mocked
but only `legacy:false` is run), none for TTS non-string `input`. Fix: add
`legacy:true` case + TTS `input: 5` case.

### 12. Stale comment in the request-details route [low]

`request-details/route.js:49-51` still says "…instance admin; the reader is
asked for bodies only then (D10)" — admin no longer sees bodies and the reader
has no such arg. Fix: update the comment.

### 13. `scope.bodies` is dead [low]

No consumer reads `scope.bodies`; the JSDoc and return shape keep it. Delete or
use it; otherwise it can drift from `canSeeBodies`.

### 14. Bench script uses inlined SQL copies — can diverge from the real write path [low, documented]

`bench-usage-rollup.mjs` header admits it; the PR quotes p50 0.2238ms→0.0457ms
from this synthetic copy, not from `saveRequestUsageUnscoped` (which also does
the cost lookup, ring push, lifetime counter). The claim "rollup/blob ratio 0.204"
is therefore indicative only. Plan §6 said "calls the real `saveRequestUsageUnscoped`".
Fix: reword in the PR ("inlined SQL copy of the write path").

## C. PR body vs code

- "Raw keys are no longer stored (ADR-0005)" — false for `importLegacyUsage`
  (#4). Otherwise true for the request path and 014.
- "Instance admins get metadata only outside workspaces they manage" — true in
  code (`scope.js`, `canSeeBodies`).
- "`usage-attribution-media`: all six media endpoints record the right IDs and
  units" — true for the success branch per handler (8 cases); combo and legacy
  branches untested.
- "`usage-live-feed-scoped`: the live feed is split by workspace" — true for
  pending/ring snapshot only (#9); not SSE, not live-routes.
- "Adversarial review: … The rest were either fixed or accepted" — #4/#5/#10/#20
  accepted, #1/#2/#8/#17/#18/#19 fixed; consistent with review-adversarial.md.
- "`npm test` passes … with the switch off and on" — not re-verified here; the 3
  new files pass.
- "Closes #238" — confirm the issue number belongs to this change.
- "rollup/blob p50 ratio=0.204" — see #14.

## Counts

critical 0 · high 1 (#4) · medium 6 (#1, #2, #5, #7, #8, #9) · low 6 (#6, #10–#14) · no-fix/confirmed 1 (#3)
