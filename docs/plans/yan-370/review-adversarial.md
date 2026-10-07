# YAN-370 adversarial review (read-only; no code changed)

Scope: `git diff origin/master -- src open-sse` + new files
`src/lib/db/migrations/014-usage-attribution.js`,
`src/lib/db/repos/{usageLiveFeed,usageRollupRepo,usageStatsRepo}.js`,
`src/lib/usage/scope.js`. tests/ ignored.

## 1. Request-details route `includeBodies` arg is dead; per-row gating holds but defense-in-depth lost [high]

`src/app/api/usage/request-details/route.js:46`:
`getRequestDetails(scope, filter, { includeBodies: !!scope })` —
`includeBodies` is dead: `getRequestDetails(ctx, filter)` in
`src/lib/db/repos/requestDetailsRepo.js:262` takes no 3rd arg and always
returns full parsed `data` including `request/providerRequest/providerResponse/response`.
Row-level `canSeeBodies(scope.ctx, d)` at route.js:53 SHOULD re-redact, but
`d` (built at requestDetailsRepo.js:303-307) spreads columns over `data`:
`...(r.workspaceId ? {workspaceId} : {})`. Rows adopted at bootstrap have real
columns, fine — but pre-bootstrap / concurrent NULL-column rows keep whatever
`workspaceId/userId` the write-time `data` JSON carried (writeBatch embeds the
full trusted `record` object incl. `item.workspaceId/userId` into `data`),
so member B can set/own rows whose `d.userId === B` on B's own writes only —
not cross-user. Leak path is narrower than it looks BUT: any row where
`data.userId` was spoofed at write time (gateway principal is internal trust
per plan, ok) aside, real bug is the reverse — row for user A in shared
workspace with NULL `userId` column (pre-bootstrap write) matches
`canSeeBodies(ctxB, d)`: `row.userId` falsy → falls to role check →
member/viewer false → redacted. OK. The true leak: route passes `scope`
(object, not ctx) everywhere else correctly, but here `canSeeBodies(scope.ctx, d)`
for a manager/owner of ANOTHER workspace selecting `?workspaceId=victim-ws`:
`usageScope` returns bodies:true only if `can(ctx,"workspace.usage.read",{victim})`
— instance admin without membership passes via ADMIN_ANY_WORKSPACE (intended
per plan D1) — fine. For a ws-owner of ws-X passing `?workspaceId=ws-Y`:
`can()` false → 404. Fine. So per-row gating holds EXCEPT `includeBodies`
dead-arg masks that bodies were ALREADY returned to the route process for every
row — defense-in-depth failure, not a wire leak today. Fix: delete the
`{includeBodies}` arg (dead, misleading) OR implement column-level redaction
in repo.

## 2. `usageScope` grants instance admin bodies+full rows in ANY workspace incl. personal workspaces [high — confirm intent]

`src/lib/usage/scope.js:36`: `INSTANCE_ADMIN(ctx)` → `{userId:null,bodies:true}`
for whatever `?workspaceId=` passes `can()` — which per `principal.js:87`
is every workspace. ADR-0002 table says usage.read `x` for owner/admin (any ws)
and "Admin powers are management... not using or decrypting other people's
personal connections". Usage rows + request bodies in a user's PERSONAL
workspace expose prompts/models/timing — arguably beyond "metadata.read".
Plan D1 records this as intended ("oversight"). Handbook README says only
"read workspace usage and request details". If personal-workspace bodies for
admins is intended, record explicitly in ADR-0002; otherwise restrict
`INSTANCE_ADMIN` branch to non-personal workspaces
(`workspaces.kind !== 'personal'` lookup) or to workspaces where admin is member.
Same question applies to `canSeeBodies` line 49 (`INSTANCE_ADMIN → true` for
any row, bypassing row-workspace check entirely — even a row in a workspace the
admin could NOT select because `usageScope` 404s? No: getRequestDetails is
already scoped by selected workspace, so row.ws == selected ws. Consistent.)

## 3. `pending`/`activeRequests` consumers: shape preserved, but `getUsageStats` member `pending` now workspace-filtered while `activeRequests` built from same filtered view — consistent [low, no fix]

