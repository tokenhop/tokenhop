# YAN-370 research: usage storage + migration layer

Paths are relative to the worktree root. Line numbers match HEAD `59457efd`.

## 0. DB engine

- SQLite through a sync adapter API (`db.get/all/run/exec/transaction`). Driver order is in `src/lib/db/driver.js:73-80`: Bun uses `bun:sqlite`; Node tries `better-sqlite3`, then `node:sqlite` (≥22.5), then `sql.js`. Adapters live in `src/lib/db/adapters/*.js`.
- `getAdapter()` (`driver.js:95`) opens the DB once and runs `runMigrationOnce` on first open (`driver.js:88-91`). `getAdapterSync()` is at `driver.js:105`.
- JSON columns use `parseJson` and `stringifyJson` from `src/lib/db/helpers/jsonCol.js`. `_meta` reads and writes use `getMetaSync` and `setMetaSync` from `helpers/metaStore.js`.

## 1. usageRepo (`src/lib/db/repos/usageRepo.js`)

### Write path: `saveRequestUsage(entry)` at :418-519

1. Defaults `timestamp` and sets `entry.cost = await calculateCost(...)` (:237, which uses pricingRepo and `open-sse/providers/pricing.js`).
2. Resolves the key identity with `resolveUsageKeyIdentity(db, {apiKey, apiKeyId})` (:378-416).
   - Legacy storage: `credential` is the raw key. It throws if `apiKeys.keyHash` exists, or if apiKeyId≠apiKey.
   - Hashed storage: it builds a keyHash→id map from `apiKeys` and calls `normalizeUsageKeyEntry`. `credential` becomes the key id, `historical:<hmac>`, or `local-no-key`.
   - It returns `workspaceId` and `userId` unchanged, but **the caller ignores those**.
3. `entry.apiKey` is overwritten with the identity (:434).
4. **workspaceId and userId go only into the `meta` JSON** (:436-438): `metaObj.workspaceId` and `metaObj.userId`. `meta` also carries `savings`, `comboName` and `userAgent`.
5. One `db.transaction` (:448-507) does four writes:
   - `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)` (:449).
   - usageDaily read-modify-write: `SELECT data FROM usageDaily WHERE dateKey=?` (local-date key, `getLocalDateKey` :138), then `aggregateEntryToDay(day, entry)` (:154-205), then upsert `ON CONFLICT(dateKey)` (:483).
   - `_meta.totalRequestsLifetime` +1 through a read-then-upsert (:489-494).
   - `_meta.savingsTokensLifetime` += saved tokens, only once the baseline exists (:501-506).
6. `pushToRing(entry)` (in-memory ring of 50) and `scheduleStatsEvent("update")`.
7. Errors: identity, marker, schema or master-key errors are rethrown (:515). All other errors are only logged.

`aggregateEntryToDay` layout: totals `requests, promptTokens, completionTokens, cachedTokens, cost`, plus these buckets:

- `byProvider[provider]`
- `byModel["model|provider"]`
- `byAccount["connId|model|provider"]`
- `byApiKey["<apiKeyId|raw|local-no-key>|model|provider"]` (meta.apiKey)
- `byEndpoint["ep|model|provider"]`

There is **no byWorkspace or byUser bucket**, and the daily row is instance-global (PK `dateKey` only).

Callers:

- `open-sse/handlers/chatCore/requestDetail.js:178`. It spreads `keyContext`, which `open-sse/handlers/chatCore.js:131-134` builds from trusted `{apiKeyId, workspaceId, userId}`.
- `src/sse/handlers/embeddings.js:161`.
- Both call with `.catch(() => {})`.

### Readers

None take `ctx`. All are instance-wide.

