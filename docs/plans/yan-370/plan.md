# YAN-370 — per-user / per-workspace / per-key usage attribution and scoped usage views

Worktree: `.claude/worktrees/tokenhop-users-usage-attribution` (branch `users/yan-370-usage-attribution` → PR into `master`, label `v1.1.0`, no backport). Trunk-landing class: **Behind the switch** (`isMultiUserEnabled` / `requireMultiUser`). With the switch off the product behaves exactly as today: readers return the same data (key identity display included), only the storage shape changes.

Research inputs: `docs/plans/yan-370/research-{storage,recording,readers-authz}.md`. Handbook/spec/ADRs in the **main checkout** `docs/users/`.

---

## 1. Decisions

1. **Member/viewer visibility = own usage only.** Workspace owner/manager see the whole workspace. Instance owner/admin see any single workspace via `?workspaceId=` selector (oversight cap `workspace.usage.read` in ANY workspace, per `ADMIN_ANY_WORKSPACE`) — no cross-workspace aggregate endpoint in this PR. Rationale: least privilege; usage logs leak prompts-adjacent metadata (models, endpoints, key names, timing) that members have no business need for; ADR-0002 is ambiguous here ("member holds `workspace.usage.read`"), so this narrowing is recorded as the PR **Decisions** section. Viewer keeps `workspace.usage.read` but is narrower than member → own usage only.
2. **Legacy-mode raw keys → `apiKeyId` at write time via raw→id join; unknown raw → `historical:<sha256[:24]>` pseudonym.** New helper `resolveUsageAttribution` (in `usageRepo.js`): legacy storage (`apiKeys` has `key`, no `keyHash`) builds `Map(raw → id)`; a raw not in the table becomes `historical:` + `createHash("sha256").update(raw).digest("hex").slice(0,24)`. HMAC (as `helpers/usageKeyIdentity.js` uses) is preferred in principle, but the derivation must never depend on master-key availability on the hot path or inside a migration; raw gateway keys are high-entropy secrets, so a truncated sha256 is equally unlinkable and reversible-safe. When hashing later activates, `hashGatewayKeys` already re-normalizes slots. Hashed storage keeps today's `resolveUsageKeyIdentity` result (id / `historical:<hmac>` / `local-no-key`) and writes it into `apiKeyId`.
3. **The `apiKey` column is dead after 014.** All new rows write `apiKeyId` (id, `historical:*`, or `local-no-key` sentinel) and leave `apiKey` NULL. Migration backfills `apiKeyId` from the old slot (hashed: copy; legacy: raw→id map or pseudonym) then NULLs `apiKey`. Key-name display switches to id joins (`apiKeys.id → name`) — same user-visible names as today. ADR-0005 "new rows write apiKeyId only" satisfied.
4. **`usageRollup` replaces `usageDaily`; keep local-date semantics.** `dateKey` stays server-local (`getLocalDateKey`) so chart/stats parity holds for existing data; budgets (YAN-372) will compute UTC windows from `usageHistory` per spec.md:49, never from the rollup. Historical rollup rows are rebuilt **from `usageHistory` itself** (JS group-by with local dateKey), not from the old blob buckets — the blob's marginal buckets (byProvider/byModel/byAccount/byApiKey/byEndpoint) cannot be decomposed into one grain without double counting, while history has every row with every dim. Old rows lack workspace/user ⇒ rollup rows start with `workspaceId`/`userId` NULL and are adopted into Default/owner at owner bootstrap (see D8).
5. **`usageDaily` (blob table) is dropped in 014** after conversion. Keeping it would double storage and invite drift; the migration transaction + automatic pre-migration backup (`schema-<from>-to-<to>`) is the rollback path. `TABLES` and `tenancy.js` drop the entry.
6. **Rollup grain + sentinels.** One row per `(dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint)` with `requests, tokensIn, tokensOut, tokensCached, cost`. NULL dims are stored as `''` (empty string) because SQLite treats NULLs as distinct in composite PKs — an `ON CONFLICT ... DO UPDATE SET x = x + excluded.x` upsert would silently duplicate rows for NULL dims. Readers `NULLIF(dim,'')` when projecting. Write path becomes one indexed upsert instead of the blob read-modify-write → expected write-latency **improvement**, comfortably inside the ≤20% regression gate.
7. **`requestDetails` cap: 200 per workspace** (NULL-workspace rows form their own group). Global cap lets one busy workspace evict every other workspace's details. Prune SQL: per `workspaceId`, keep newest 200 by `id`.
8. **Backfill split: in-row/in-DB facts in migration 014; owner+Default attribution at owner bootstrap.** 014 backfills `workspaceId`/`userId` from the `meta`/`data` JSON and `apiKeyId` from the key tables (both derivable inside the DB at DDL time). Rows still NULL afterwards (single-user history) get `workspaceId = Default`, `userId = owner` when `adoptOwnerlessRowsUnscoped` runs at owner bootstrap — exactly the 005/009 pattern ("no backfill at DDL time — no Default workspace exists then"). `usageRollup` NULL-dim rows are adopted the same way.
9. **Live feed (pending/ring/emitter) scoped by workspace, not user.** `global._pendingRequests` and the ring gain a workspace dimension: pending keyed `byWorkspace[ws].{byModel,byAccount}`; ring entries already carry the full entry (incl. `workspaceId`). `trackPendingRequest(model, provider, connectionId, started, error, workspaceId)` gains an optional last param (chat callers have `keyContext.workspaceId`; absent → `''` group, shown to everyone — switch-off parity). `getLiveSnapshot(scope)` filters by `scope.workspaceId`; `scope === null` merges all groups = today's payload shape. Pending is ephemeral aggregate ops telemetry with no per-user payload, so workspace granularity is sufficient and avoids empty live panels for members. SSE route (`usage/stream`) resolves the subscriber's scope once and filters every frame.
10. **Request bodies: redacted for everyone while the switch is off (today's behavior); when on, a row's bodies are returned unredacted only to (a) the row's user, (b) a manager/owner of the row's workspace, (c) an instance owner/admin.** List route computes per-row entitlement via `canSeeBodies(ctx, row)`; everyone else keeps `{redacted:true}`. `getRequestDetailById` has no route caller today — it gets the same ctx treatment and stays unrouted (YAGNI).
11. **Console log + translator stay/become `instance.hostOps`-only.** `/api/console-logs`(+`/stream`) already carry the cap; verify and, if missing, set the same cap on the translator routes in `routePolicy.js`. They are process-wide buffers; no per-workspace split.
12. **Media units live in `meta.units`; cost passes through when supplied.** `saveRequestUsageUnscoped(entry)` accepts `entry.units` (e.g. `{characters: n}`, `{seconds: n}`, `{images: n}`, `{queries: n}`, `{fetches: n}`) stored under `meta.units`, and only computes pricing cost when the caller didn't supply one (`entry.cost = entry.cost ?? await calculateCost(...)`). Search/fetch hand their `*_cost_usd` through; everything else gets pricing cost (0 when unknown). Rollup counts `requests` for media rows; token columns stay 0.
13. **`meta.notional` (ADR-0007) is skipped in this PR.** Marking subscription usage requires the connection's `sharing` on the hot path; routing credentials don't carry it today. Not cheap → defer to YAN-372 (which needs it). Record in PR Decisions.
14. **`grantId` column added now, always NULL.** No grant concept exists (YAN-369); the column reserves the ADR-0001 slot with zero write-path cost.
15. **Tenancy class flip.** `usageHistory`, `usageRollup`, `requestDetails` move from `usage-attribution` to `{class:"scoped", scopeColumn:"workspaceId"}` so the tenancy guard enforces ctx discipline on every future reader. Writers (`saveRequestUsageUnscoped`, `saveRequestDetailUnscoped`) take the `Unscoped` suffix: their attribution is trusted internal data (resolved principal), embedded in the entry — the guard's "admin-gated escape hatch" reading is documented in a comment. Readers take a nullable `ctx` first param (`null` = switch-off / ≤1-user unscoped path, mirroring `principalScope()` semantics).

---

## 2. Migration 014 — `src/lib/db/migrations/014-usage-attribution.js`

Self-contained (helpers imports only), literal DDL, idempotent. Registered in `migrations/index.js` (version 14).

```js
// Guards: tableHasColumn / tableExists / indexExists from ./helpers.js
up(db) {
  // 1. usageHistory columns
  if (!tableHasColumn(db, "usageHistory", "workspaceId")) db.exec(
    `ALTER TABLE usageHistory ADD COLUMN workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  if (!tableHasColumn(db, "usageHistory", "userId")) db.exec(
    `ALTER TABLE usageHistory ADD COLUMN userId TEXT REFERENCES users(id) ON DELETE SET NULL`);
  if (!tableHasColumn(db, "usageHistory", "apiKeyId")) db.exec(
    `ALTER TABLE usageHistory ADD COLUMN apiKeyId TEXT`);
  if (!tableHasColumn(db, "usageHistory", "grantId")) db.exec(
    `ALTER TABLE usageHistory ADD COLUMN grantId TEXT`);

  // 2. requestDetails columns
  if (!tableHasColumn(db, "requestDetails", "workspaceId")) db.exec(
    `ALTER TABLE requestDetails ADD COLUMN workspaceId TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  if (!tableHasColumn(db, "requestDetails", "userId")) db.exec(
    `ALTER TABLE requestDetails ADD COLUMN userId TEXT REFERENCES users(id) ON DELETE SET NULL`);
  if (!tableHasColumn(db, "requestDetails", "apiKeyId")) db.exec(
    `ALTER TABLE requestDetails ADD COLUMN apiKeyId TEXT`);
  if (!tableHasColumn(db, "requestDetails", "grantId")) db.exec(
    `ALTER TABLE requestDetails ADD COLUMN grantId TEXT`);

  // 3. workspace-leading indexes
  for (const [idx, sql] of [
    ["idx_uh_ws_ts",  `CREATE INDEX IF NOT EXISTS idx_uh_ws_ts ON usageHistory(workspaceId, timestamp DESC)`],
    ["idx_uh_user_ts",`CREATE INDEX IF NOT EXISTS idx_uh_user_ts ON usageHistory(userId, timestamp DESC)`],
    ["idx_uh_key_ts", `CREATE INDEX IF NOT EXISTS idx_uh_key_ts ON usageHistory(apiKeyId, timestamp DESC)`],
    ["idx_rd_ws_ts",  `CREATE INDEX IF NOT EXISTS idx_rd_ws_ts ON requestDetails(workspaceId, timestamp DESC)`],
    ["idx_rd_user_ts",`CREATE INDEX IF NOT EXISTS idx_rd_user_ts ON requestDetails(userId, timestamp DESC)`],
    ["idx_rd_key_ts", `CREATE INDEX IF NOT EXISTS idx_rd_key_ts ON requestDetails(apiKeyId, timestamp DESC)`],
  ]) if (!indexExists(db, idx)) db.exec(sql);

  // 4. usageRollup table
  if (!tableExists(db, "usageRollup")) db.exec(
    `CREATE TABLE usageRollup (
       dateKey TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT '',
       apiKeyId TEXT NOT NULL DEFAULT 'local-no-key', provider TEXT NOT NULL DEFAULT '',
       model TEXT NOT NULL DEFAULT '', connectionId TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT '',
       requests INTEGER NOT NULL DEFAULT 0, tokensIn INTEGER NOT NULL DEFAULT 0,
       tokensOut INTEGER NOT NULL DEFAULT 0, tokensCached INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
       PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint)
     ) WITHOUT ROWID`);
  if (!indexExists(db, "idx_ur_ws_date")) db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ur_ws_date ON usageRollup(workspaceId, dateKey)`);

  // 5. Attribution backfill (JS loop; drivers may lack consistent JSON1)
  //    usageHistory: meta.{workspaceId,userId} → columns; apiKey slot → apiKeyId.
  //    requestDetails: data.{workspaceId,userId,apiKeyId} → columns.
  //    Legacy apiKeys (raw `key` column): Map(raw → id); unknown raw →
  //    `historical:<sha256(raw).hex.slice(0,24)>`; hashed apiKeys: slot already identity.
  //    After: UPDATE ... SET apiKeyId = ?, apiKey = NULL WHERE id = ?  (only rows still apiKeyId IS NULL)
  backfillHistoryAndDetails(db);   // ~40 lines, idempotent via `WHERE apiKeyId IS NULL` / column-NULL checks

  // 6. Rebuild rollup history from usageHistory (local dateKey), then drop the blob table.
  //    Runs only when usageDaily still exists (fresh DBs skip; restore-rerun skips).
  if (tableExists(db, "usageDaily")) {
    rebuildRollupFromHistory(db);  // JS group-by: localDateKey(ts) × dims → upsert sums
    db.exec(`DROP TABLE usageDaily`);
  }
}
```

- **Rollup rebuild** groups `usageHistory` rows (`timestamp, workspaceId, userId, apiKey, provider, model, connectionId, endpoint, promptTokens, completionTokens, tokens.cached, cost`) by local-date key into a `Map`, then INSERTs. `tokensCached` is parsed from the `tokens` JSON (missing → 0, matching blob behavior).
- **Idempotency**: every ALTER/CREATE INDEX guarded; backfill UPDATEs only touch `IS NULL` targets; rollup rebuild + DROP guarded by `tableExists("usageDaily")`. The runner stamps `_meta.schemaVersion=14` in the same transaction; `foreign_key_check` must pass (all FK values are NULL or valid ids).
- **`TABLES` update (`src/lib/db/schema.js`)**: `usageHistory` and `requestDetails` gain the four columns and the three workspace-leading indexes (keep existing ones); `usageDaily` entry **removed**; `usageRollup` added with the columns above (`WITHOUT ROWID` omitted from the def if `buildCreateTableSql` can't emit it — then plain rowid table with the same PK; verify against the chain test).
- **Adjacent legacy paths (same lane)**: `src/lib/db/migrate.js` `importLegacyUsage` inserts into `usageDaily` — rewrite the `dailySummary` branch to insert `usageRollup` rows (same local-date keys, `''` sentinels); `src/lib/db/migrations/hashGatewayKeys.js` reads/writes `usageDaily` (`SELECT dateKey, data FROM usageDaily`, count check) — guard all of it with `tableExists`, and since post-014 rows carry `apiKeyId`, its history rewrite also sets `apiKeyId` and leaves `apiKey` NULL.
- **Bootstrap adoption**: `src/lib/db/repos/ownership.js` `OWNED`-style additions — `usageHistory`/`requestDetails`/`usageRollup` get `UPDATE ... SET workspaceId = <Default> WHERE workspaceId IS NULL` (and `userId = COALESCE(userId, owner)` for the first two, plus rollup `userId`), inside `adoptOwnerlessRowsUnscoped`. Idempotent; 0 before bootstrap. This is where "existing usage attributed to owner + Default" (README.md:179, ADR-0009:90) happens.

---

## 3. File-by-file change list — 4 parallel lanes

### Shared interfaces (freeze before any lane starts)

```js
// WRITE (Lane A owns usageRepo.js; Lane B only calls this frozen signature)
saveRequestUsageUnscoped(entry); // entry: {provider, model, tokens?, timestamp?, connectionId,
//   apiKey?, apiKeyId?, workspaceId?, userId?, endpoint, status?,
//   cost?, units?, savings?, comboName?, userAgent?, meta?}
// cost passthrough: entry.cost = entry.cost ?? calculateCost(...)
// units → meta.units; writes usageHistory(userId/workspaceId/apiKeyId
// columns) + usageRollup upsert; apiKey column stays NULL.
saveRequestDetailUnscoped(detail); // unchanged shape; writeBatch also fills the new columns from data JSON