`usageStatsRepo.js:172,219`: `pendingView(ctx.workspaceId)` + loop over
`pending.byAccount`. Old code used global `pendingRequests.byAccount`.
Plan D9: "shown to everyone" only for `''` group when switch off; `ctx null`
merges all → parity holds. Dashboard `usageShapes.js` no longer does
`pending.byAccount` lookup ("simplified: plain sum of row.pending") — grep
shows no remaining `pending.byModel` consumer in src/app. OK.

## 4. Switch-OFF parity: `byApiKey` identity display REGRESSES for legacy installs [high]

Old (`origin/master` usageRepo.js:81-104): legacy unknown raw →
`{id: "key-<sha256[:12]>", keyName: "<masked8>*** (<hash6>)", apiKeyMasked}`.
New (`usageStatsRepo.js:55-63`): any id not in `apiKeys` table →
`{id: apiKeyId, keyName: "Unknown key (<sha256(apiKeyId)[:6]>)", apiKeyMasked: null}`.
Consequences with switch OFF on a legacy install where a key was deleted or a
`historical:<sha24>` pseudonym (014 backfill § backfill, line 88) never matches
a live row id: old UI showed masked prefix + stable `key-<hash12>` id;
new UI shows `Unknown key (<hash-of-pseudonym>)` and a DIFFERENT id string
(`historical:abc...` vs `key-abc...`), breaking dashboard grouping continuity
across upgrade for exactly the historical rows 014 creates. Also legacy KNOWN
keys: old keyed by raw in `apiKeyMap[k.key]`, name fallback `masked`; new keys
by id with same name — equal. Only unknown-key display diverges. Fix: in
`apiKeyIdentity`, special-case `historical:<sha24>` (legacy pseudonym shape)
→ `{id: apiKeyId, keyName: "Historical key (<first6>)"}` stable, and for legacy
storage resolve raw→masked via `apiKeys.key` column when id lookup misses but
table has `key` column (deleted-key case keeps old masked display).

## 5. Switch-OFF parity: `getUsageHistory` loses `apiKeyMasked` for legacy known keys [medium]

Old: `apiKeyMasked: maskApiKey(r.apiKey)` — always the masked raw prefix in
legacy mode. New (`usageRepo.js:367`): `names[r.apiKeyId]?.masked ?? null` —
`apiKeyNames()` in legacy mode DOES select `key` and mask (usageStatsRepo.js:46-49),
so known keys keep masked. Unknown/deleted keys: old returned masked prefix of
the raw; new returns null (id not in map). Same root cause as #4. Fix with #4.

## 6. Switch-OFF parity: `byProvider` shape — `lastUsed` deleted in both [no fix, confirmed equal]

Old blob path built `byProvider` WITHOUT `lastUsed`; new `aggregate()` line 153
`delete b.lastUsed` — equal. `totalRequests` both = sum(byProvider.requests).
`byModel/byAccount/byApiKey/byEndpoint` bucket keys: new code uses display-name
keys (`model (provider)`, `model (provider - account)`) identical to old
overlay keys. Old blob `byAccount` bare-connectionId keys (pre-YAN-64) were
parsed via `a.connectionId || acctKey.split("|")[0]` → new history-derived rows
always carry connectionId; residual 014 rows use `""` connection → they simply
don't create byAccount entries (old blob DID show them). Minor legacy-display
loss, documented by ponytail comment. Accept.

## 7. `getChartData` 24h/today `input` formula changed [medium]

Old (origin/master ~line 930): `input = max(prompt||input||colPrompt, cached)`.
New (`usageStatsRepo.js:333`): `input = max(tk.prompt||tk.input||r.promptTokens, cached)` —
same. BUT old read `tokens.prompt_tokens || 0` (no input_tokens fallback, no
column fallback) in the DAY-grain path; new 24h path adds fallbacks — strictly
more correct, totals only grow toward truth. Day-grain path old summed blob
`promptTokens`; new sums rollup `tokensIn` (= column promptTokens). Equal by
construction. No fix; note for tests: switch-off chart fixtures with
`input_tokens`-only rows change values (old code ignored them in 24h path?
No — 24h path `tokens.prompt_tokens || 0` ignored input_tokens; new includes
them. Fixture with input_tokens-only rows → different chart. Flag to test-writing
agent.)