| fn                                                           | line | source                                                                                                                                                                  |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfillSavingsLifetime(adapter)`                           | 24   | usageHistory.meta json_each                                                                                                                                             |
| `getSavingsLifetime()`                                       | 40   | _meta + backfill                                                                                                                                                        |
| `getRequestRateSeries()`                                     | 58   | usageHistory ts last 15m                                                                                                                                                |
| `getLiveSnapshot()`                                          | 314  | in-memory pending + ring                                                                                                                                                |
| `getUsageHistory(filter={provider,model,startDate,endDate})` | 521  | usageHistory                                                                                                                                                            |
| `loadDaysInRange(adapter,maxDays)` (private)                 | 564  | usageDaily                                                                                                                                                              |
| `getUsageStatsUnscoped(period="all")`                        | 574  | usageDaily for long periods; live usageHistory for `24h`/`today` plus an overlay; recent 100 rows; joins connections/nodes/apiKeys for names via `apiKeyIdentity()` :85 |
| `getChartData(period="7d")`                                  | 1053 | usageHistory (today/24h) or usageDaily                                                                                                                                  |
| `getLastActivity()`                                          | 1179 | usageHistory                                                                                                                                                            |
| `getUsageTotals({start,end})`                                | 1199 | usageHistory                                                                                                                                                            |
| `appendRequestLog()`                                         | 1230 | no-op                                                                                                                                                                   |
| `getRecentLogsUnscoped(limit=200)`                           | 1232 | usageHistory                                                                                                                                                            |
| `getUsageSavings(period, now)`                               | 1271 | usageHistory.meta.savings                                                                                                                                               |
| `recordFallbackHop(hop)`                                     | 1385 | in-memory                                                                                                                                                               |
| `getLiveRoutesFeed({windowMs,limit})`                        | 1409 | usageHistory + requestDetails                                                                                                                                           |
| `getHomeSummary(period, now)`                                | 1464 | usageHistory                                                                                                                                                            |

- `src/lib/db/repos/apiKeyUsageRepo.js:12` `getApiKeyUsage()` runs `SELECT apiKey, MAX(timestamp) ... GROUP BY apiKey` over usageHistory.
- Barrel exports are in `src/lib/db/index.js:105-112` and `:182-207`. Shims: `src/lib/usageDb.js`, `src/lib/requestDetailsDb.js`, `src/lib/localDb.js`.
- Route consumers:
  - `src/app/api/usage/{stats,chart,history,logs,request-logs,request-details,savings}/route.js`
  - `src/app/api/home/{summary,live-routes}/route.js`
  - `src/app/api/keys/route.js`
  - `src/lib/home/summary.js`

## 2. Schema (`src/lib/db/schema.js`)

`TABLES` is the declarative current shape. A test checks that the migration chain produces exactly `TABLES`.

- `usageHistory` (:120-142):
  - Columns: `id INTEGER PK AUTOINCREMENT, timestamp TEXT NOT NULL, provider, model, connectionId, apiKey TEXT, endpoint, promptTokens INT, completionTokens INT, cost REAL, status, tokens TEXT(json), meta TEXT(json)`.
  - Indexes: `idx_uh_ts(timestamp DESC)`, `idx_uh_provider`, `idx_uh_model`, `idx_uh_conn`.
  - **There are no workspaceId/userId/apiKeyId columns.**
- `usageDaily` (:143-148): `dateKey TEXT PK, data TEXT NOT NULL` (JSON blob).
- `requestDetails` (:149-165):
  - Columns: `id TEXT PK, timestamp, provider, model, connectionId, status, data TEXT(json)`.
  - Indexes: `idx_rd_ts`, `idx_rd_provider`, `idx_rd_model`, `idx_rd_conn`.
  - `apiKeyId`, `workspaceId` and `userId` exist only inside `data` JSON.
- `buildCreateTableSql(name, def)` is at :328. The def supports `columns`, `primaryKey`, `constraints[]` and `indexes[]`.
- `syncSchemaFromTables` (`src/lib/db/migrate.js:169`) runs after the chain as a safety net. It does ADD COLUMN with PK/UNIQUE stripped, and creates indexes.

## 3. Migration framework (YAN-352)

- Registry: `src/lib/db/migrations/index.js`. Each migration is `{version, name, up(db)}`. Import it, add it to `MIGRATIONS`, and the module sorts by version and rejects duplicates. `latestVersion()` returns the newest. The latest is **013**, so YAN-370 would be **014**. File names are `NNN-slug.js`.
- Rules (comment in index.js:1-13):
  - 001 is frozen, as is every shipped migration.
  - Use literal DDL, not `TABLES`.
  - Update `TABLES` to match.
  - `up()` must be idempotent.
- Runner: `runVersionedMigrations(adapter, migrations=MIGRATIONS)` at `migrate.js:125`.
  - Runs each migration in a transaction with the version stamp `_meta.schemaVersion`.
  - Sets `PRAGMA foreign_keys=OFF` during the migration, and requires `foreign_key_check` to pass before commit.
  - `runMigrationOnce` (:445) takes the pre-migration backup `backupDbLite` → `schema-<from>-to-<to>` (:468).
- Helpers (`migrations/helpers.js`): `tableExists`, `tableHasColumn(db,t,c)`, `indexExists`, `backfill(db, sql, params)` (logs the change count), and `rebuildTable(db, name, newDef, copySql?)` (12-step rebuild with FK check).
- Example of an additive migration, `005-connection-ownership.js`:
  - `ALTER TABLE ... ADD COLUMN workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE` plus `createdByUserId ... ON DELETE SET NULL`.
  - Adds the indexes `idx_pc_ws_provider(workspaceId, provider)`.
  - Each step is guarded by `tableHasColumn` / `indexExists`.
  - **No backfill in the migration.** Ownerless rows are adopted into Default later, at owner bootstrap.
- Example of a rebuild migration, `009-workspace-scoped-combos.js`:
  - `rebuildTable(db,"combos",COMBOS)` adds UNIQUE(workspaceId,name) and the partial unique index `WHERE workspaceId IS NULL`.
  - Returns early if the column already exists.
  - Comment: "no backfill here (no Default workspace exists at DDL time)".
- Example of a new table, `013-workspace-keys.js`: `CREATE TABLE IF NOT EXISTS` guarded by `tableExists`.
- The non-chain transforms with backfill are invoked explicitly at activation time, not at boot:
  - `migrations/hashGatewayKeys.js:43` `hashGatewayKeysSync(db,{masterKey,defaultWorkspaceId,backup,...})` rewrites `usageHistory.apiKey`/`meta` (:186-210) and `usageDaily.byApiKey` (:212-225).
  - `migrations/encryptCredentials.js`.
  - Callers: `src/lib/db/activateGatewayKeys.js:240` and `activateCredentialEncryption.js`.
- Tests:
  - `tests/unit/db-migration-framework.test.js` covers:
    - chain == `TABLES` on every driver (:76)
    - the v1.0.0 fixture `tests/fixtures/db/v1.0.0.sql` upgrade, backup and rerun no-op (:97)
    - rollback on throw (:162)
    - rebuild sample (:182)
    - FK-violation rollback (:242)
  - `tests/unit/db-migration-chain.test.js` has per-migration cases. Pattern from :233:

    ```js
    const db = await createSqlJsAdapter(path.join(tempDir, "preNNN.sqlite"));
    runVersionedMigrations(
      db,
      MIGRATIONS.filter((m) => m.version < NN),
    );
    /* seed rows */ runVersionedMigrations(db);
    /* assert schemaVersion, data intact */ mNNN.up(db); // idempotent rerun
    ```

  - `tests/unit/gateway-key-migration.test.js` covers the usage rewrite under hashing (`seedLegacy()` :64, `dayFixture()` :31).

## 4. Hashed gateway keys (YAN-363)

- Same table name `apiKeys`.
  - Legacy shape: `TABLES.apiKeys`, with raw `key` UNIQUE.
  - Hashed shape: `HASHED_API_KEYS_TABLE` (`schema.js:301`). Columns: `id, workspaceId NOT NULL, userId, createdByUserId, keyHash UNIQUE, hashKid, prefix, name, machineId, legacy, isActive, revokedAt, allowedModels, allowedCombos, expiresAt, lastUsedAt, createdAt`.
  - Rows are tombstoned (`revokedAt`), never deleted. The schema comment says usage attribution has **no FK back to apiKeys**.
- Mode marker: `readApiKeyStorageState(db)` (`src/lib/db/apiKeyState.js:5`) reads `_meta.apiKeysHashedVersion`/`apiKeysHashKid` and returns `legacy` or `hashed`. An invalid pair throws `API_KEY_STATE_INVALID`.
- Raw key → hash:
  - `const {hashKey} = await getApiKeyHashKey(db)` (`src/lib/security/apiKeyHashKey.js:124`). The sync variant is `resolveApiKeyHashKeySync(db, root)` at :142.
  - `hashApiKey(raw, hashKey)` (`src/lib/security/masterKey.js:191`) is HMAC-SHA256 hex.
- Hash → id: `getHashedApiKeyByHashUnscoped(db, keyHash)` (`repos/apiKeysRepo.js:271`). The live-eligibility check is `getEligibleApiKeySync(db, id, {keyHash})` at :293.
- Raw → id or pseudonym: `usageKeyId(raw, {keyIdByHash, hashKey})` (`helpers/usageKeyIdentity.js:63`).
  - Unknown raw keys become `historical:<HMAC(hashKey,"tokenhop/usage-key-id/v1\0"+raw)>`.
  - `local-no-key` passes through.
  - `normalizeUsageKeyEntry` is at :83 and `convertUsageDailyKeys(day,{sourceStorage,...})` at :181.
- Full principal: `resolveApiKey(presented)` (`src/lib/auth/apiKeyPrincipal.js:51`) returns `{workspaceId,userId,apiKeyId,scopes,via:"apiKey"}`, or null in legacy mode. `resolveGatewayAuth(request)` (`src/lib/auth/gatewayAuth.js:108`) returns `{principal, legacy}`. In legacy mode `principal` is null, so there is no identity and usage stores the raw key.
- Legacy raw keys:
  - Legacy mode: the usageHistory `apiKey` column holds the **raw key** and `byApiKey` is keyed by raw.
  - Display masking: `apiKeyIdentity()` (`usageRepo.js:85`) maps raw→id through the `apiKeys` map, otherwise `key-<sha256[:12]>`.
  - Hashed mode: the column holds the id, a `historical:` pseudonym, or `local-no-key`.

## 5. Tenancy classification (YAN-354)

- Registry: `src/lib/db/tenancy.js`.
  - `TABLE_CLASSES` (:15) and `KV_SCOPE_CLASSES` (:55).
  - Classes: `scoped` (needs `scopeColumn`), `instance`, `system`, `usage-attribution` (needs `issue`), `pending-scope`.
  - Current entries: `usageHistory`, `usageDaily` and `requestDetails` are `{class:"usage-attribution", issue:"YAN-370"}` (:36-38).
  - `findUnclassified()` is at :69.
- Guard: `tests/unit/tenancy-guard.test.js`.
  - Every live table and every kv scope must be classified (:156, :164).
  - Every exported function in `src/lib/db/repos/*.js` that touches a **`scoped`** table or kv scope, directly or through same-file or imported helpers, must have first param `ctx` or a name ending in `Unscoped`. Rule at :143-150.
  - `HELPER_ALLOWLIST` (:22) lists sync `db`-first seams by `"file.js:fn"`.
- ⇒ If YAN-370 flips usage tables to `scoped`, the guard flags every reader in §1 that lacks `ctx` and lacks the `Unscoped` suffix: `saveRequestUsage`, `getUsageHistory`, `getChartData`, `getUsageTotals`, `getHomeSummary`, `getUsageSavings`, `getLiveRoutesFeed`, `getLastActivity`, `getRequestRateSeries`, `getSavingsLifetime`, `getApiKeyUsage`, `saveRequestDetail`, `getRequestDetails`, `getRequestDetailById` and `getDistinctProviders`. Each must take `ctx`, be renamed `*Unscoped`, or go on the allowlist.
- Cross-workspace harness: `tests/setup/tenancyHarness.js`. Usage is documented in `tests/README.md:93-116`, and `tests/unit/tenancy-isolation.test.js` is the sample.
  - `seedTenancy()` (:25) returns `{a, b, shared}`. Each of `a` and `b` is `{user, ctx, personal}`. A is owner and B is user; the shared workspace has A as owner and B as member. It wipes the users, identities, workspaces and memberships tables.
  - `callRoute(handler, path, {as, apiKey, method, body, params})` (:50) sends a session cookie with `sub/sv/wid`, or `Bearer`.
  - `denied(promiseOrFn)` (:76) is true for null/false or a `TenancyError` NOT_FOUND/FORBIDDEN, and rethrows anything else.
  - Each scoping PR adds an isolation-matrix row to the PR body.
- Per-file isolated DATA_DIR: `tests/setup/isolateDataDir.js`.

## 6. Default workspace / owner (YAN-356/361)

- `_meta.defaultWorkspaceId` is set in `bootstrapOwnerUnscoped` (`repos/usersRepo.js:441-476`). That function:
  - creates the owner plus `Personal`(personal) and `Default`(shared) workspaces
  - calls `setMetaSync(db,"defaultWorkspaceId",...)` (:468)
  - calls `adoptOwnerlessRowsUnscoped(db)` (:469)
- `defaultWorkspaceIdUnscoped(db)` (`repos/ownership.js:11`) joins `_meta` with workspaces and returns the id or null.
- `adoptOwnerlessRowsUnscoped(db)` (`ownership.js:74`):
  - Runs `UPDATE t SET workspaceId=?, createdByUserId=COALESCE(createdByUserId, owner) WHERE workspaceId IS NULL` over `OWNED=["providerConnections","providerNodes","combos"]` (:8).
  - Also handles kv scopes and combo strategies.
  - Is idempotent and returns 0 before bootstrap.
  - **This is the natural hook for a usage backfill** (add usageHistory and requestDetails there, or alongside).
- Async wrapper: `adoptOwnerlessUnscoped()` (:90).
- Owner id lookup: `db.get("SELECT id FROM users WHERE instanceRole='owner'")` (`ownership.js:77`). `ownerPrincipal(db, via)` is in `src/lib/auth/gatewayAuth.js:26`.
- Membership check: `memberWorkspaceId(ctx, db, wsId)` (`ownership.js:99`) throws `TenancyError NOT_FOUND`.
- Other raw `defaultWorkspaceId` reads: `settingsRepo.js:153`, `workspacesRepo.js:100,126`, `sse/services/comboProbe.js:155`, `api/keys/context/route.js:59`.
- Feature switch: `isMultiUserEnabled` (`src/lib/users/featureSwitch.js`) and `multiUserActive()` (`src/lib/users/bootstrap.js:302`).

## 7. requestDetailsRepo (`src/lib/db/repos/requestDetailsRepo.js`)

- `saveRequestDetail(detail)` (:220) is buffered. It returns early if observability is disabled. It flushes when the buffer reaches `batchSize` (default 20) or on a timer.
- `flushToDatabase()` (:145) calls `writeBatch(db, items, config)` (:167-218), which runs in one transaction:
  - Upserts `requestDetails(id,timestamp,provider,model,connectionId,status,data)`.
  - `data` holds the full record, including the trusted `apiKeyId`, `workspaceId` and `userId` (string or null, :180-185).
  - Headers and URL are sanitized and large fields truncated (`maxJsonSize` 5KB).
  - Prunes the oldest rows beyond `maxRecords` (default 200, :210-216). **The cap is global, not per workspace.**
- Shutdown: `flushSync()` (:319) is registered through `registerShutdownFlusher("requestDetails")` (:347).
- Readers:
  - `getRequestDetails(filter={provider,model,connectionId,status,startDate,endDate,page,pageSize})` (:244) returns `{details, pagination}`.
  - `getDistinctProviders()` (:302).
  - `getRequestDetailById(id)` (:310).
- Writers: `open-sse/handlers/chatCore.js:579,709`, `chatCore/nonStreamingHandler.js:412`, `sseToJsonHandler.js:212,382` and `streamingHandler.js:228,291`.
- Tests: `tests/unit/request-details-{redaction,shutdown-flush,tab}.test.js`.

## Gaps for YAN-370

- None of the three usage tables has workspaceId/userId/apiKeyId columns. Attribution lives only in JSON (`usageHistory.meta`, `requestDetails.data`), and usageDaily has no workspace dimension at all.
- In legacy key mode there is no principal, so new rows get no workspace or user. Pre-existing rows need an adopt-into-Default step, which belongs in the bootstrap path, not in a migration.
- New columns need three things: a frozen literal-DDL migration 014 plus `TABLES`, a `tenancy.js` reclass, and ctx-taking readers (or `Unscoped` renames) to keep the guard green.