// READ (Lane A implements; Lane C only calls). ctx === null ⇒ unscoped (switch off / ≤1 active user).
getUsageStats(ctx, (period = "all")); // was getUsageStatsUnscoped(period); stats from usageRollup + live overlay
getChartData(ctx, (period = "7d"));
getUsageTotals(ctx, { start, end });
getRecentLogs(ctx, (limit = 200)); // was getRecentLogsUnscoped
getUsageHistory(ctx, (filter = {}));
getUsageSavings(ctx, period, now);
getLastActivity(ctx);
getHomeSummary(ctx, period, now);
getLiveRoutesFeed(ctx, { windowMs, limit });
getRequestRateSeries(ctx);
getSavingsLifetime(ctx);
getApiKeyUsage(ctx); // groups by COALESCE(apiKeyId, apiKey)
getRequestDetails(ctx, filter, ({ includeBodies = false } = {})); // requestDetailsRepo
getDistinctProviders(ctx); // requestDetailsRepo
getLiveSnapshot(scope); // scope: null | { workspaceId }
trackPendingRequest(model, provider, connectionId, started, error, workspaceId);

// ROUTE SCOPE (Lane C owns; calls nothing from Lane B)
usageScope(request); // src/lib/usage/scope.js
// → null                                     (switch off / ≤1 active user ⇒ today's unscoped view)
// | NextResponse (401/403/404)
// | { ctx, workspaceId: string, userId: string | null, bodies: boolean }
//   member/viewer ⇒ userId = ctx.userId, bodies = false
//   ws owner/manager (member of it) ⇒ userId = null, bodies = true
//   instance owner/admin (oversight, maybe non-member) ⇒ userId = null, bodies = true
canSeeBodies(ctx, row); // row.userId === ctx.userId || manager+ in row.workspaceId || instance admin
```

Reader WHERE builder (private, Lane A): `ctx === null` → no filter; `ctx.userId` set → `workspaceId = ? AND userId = ?`; else `workspaceId = ?`. Rollup/`usageHistory`/`requestDetails` all use it.

---

### Lane A — storage, migration, repos (merge first; owns all `src/lib/db/**`)

| File                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/db/migrations/014-usage-attribution.js` | NEW — §2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/lib/db/migrations/index.js`                 | Register m014.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/lib/db/schema.js`                           | `TABLES`: columns/indexes per §2; remove `usageDaily`; add `usageRollup`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/lib/db/tenancy.js`                          | `usageHistory`/`usageRollup`/`requestDetails` → `{class:"scoped", scopeColumn:"workspaceId"}`; drop `usageDaily` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/lib/db/migrate.js`                          | `importLegacyUsage`: `dailySummary` → `usageRollup` inserts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/lib/db/migrations/hashGatewayKeys.js`       | Guard every `usageDaily` access with `tableExists`; history rewrite also sets `apiKeyId`, NULLs `apiKey`; counts check conditional.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/lib/db/repos/ownership.js`                  | `adoptOwnerlessRowsUnscoped`: adopt `usageHistory`, `requestDetails`, `usageRollup` into Default (+ owner userId).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/lib/db/repos/usageRepo.js`                  | In-place, **no growth**: rename `saveRequestUsage` → `saveRequestUsageUnscoped`; new private `resolveUsageAttribution(db, entry)` (D2, writes `apiKeyId` column, `apiKey` NULL); replace blob RMW with rollup upsert; readers get nullable `ctx` first param + WHERE builder; `getRecentLogsUnscoped`→`getRecentLogs(ctx,…)`, `getUsageStatsUnscoped`→`getUsageStats(ctx,…)`; `getApiKeyUsage` id-grouping; `apiKeyIdentity` id-join for both storage modes; pending/ring/getLiveSnapshot/trackPendingRequest workspace dimension (D9); ring init selects `workspaceId`. |
| `src/lib/db/repos/usageRollupRepo.js`            | NEW (~120 lines): `upsertRollupRow(db, dims, deltas)` (sentinel + increment upsert), `readRollupRange(db, {startDateKey, endDateKey, workspaceId, userId})` returning rows with `NULLIF(dim,'')`, and `rebuildRollupFromHistoryDb(db)` (shared with migration via literal copy in the migration file — migration stays self-contained; this one is for tests/bootstrap tooling).                                                                                                                                                                                         |
| `src/lib/db/repos/requestDetailsRepo.js`         | `writeBatch` fills `workspaceId/userId/apiKeyId/grantId` columns from the `data` JSON; per-workspace 200-row prune (D7); `saveRequestDetail` → `saveRequestDetailUnscoped`; `getRequestDetails(ctx, filter, {includeBodies})`, `getDistinctProviders(ctx)`, `getRequestDetailById(ctx, id)` ctx-first.                                                                                                                                                                                                                                                                   |
| `src/lib/db/repos/apiKeyUsageRepo.js`            | `getApiKeyUsage(ctx)` — group by `COALESCE(apiKeyId, apiKey)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/lib/db/index.js`                            | Barrel: re-export renames; add `usageRollupRepo` exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

No other lane touches `src/lib/db/**`.

### Lane B — recording call sites (parallel with A against frozen signature; owns all handlers)

| File                                          | Change                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-sse/handlers/chatCore/requestDetail.js` | Rename sink call; pass `units` never; unchanged fields.                                                                                                                                                                                                                                                                      |
| `src/sse/handlers/embeddings.js`              | Rename sink call.                                                                                                                                                                                                                                                                                                            |
| `src/sse/handlers/tts.js`                     | After both success branches: `saveRequestUsageUnscoped({provider, model, endpoint: url.pathname, connectionId?, ...gatewayKeyContext(gateway), apiKey: auth.legacy ? extractApiKey(request) : null, units: {characters: body.input.length}, status: "success"}).catch(() => {})` — thread `url` into `handleSingleModelTts`. |
| `src/sse/handlers/stt.js`                     | Same pattern; `units: parsedDuration ? {seconds} : {bytes: file.size}` (parse `duration` from response when shaped like OpenAI `verbose_json`, else byte fallback).                                                                                                                                                          |
| `src/sse/handlers/imageGeneration.js`         | Same pattern; `units: {images: body.n ?? 1}`. `ponytail:` requested count, not response count — core doesn't return it; upgrade when `imageGenerationCore` exposes `usage`.                                                                                                                                                  |
| `src/sse/handlers/videoGeneration.js`         | On create success only (`:376-389`); `units: {jobs: 1}`; polls not counted.                                                                                                                                                                                                                                                  |
| `src/sse/handlers/search.js`                  | Both success branches; `units: {queries: usage.queries_used ?? 1}`, `cost: usage.search_cost_usd ?? null`.                                                                                                                                                                                                                   |
| `src/sse/handlers/fetch.js`                   | Both success branches; `units: {fetches: 1, characters: content.length}`, `cost: usage.fetch_cost_usd ?? null`.                                                                                                                                                                                                              |

All calls fire-and-forget `.catch(() => {})`, mirroring chat. No `open-sse` core files change.

### Lane C — readers, routes, SSE scoping (parallel; owns `src/app/api/**` usage-adjacent routes + `src/lib/usage/**`)

| File                                                                                                        | Change                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/usage/scope.js`                                                                                    | NEW (~90 lines): `usageScope(request)`, `canSeeBodies(ctx, row)` per shared interface. Uses `principalScope()`-equivalent semantics (switch off or ≤1 active user ⇒ `null`), `workspaceId` selector validated via `can(ctx, "workspace.usage.read", {workspaceId})` (covers admin oversight), role → `userId` filter + `bodies` per D1/D10. |
| `src/app/api/usage/stats/route.js`                                                                          | `const scope = await usageScope(request); if (scope instanceof Response) return scope;` → `getUsageStats(scope, period)` / `getUsageTotals(scope, range)` (`scope` object or `null`).                                                                                                                                                       |
| `src/app/api/usage/{history,chart,savings,last-activity,logs,request-logs,providers}/route.js`              | Same branch; pass scope.                                                                                                                                                                                                                                                                                                                    |
| `src/app/api/usage/request-details/route.js`                                                                | Scope + per-row `canSeeBodies` (redact others); switch-off stays fully redacted.                                                                                                                                                                                                                                                            |
| `src/app/api/usage/stream/route.js`                                                                         | Resolve scope once; every frame `buildLivePayload(await getLiveSnapshot(scope ? { workspaceId: scope.workspaceId } : null))`.                                                                                                                                                                                                               |
| `src/app/api/home/{summary,live-routes}/route.js`, `src/app/api/shell/{summary,savings-milestone}/route.js` | Scope + pass to `getHomeSummary`/`getLiveRoutesFeed`/`getRequestRateSeries`/`getSavingsLifetime`.                                                                                                                                                                                                                                           |
| `src/app/api/keys/route.js`                                                                                 | `withUsage` joins by key **id** (both storage modes); `getApiKeyUsage(scope)` per workspace when scoped.                                                                                                                                                                                                                                    |
| `src/lib/usage/livePayload.js`                                                                              | Accept pre-filtered snapshot only (no change in shape).                                                                                                                                                                                                                                                                                     |
| `src/lib/auth/routePolicy.js`                                                                               | Mark the `/api/usage/*`, `/api/home/*`, `/api/shell/*` rows `scoped: true` (guard checks any-workspace); confirm/set `instance.hostOps` on translator routes.                                                                                                                                                                               |
| `src/lib/users/session.js`                                                                                  | Update the stale "usage still unscoped until YAN-370" comment only.                                                                                                                                                                                                                                                                         |

### Lane D — tests + benchmark (last; owns `tests/**` + `scripts/bench-*`)

See §5/§6. Also: PR body sections **Decisions**, **Isolation matrix**, **Verification evidence** (template has none — add manually), `Closes YAN-370`, trunk-landing class "Behind the switch".

**Dependency order:** A ⇄ B (B codes against the frozen `saveRequestUsageUnscoped` signature; land A first for integration), C needs A's reader signatures (frozen above, so C can start immediately), D last. Lanes have zero file overlap except the frozen interfaces.

---

## 4. Isolation matrix

| Role ↓ / Resource →              | Own usage rows                            | Workspace usage (others')      | Other workspaces' usage                      | Request bodies                            | Live feed / ring / pending   | Console log / translator | Per-key usage        |
| -------------------------------- | ----------------------------------------- | ------------------------------ | -------------------------------------------- | ----------------------------------------- | ---------------------------- | ------------------------ | -------------------- |
| Instance owner/admin (oversight) | ✔                                         | ✔ (any workspace via selector) | ✖ via aggregate; ✔ per-workspace by selector | ✔ (any workspace they can select)         | ✔ selected workspace         | ✔ (`instance.hostOps`)   | ✔ selected workspace |
| Workspace owner/manager          | ✔                                         | ✔ (own workspace)              | ✖ (404/empty)                                | ✔ (own workspace rows)                    | ✔ own workspace              | ✖                        | ✔ own workspace      |
| Workspace member                 | ✔                                         | ✖                              | ✖                                            | ✔ own rows only; others `{redacted:true}` | ✔ own workspace (aggregates) | ✖                        | own keys only        |
| Workspace viewer                 | ✔ (usage.read)                            | ✖                              | ✖                                            | ✔ own rows only                           | ✔ own workspace              | ✖                        | ✖ (no keys cap)      |
| Switch OFF (≤1 user)             | — unscoped, today's views byte-compatible | —                              | —                                            | redacted for all (today)                  | unscoped (today)             | per current policy       | id-joined (today)    |

Cross-workspace access returns 404 (workspace not a selector) or empty result sets — never FORBIDDEN-with-existence, matching `memberWorkspaceId`/`workspaceScope` conventions.

---

## 5. Minimum required tests

| File                                                                                                                                           | Covers                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/db-migration-chain.test.js` (extend)                                                                                               | 014 case per the established pattern: seed pre-014 DB with legacy rows (meta `workspaceId`/`userId`, raw `apiKey` slot, `historical` unknown raw, `local-no-key`), run chain → columns backfilled, `apiKey` NULL everywhere, **no raw key in any column or rollup dim**, `usageRollup` sums equal a `usageHistory` group-by, `usageDaily` gone, counts preserved (ADR-0009:90); `m014.up(db)` rerun idempotent. |
| `tests/unit/usage-rollup.test.js` (NEW)                                                                                                        | Upsert increments; sentinel NULL-dims don't duplicate; range read parity: blob-era fixture (reuse `gateway-key-migration.test.js` `dayFixture()` aggregates) vs rollup reader totals equal; switch-off `getUsageStats(null, …)` matches pre-change fixture (single-user regression).                                                                                                                            |
| `tests/unit/usage-attribution-media.test.js` (NEW)                                                                                             | For each of tts/stt/image/video/search/fetch: mocked sink receives `units` + `gatewayKeyContext` spread + legacy `apiKey` passthrough; video poll records nothing; search/fetch pass `cost`. Chat/embeddings attribution already covered by `gateway-key-usage-sinks.test.js` (keep green).                                                                                                                     |
| `tests/unit/usage-scoped-readers.test.js` (NEW)                                                                                                | `seedTenancy()` + `callRoute`/`denied` from `tests/setup/tenancyHarness.js`: B (member) sees only own rows in stats/logs/request-details within Shared; B cannot see A-personal-workspace data via `?workspaceId=` (404/empty); A (owner) sees all Shared rows; B-promoted-manager sees Shared rows; admin sees selected workspace; `getRequestDetailById` cross-workspace → `TenancyError NOT_FOUND`.          |
| `tests/unit/usage-live-feed-scoped.test.js` (NEW)                                                                                              | Pending + ring keyed by workspace; `getLiveSnapshot({workspaceId})` excludes other workspace's in-flight/ring entries; `getLiveSnapshot(null)` returns merged (switch-off shape); SSE stream route emits filtered frames per subscriber principal.                                                                                                                                                              |
| `tests/unit/tenancy-guard.test.js` (extend)                                                                                                    | Class list: usage tables now `scoped`; guard green with renamed writers.                                                                                                                                                                                                                                                                                                                                        |
| existing `usage-*.test.js`, `api-key-usage.test.js`, `gateway-key-migration.test.js`, `usage-live-stream.test.js`, `request-details-*.test.js` | Updated imports (renames) and kept green under both `TOKENHOP_MULTI_USER=off` and `=on` (CI matrix already runs both).                                                                                                                                                                                                                                                                                          |

No other new tests. UI changes: none required (readers keep response shapes).

---

## 6. Benchmark

- Script: `scripts/bench-usage-rollup.mjs` (NEW, plain node, no deps). Creates a throwaway DB under `/tmp/opencode`, seeds 100k `usageHistory` rows, then times 2 000 sequential writes two ways: `--impl blob` (inlined copy of today's blob read-modify-write) vs `--impl rollup` (calls the real `saveRequestUsageUnscoped`). Prints p50/p99 write latency and totals sanity check.
- Run: `node scripts/bench-usage-rollup.mjs` (documented in the script header; results pasted into PR **Verification evidence**).
- Not wired into `npm test` or CI (gate: rollup p50 ≤ 1.2 × blob p50 — expected to be well under 1.0 since the blob RMW disappears).

---

## 7. Risks

1. **Blob→rollup conversion parity.** Stats/chart shapes are rebuilt from a new grain; subtle bucket-key differences (e.g. `byAccount` bare-connectionId keys from pre-YAN-64 days) can shift legacy displays. Mitigation: parity test in `usage-rollup.test.js` against real fixtures; switch-off totals compared to stored expected values.
2. **`hashGatewayKeys` interaction.** It runs at activation (switch-on) against a post-014 DB where `usageDaily` is gone and `apiKey` is NULL; missing guards would crash activation. Mitigation: `tableExists` guards + count check made conditional; covered by extending `gateway-key-migration.test.js`.
3. **Guard-driven rename churn.** Every exported reader/writer touching the three now-scoped tables needs `ctx` or `Unscoped`; missed ones fail `tenancy-guard.test.js` (good) but break many existing test imports. Mitigation: Lane A does all renames in one pass, barrel re-exports keep old names as aliases only where tests import them (delete aliases before merge).
4. **`WITHOUT ROWID` + `buildCreateTableSql`.** If the def builder can't emit it, use a rowid table with the same composite PK — the chain-vs-`TABLES` test catches drift either way.
5. **Adoption timing.** Rows written between migration and owner bootstrap stay NULL-workspace; if bootstrap never runs (switch never on) they remain instance-global — exactly today's semantics, so no regression. Double-adoption is impossible (`WHERE workspaceId IS NULL`).
6. **Live-feed memory shape change.** `byModel`/`byAccount` nested under `byWorkspace` touches the stats response `pending` field consumers. Mitigation: `getLiveSnapshot(null)` and the scoped projection emit today's flat shape; `usage-live-stream.test.js` extended.
7. **Media handler success paths are multiple and easy to miss** (noAuth + credentialed + combo branches). Mitigation: per-endpoint test asserts the sink call for each branch that returns a response; forgotten branch = visible test gap, not silent.
8. **Per-workspace requestDetails prune cost.** One extra GROUP BY DELETE per flush batch (20 rows) — negligible, but watched in the benchmark run.