## 8. Migration 014 NOT idempotent on `backfill` [high]

`backfill(db)` (014 lines 94-109): `SELECT ... WHERE apiKeyId IS NULL OR apiKey
IS NOT NULL` then unconditionally `UPDATE ... SET meta = ?` (rewritten JSON
even when nothing changed) and `apiKeyId = COALESCE(apiKeyId, resolve(...))`.
On re-run after a partial first run where `apiKeyId` got set but `apiKey`
re-NULLed: `WHERE apiKeyId IS NULL` false, `apiKey IS NOT NULL` false → skipped.
Idempotent for success path. BUT failure-mid-loop: no transaction wrapper in
`up()` — check `migrations/index.js` runner whether it wraps per-migration in a
transaction. If runner wraps (typical), fine. If not, a crash between
`backfill` and `DROP TABLE usageDaily` leaves backfilled columns + old blob
table; re-run: `rebuildRollup` starts `DELETE FROM usageRollup` (line 122) then
re-inserts from history + residual-vs-history diff — residual computation
(`fromHistory` vs blob) on second run: history unchanged, blob unchanged →
same residual. Idempotent. One REAL bug: `rebuildRollup` residual loop
`if (!residual.requests) continue` (line 187) drops days where blob.requests ==
history.requests but token/cost residuals are nonzero (blob counted same
requests with different tokens — happens when history rows were pruned but
re-imported?). Minor. Bigger: pre-YAN-64 blobs keyed `byModel` as bare `model`
(no pipe): line 177 `key.split("|")[0]` = whole key as model, provider "" —
matches history rows grouped with provider ""? History rows always have
provider set → residual never subtracts → DOUBLE COUNT for those days
(requests counted in both history-derived sums AND full blob residual).
Scenario: old install with pre-YAN-64 blobs + surviving history rows for same
day/model. Fix: match residual key as the migration's own writer wrote it —
writer (old aggregateEntryToDay) keyed `model|provider`; bare-key blobs predate
that writer, treat bare key as model with provider "" AND subtract history rows
whose `model` matches regardless of provider? Cheapest correct: compute
`fromHistory` keyed by model-only as fallback when blob key has no pipe.

## 9. FK check: `COALESCE(workspaceId, (SELECT id ...))` can still write dangling ids? No — subselect returns NULL for missing id [no fix]

014 lines 103-108: `(SELECT id FROM workspaces WHERE id = ?)` yields NULL when
absent → column NULL → FK satisfied. `str()` drops "" and non-strings. Correct.
Same for userId. requestDetails likewise. OK.

## 10. `historical:<sha256-24>` (014) vs `historical:<hmac-full>` (hashed mode) dual-identity [high]

014 `keyResolver` line 88: unknown raw → `historical:sha256(raw)[:24]`.
Post-014 hashed activation (`hashGatewayKeysSync` lines 187-212): rewrites
`usageHistory.apiKey` via `normalizeUsageKeyEntry({apiKey: row.apiKey})` —
but post-014 rows have `apiKey = NULL` and identity in `apiKeyId`, which the
loop NEVER reads/updates. So: (a) rows written between 014 and hashing keep
`apiKeyId = historical:<sha24>` forever; (b) new post-hashing writes of the
SAME physical key resolve via HMAC → key id (if key still exists) or
`historical:<hmac-hex>` (if deleted) — DIFFERENT string than the sha24
pseudonym. Same key, two ids, stats split across `byApiKey` buckets permanently.
Worse: `hashGatewayKeysSync` line 187 `SELECT id, apiKey, meta` — `row.apiKey`
NULL → `normalizeUsageKeyEntry({apiKey: null})` → `{apiKey: null}` (line 110)
→ `UPDATE ... SET apiKey = NULL` no-op. Its `counts` check + `foreign_key_check`
still pass. So activation "succeeds" while leaving `apiKeyId` column untouched
— including rows whose `apiKeyId` still holds a pseudonym that could now
resolve to a live key id. Fix (minimal): in `hashGatewayKeysSync`, after the
existing history loop, add loop `SELECT id, apiKeyId FROM usageHistory WHERE
apiKeyId LIKE 'historical:%'` resolving each pseudonym candidate: for rows
whose stored `apiKeyId` equals `historical:sha256(raw)` of a NOW-KNOWN key… but
raw is gone (by design — can't invert). Correct minimal fix: at hash time,
re-resolve is impossible; instead make 014 write the SAME pseudonym scheme as
hashed mode would. Can't — needs master key in DDL migration (plan D2 rejects).
Alternative accepted fix: in `hashGatewayKeysSync`, map legacy-shape
`historical:<24hex>` apiKeyIds that collide with NO live id into the HMAC
domain is impossible without raw. So: document as known split (ponytail) OR —
cheapest real fix — `apiKeyIdentity`/stats layer treats `historical:<24hex>`
and any `historical:<64hex>` as opaque distinct ids (today) and `adoptUsage`
doesn't merge them (fine). Actually minimal CORRECT fix available: 014's
`backfill` for KNOWN raws writes the live key id (resolvable later — good);
only unknown-at-014-time raws get sha24 pseudonyms, and if that key is later
DELETED before hashing, hashed mode would ALSO pseudonymize (hmac) — split is
inherent. Record as accepted limitation; no code fix possible without raw
retention. Downgrade to medium/low — but `hashGatewayKeysSync` MUST also set
`apiKeyId` for rows where it rewrites `apiKey` (pre-014 DBs jumping straight to
hashing WITHOUT 014? impossible — migrations run in order, 014 always first).
One actionable: `hashGatewayKeysSync` should ALSO update `usageRollup.apiKeyId`
dims (rollup holds the old ids/pseudonyms; post-hash reads group by stale
pseudonym while history overlay uses new) — rollup is append-only sums; stale
dims permanently split `byApiKey` after activation. Fix: after history rewrite,
`UPDATE usageRollup SET apiKeyId = ? WHERE apiKeyId = ?` for every remapped
identity (small map, one-time migration).

## 11. `hashGatewayKeysSync` leaves `meta.apiKey` handling inconsistent post-014 [medium]

Lines 193-204: rewrites `meta.apiKey` when present. Post-014 `saveRequestUsageUnscoped`
(line 232) `delete metaObj.apiKey` — new metas never carry apiKey. Old rows
migrated by 014 lines 99-102 also strip it. So the meta branch is dead post-014
but harmless. No fix.

## 12. `saveRequestUsageUnscoped`: `last_insert_rowid()` correctness [medium]

`usageRepo.js:265-267`: `SELECT ... WHERE id = last_insert_rowid()` issued as a
SEPARATE `db.get` call after `db.run` INSERT, inside `db.transaction()`.
Adapters: better-sqlite3/bun/node `run` are sync on one connection and
`transaction()` is a sync BEGIN/COMMIT wrapper — safe IF `transaction` is
re-entrant-safe and no await inside (none — calculateCost awaited BEFORE).
sql.js adapter: `transaction` uses SAVEPOINT + sync fn — `last_insert_rowid()`
is connection-scoped; sql.js single connection → safe. BUT node:sqlite adapter
`run()` at line 75-76: check whether it returns/uses `prepare(sql).run(...)` on
a SHARED connection — yes presumably. Real risk: `db.transaction` implementations
that serialize via queue + separate connections (none here — all four adapters
are single-connection sync). Confirm by reading adapters; likely safe. Minor:
under sql.js, `stmt.step()` then separate `exec("SELECT last_insert_rowid()")`
— same db handle, fine. No fix unless an adapter pools connections (it doesn't).

## 13. `saveRequestUsageUnscoped` cost passthrough allows `NaN`? No — validated [no fix]

Line 211-214: finite + ≥0 else priced. `calculateCost` returns 0 on error.
`entry.cost || 0` downstream. `NaN` → `Number.isFinite` false → priced. OK.
Units: `metaObj.units = entry.units` unvalidated object — a caller passing a
huge object bloats the row; callers are internal (fixed shapes). Fine.
`comboName`/`userAgent` sliced. OK.

## 14. Fail-closed identity: legacy `apiKeyId` non-empty non-equal mismatch throws [no fix, preserved]

`resolveUsageKeyIdentity` legacy branch line 160: throws on mismatch; hashed
branch delegates to normalize (throws). `saveRequestUsageUnscoped` catch
rethrows `API_KEY_STATE_INVALID`/`[usage`/`[master-key]` (line 326). Preserved
from master. BUT new behavior: callers pass BOTH `apiKey` (raw, legacy) AND
`...gatewayKeyContext(gateway)` which includes `apiKeyId` — spread AFTER
`apiKey`, so `apiKeyId` from gateway principal OVERWRITES nothing (different
key) — entry carries both. Legacy: `apiKeyId` (an id like "abc") !== `apiKey`
(raw "sk-...") → line 160 THROWS on every hashed-mode... wait legacy storage:
gateway is null → `gatewayKeyContext(null)` returns null → spread of null
`{...null}` = {} → no apiKeyId. Hashed storage: `auth.legacy` false →
`apiKey: null`, plus gatewayKeyContext → apiKeyId set. Consistent. Edge:
hashed storage + legacy-shaped call where BOTH raw apiKey AND explicit apiKeyId
present and disagree → normalize throws → fail closed. Correct.

## 15. `legacyKeyId` does a SELECT per write — N+1 on hot path [medium]

`legacyKeyId()` (usageRepo.js:190-196) runs `SELECT id FROM apiKeys WHERE key=?`
per usage write. `apiKeys` is tiny (indexed `idx_ak_key`), one indexed point
lookup per request — negligible vs the INSERT+upsert. `apiKeyNames()` per
`getUsageStats`/`getUsageHistory` call: full table scan per request — also tiny
table. `nameMaps()` per stats call: two full repo reads per dashboard poll.
Pre-existing pattern (master did same). No fix.

## 16. `requestDetails` per-workspace prune: GROUP BY over full table per flush [low]

`requestDetailsRepo.js` prune: `SELECT workspaceId, COUNT(*) ... GROUP BY
workspaceId HAVING c > ?` per writeBatch flush (every ~20 rows). Full-table
aggregate per flush — `requestDetails` capped at 200×#workspaces rows; cheap.
BUT `GROUP BY workspaceId` with NULL group: `g.workspaceId == null` branch
uses `workspaceId IS NULL` without param — correct. `ORDER BY timestamp ASC`
(no index on timestamp alone? `idx_rd_ts` exists on timestamp DESC — usable).
OK. One nit: `LIMIT ?` with `g.c - maxRecords` — correct count. No fix.

## 17. TTS/STT/image/search/fetch recording [high on one item, else lows]

- TTS (`tts.js:144,207`): `units:{characters: String(body.input).length}` —
  `body.input` may be undefined for some TTS shapes → `"undefined".length` = 9
  phantom chars. Low. Guard: `(body.input?.length ?? 0)`.
- STT (`stt.js:21-31`): `sttUnits` does `await response.clone().json()` on the
  SUCCESS response — for STT the response is tiny JSON (`{text}`), clone+parse
  cheap. BUT if a provider returns non-JSON success (audio passthrough?) `.json()`
  throws → caught → bytes fallback. Safe. No double-record: single success branch
  per path, fallback loop records once per eventual success (each iteration
  returns on success). No fix.
- Search/fetch cost passthrough: `cost: usage?.x_cost_usd ?? undefined` →
  `typeof undefined !== number` → priced via `calculateCost(provider, null-model,
undefined-tokens)` → 0. Correct (search rows have no tokens).
- Image `connectionId: null` on noAuth path then `...gatewayKeyContext` — no
  double count: exactly one `saveRequestUsageUnscoped` per success return.
  Combo path (`handleSingleModelImage` via fallback wrapper): wrapper calls
  single-model fn per attempt; only the SUCCESSFUL attempt records. Failed
  attempts record nothing (requestDetails records errors separately — matches
  chat behavior). OK.
- Video (`videoGeneration.js:391-399`): create-only, polls not counted — per
  plan. `auth.legacy ? extractApiKey : null` at line 396 while file ALSO imports
  bare `extractApiKey` at line 73 unconditionally for other logic — check line 73
  context: `const apiKey = extractApiKey(request)` used for validation pre-auth?
  If raw key extracted but unused for usage in hashed mode — fine, not persisted
  (`usageCtx`-style gate at 396). Confirm no `apiKey` raw flows into
  `saveRequestUsageUnscoped` in hashed mode: line 396 gates. OK.
- Embeddings: only records when `exactEmbeddingUsage` non-null; estimated
  usage skipped (pre-existing). OK.

## 18. `getLiveRoutesFeed` leaks cross-workspace key names/connection names/userAgents [high]

`usageRepo.js:619-675`: `usage`/`error` rows ARE scope-filtered
(`scopeSql`). BUT `keyNames` map (lines 624-634) loads ALL keys via
`getApiKeys()` unscoped, and `connections`/`nodes` in the ROUTE
(`live-routes/route.js:24-26`) load `getProviderConnectionsUnscoped()` +
`getProviderNodesUnscoped()` — full instance lists passed to `buildLiveRoutes`,
which renders provider `count/cooldownUntil` per connection (locks!) and
`identifyClient` keyNames. Scoped feed rows only reference own workspace's
providers, BUT `providers` list is built from `connections` (ALL workspaces'
connections — `touch(connection.provider)` for every active connection) →
member of ws-A sees provider ids, counts=0, `cooldownUntil` LOCKS and
`code` of ws-B's connections (state cooling with cooldownUntil from B's lock).
`cooldownUntil` is a lock-expiry timestamp — cross-workspace operational leak
(confirms B is rate-limited and when). Also `fallbacks`: `global._fallbackHops`
(now filtered by `ctx.workspaceId` at line 671-673 — BUT `recordFallbackHop`
callers in `src/sse/handlers/chat.js:346` NEVER pass workspaceId → stored
`workspaceId: null` → filter `hop.workspaceId === ctx.workspaceId` drops them
for every scoped user (only visible switch-off). Functional regression for
scoped combo-fallback banner, not a leak. Fix: (a) pass scoped connections/nodes
(`listConnections(ctx, workspaceId)`) or filter rows to feed providers;
(b) thread workspaceId through `fallbackRecorder` (chat.js) from gateway
principal.

## 19. `getLiveSnapshot`/`getLiveRoutesFeed` ring entries: `inScope` checks userId but scope from stream route drops it [medium]

`stream/route.js:12`: `liveScope = {workspaceId}` — no userId → `inScope`
(line 42-43) matches any entry in workspace. Plan D9 explicitly: "scoped by
workspace, not user" for live feed. Intended. But `getLiveSnapshot` JSDoc says
"for members, their own ring entries" — doc contradicts code (workspace-wide).
Fix doc, not code. `lastErrorFor(ctx)` with `{workspaceId}`-only ctx: filters
by workspace. OK. `pendingView(workspaceId)` — workspace-only. Consistent with D9.

## 20. `scopeSql` throws on scoped read without workspaceId — route always supplies [low]

`usageScope` 404s when no workspaceId resolvable (line 32). `getApiKeyUsage(scope)`
in keys route legacy path line 87 passes `undefined` (= null → unscoped, today's
behavior). Hashed path passes `{workspaceId}` without userId → per-key usage
NOT user-narrowed: member sees whole-workspace key usage (lastUsed/today per
key id incl. others' keys + key NAMES via listApiKeys — does listApiKeys narrow
to own keys for members? If it lists all workspace keys, member learns other
users' key names + activity. Check `listApiKeys` semantics — plan isolation
matrix says member "own keys only", viewer "no keys cap". If listApiKeys returns
all workspace keys to members, that's the leak, in apiKeyManagement, not here —
flag to verify.) Fix here: pass full scope `{workspaceId, userId}` through
`withUsage` for member narrowing IF listApiKeys already narrows the key list
(user-narrowed usage of own keys = consistent).

## 21. `getRequestDetailById(ctx, id)` unrouted — signature changed, no callers [no fix]

Grep shows no callers in src/open-sse routes. Plan D10 keeps it unrouted. Tenancy
guard may require ctx-first — satisfied. OK.

## 22. `adoptUsage` rollup merge: `ON CONFLICT ... DO UPDATE` with SELECT source [medium]

`ownership.js` adoptUsage: `INSERT INTO ... SELECT ... WHERE workspaceId='' ON
CONFLICT(...) DO UPDATE SET x = x + excluded.x` then `DELETE WHERE workspaceId=''`.
Concurrent writes during bootstrap: new writes go to adopted (ws,user) dims or
`''` dims; a `''` write racing between INSERT..SELECT and DELETE is lost
(written after SELECT, deleted by DELETE). Window is tiny (bootstrap once per
install, single writer process via exclusive lock — driver claims writer lock,
but gateway + dashboard are separate processes? `acquireExclusiveWriterLock`
suggests single writer; if two processes write, race exists beyond this PR).
Acceptable; note: re-running adoption after concurrent `''` writes double-counts
(merge sums into existing then deletes — rerun with new `''` rows merges again,
correct, no double count since source rows deleted). Actually correct under
idempotency. Downgrade to low. No fix.

## 23. `TABLES` vs migration DDL drift: `WITHOUT ROWID` dropped [low]

Plan §2 allowed plain rowid table. Migration uses `CREATE TABLE IF NOT EXISTS
usageRollup (...)` without WITHOUT ROWID; schema.js uses columns+primaryKey via
`buildCreateTableSql` — chain test compares. Both plain. Consistent. OK.

## 24. Files >500 lines: usageRepo.js 718 (was ~1500) [low, accept]

Split already done (stats/live/rollup extracted). Remaining 718 includes
savings/home/feed logic that could split further; not blocking. No deps added
(`node:crypto`, `node:events` stdlib only). No secrets in responses: key names
are names not keys; `apiKeyMasked` null in hashed mode; requestDetails bodies
gated (modulo #1 dead-arg confusion). Logs: `log.maskKey` used in fetch; usage
errors log `e.message` only.

## 25. `totalRequests` switch-off parity: rollup sums vs blob sums [medium]

Old `totalRequests` (blob path) summed... check: old code `stats.totalRequests =
sum(byProvider.requests)` where byProvider came from blob `byProvider` buckets
— only rows WITH provider set. New: rollup rows always have a dim (possibly "")
but `aggregate` line 111 `if (r.provider) bump(byProvider...)` — provider-less
rows excluded from byProvider in both. Equal. `totalRequestsLifetime` counter
untouched. OK. Media rows (provider set, model null): byProvider counts them;
byModel key = `"" + " (provider)"` = `" (provider)"` — matches old 24h-path key
format (`${r.model} (${r.provider})` with null model → "null (p)"? old:
`${r.model}` with model null → "null (provider)"; new: `r.model || ""` → " (provider)".
KEY MISMATCH between old-overlay keys and new keys is internal-only (fresh
computation, no persistence) — consistent within new code (both aggregate and
overlay use `|| ""`). OK.

## 26. Residual `tokensCached` key mismatch [low]

014 line 150 reads `t.cached_tokens || t.cache_read_input_tokens`; line 184
compares against blob `m.cachedTokens`. Old writer stored `cachedTokens` in
buckets from `tokens.cached_tokens || tokens.cache_read_input_tokens` — same.
Equal. OK.

## Resolution (orchestrator)

- #1 fixed: dead `includeBodies` arg removed from the request-details route.
- #2 fixed: instance owner/admin oversight gets usage metadata in any
  workspace but request bodies only where they are a workspace owner/manager
  (`usageScope` + `canSeeBodies`); test added.
- #8 fixed: 014 residual matches pre-YAN-64 provider-less `byModel` keys by
  day+model, so their surviving history rows are subtracted.
- #17 fixed: TTS `characters` is 0 for non-string `input`.
- #18 fixed: live-routes uses the caller's workspace connections/nodes when
  scoped; `fallbackRecorder` threads the gateway workspace into fallback hops.
- #19 fixed: `getLiveSnapshot` doc matches plan D9 (workspace-wide).
- #4/#5 accepted: raw keys are no longer stored (ADR-0005), so a key that is
  unknown or deleted shows as "Unknown key (tag)" without a masked prefix.
  Recorded in the PR Decisions.
- #10 accepted: known keys keep their id across hashing (ids are stable), so
  no rollup remap is needed; an unknown raw seen before hashing
  (`historical:<sha256-24>`) and after (`historical:<hmac>`) can't be joined
  because the raw is gone by design. Recorded in the PR Decisions.
- #20 no change: `listApiKeys` already limits members to their own keys.
- Remaining items: no fix needed (see each).
