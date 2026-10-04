# External Research: YAN-363 hashed workspace-scoped API keys

## Executive Summary

Binding choices live in `docs/users/adr/0005-api-keys.md` + `0008-encryption-at-rest.md`: new format `th_` + 32 base62 (~190 bits), storage `keyHash = HMAC-SHA256(HKDF(masterKey,"tokenhop/api-key-hash"), key)`, master key `TOKENHOP_MASTER_KEY` or `DATA_DIR/keys/master` (0600), migration only with multi-user switch on after YAN-352 backup. Current code stores raw keys (`src/lib/db/repos/apiKeysRepo.js:73-78` exact-match `WHERE key = ?`; `src/shared/utils/apiKey.js` legacy `sk-` CRC, `Math.random` keyId). Official docs confirm all building blocks exist in `node:crypto`, `node:fs`, SQLite 12-step rebuild + savepoints, Next.js Route Handler auth checks. No new dependency needed.

## Primary APIs (official docs only)

### node:crypto — key hashing, token generation, HKDF

- Source: <https://nodejs.org/download/release/v22.5.0/docs/api/crypto.html> (repo `engines.node >=22.5`, `package.json:6-8`).
- `randomBytes(size)` — CSPRNG, sync/async forms. Use `randomBytes(24)` → 32 base62 chars for `th_` tokens. Replaces `Math.random()` in `src/shared/utils/apiKey.js:12`.
- `createHmac('sha256', hashKey).update(key).digest('hex')` — approved `keyHash` primitive (ADR-0005 Option 2). Constant-time story: Context7 Node v22 docs for `crypto.timingSafeEqual(a,b)` — constant-time compare, **throws if lengths differ**. Lookup design avoids direct need: compute HMAC then `WHERE keyHash = ?` exact match (same shape as today's `validateApiKey`), so no `timingSafeEqual` in hot path; if comparing digests in memory, length-check first.
- `hkdfSync('sha256'|'sha512', masterKey, salt, info, 32)` — approved hash-key derivation (`info "tokenhop/api-key-hash"`). Returns ArrayBuffer; wrap `Buffer.from(...)`.
- Why keyed hash, not plain SHA-256: ADR-0005 verified legacy `keyId` 6×`[a-z0-9]` ≈ 31 bits + visible `machineId` + default `API_KEY_SECRET` constant → offline brute force of plain-SHA256(DB dump) on laptop. HMAC with server-held `hashKey` (never in DB) blocks DB-only guessing. Argon2/bcrypt rejected (hot-path CPU cost, new native dep); unnecessary once new keys carry ~190 bits.

### node:fs — safe master-key file creation (only if approved path taken)

- Source: <https://nodejs.org/download/release/v22.5.0/docs/api/fs.html> (`fs.open` flags, `writeFileSync` mode).
- Exclusive create: `fs.openSync(path, "wx", 0o600)` / `fs.writeFileSync(path, data, { flag: "wx", mode: 0o600 })` — fails if path exists (symlink-safe on POSIX per flags doc). Prevents TOCTOU overwrite of existing `DATA_DIR/keys/master`.
- Precedent already in repo: `src/lib/db/adapters/sqljsAdapter.js:35` uses `fs.openSync(tmpPath, "wx")` + fsync + rename for crash-safe persist. Same pattern applies to master-key file: `mkdir(keysDir,{recursive:true})` → `wx` write 32 `randomBytes` → fsync. Caveat from flags doc: `x` may not hold on some network FS — acceptable; DATA_DIR is local/Docker volume.
- Env source `TOKENHOP_MASTER_KEY` must be base64 32 bytes, validated length before use.

### SQLite — migration atomicity, rebuild, savepoints

- ALTER TABLE limits + 12-step rebuild: <https://www.sqlite.org/lang_altertable.html> — `ADD COLUMN` cannot add `PRIMARY KEY`/`UNIQUE`; dropping `key` column / adding `UNIQUE(keyHash)` requires rebuild. Official 12 steps: `PRAGMA foreign_keys=OFF` (outside txn) → BEGIN → create `new_X` → `INSERT INTO new_X SELECT ...` → DROP old → RENAME → recreate indexes/triggers/views → `PRAGMA foreign_key_check` → COMMIT → `foreign_keys=ON`.
- Repo already implements exactly this: `src/lib/db/migrations/helpers.js:34-64` `rebuildTable()` + `src/lib/db/migrate.js:123-152` `runVersionedMigrations()` (FK off outside txn, per-migration `adapter.transaction()`, `foreign_key_check`, version stamp in same txn, idempotent helpers `tableExists/tableHasColumn`).
- Savepoints: <https://www.sqlite.org/lang_savepoint.html> — `RELEASE` merges inner into parent (outer ROLLBACK still undoes it); outermost RELEASE = COMMIT. Matches `nodeSqliteAdapter.js:88-103` + `sqljsAdapter.js:127-142` `transaction(fn)` SAVEPOINT wrappers. better-sqlite3 official: `db.transaction(fn)` commits on return, rolls back on throw, nested = savepoints (source: <https://github.com/wiselibs/better-sqlite3/blob/master/docs/api.md> via Context7 `/wiselibs/better-sqlite3`). Do not mix raw COMMIT/ROLLBACK inside wrappers; async fns unsupported in better-sqlite3 wrapper — repo adapters use sync `fn()`.
- `keyHash TEXT UNIQUE` + `CREATE UNIQUE INDEX` on rebuild; row-count assertion precedent in `rebuildTable` (before/after COUNT(*)).

### Next.js — request auth wiring

- Source: <https://nextjs.org/docs/app/guides/authentication> (v16.3.8, repo `next ^16.1.6`).
- Official pattern: Proxy/middleware = optimistic checks only; real authorization in DAL close to data source, Route Handlers verify session + role returning 401/403. Maps to YAN-363 scope: `resolveApiKey(key) → { workspaceId, userId?, apiKeyId, scopes }` wired into YAN-355 principal hook + `requireClientApiKey.js` + each handler's `requireApiKey` (chat, embeddings, fetch, search, image, video, TTS, STT, v1beta); close `handleChat` CLI-token gap. Do not rely on proxy-edge check alone; node runtime required for `node:crypto` + DB adapter (`export const runtime = 'nodejs'`; Context7 `/vercel/next.js` route-segment runtime doc).
- Header read: `request.headers.get('authorization')` / `x-tokenhop-cli-token` alias (YAN-377) in Route Handler; `next/headers headers()` alternative in App Router.

## Libraries and SDKs

| Library                 | Version (repo-pinned)                  | Role for YAN-363                                    | Verdict                                                                      |
| ----------------------- | -------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `node:crypto` (builtin) | Node `>=22.5` (`package.json:7`)       | `randomBytes`, `createHmac`, `hkdfSync`             | Use. Zero deps (ADR-0005/0008 mandate).                                      |
| `node:sqlite` (builtin) | since Node 22.5.0                      | Primary driver path 2                               | Use via existing `nodeSqliteAdapter.js`. No change.                          |
| `better-sqlite3`        | `^13.0.3` optional (`package.json:72`) | Driver path 1 (skipped Node ≥24 per `driver.js:24`) | Use via existing adapter. Do not upgrade for this feature.                   |
| `sql.js`                | `^1.14.1`                              | Fallback driver                                     | Covered by `sqljsAdapter.js` SAVEPOINT `transaction()`. No change.           |
| `jose`                  | `^6.1.3`                               | Sessions (HS256)                                    | Not for API keys. Do not reuse JWT for gateway keys.                         |
| `bcryptjs`              | `^3.0.3`                               | Passwords / setup token                             | Not for per-request key validation (ADR-0005 rejects slow KDFs on hot path). |
| argon2 / scrypt KDF     | —                                      | —                                                   | Rejected per ADR-0005 Option 3. No new native dep (handbook §8).             |

No new dependency recommended.

## Integration Patterns

1. **Create (show once):** `randomBytes(24)` → base62 32 chars → `key = "th_"+s` → `hashKey = HKDF(masterKey,"tokenhop/api-key-hash")` → `keyHash = HMAC-SHA256(hashKey,key)` hex → `INSERT(keyHash, hashKid, prefix=first7+last4, workspaceId, userId?, ...)`. Response carries raw `key` once; list endpoints return `prefix` only. Legacy issue text wants `budgetId` later — ADR-0005 already includes `budgetId` column; add nullable now, enforce in YAN-372.
2. **Validate (hot path, same cost as today):** compute HMAC → `SELECT ... WHERE keyHash = ? AND isActive=1` → check `expiresAt`, `allowedModels/allowedCombos` (with YAN-368), update `lastUsedAt` async/off-path. Legacy `sk-` rows: same HMAC lookup with `legacy=1` flag; no CRC branch on hot path (`parseApiKey` unused there today).
3. **Master-key loader (shared YAN-363 → YAN-365):** `TOKENHOP_MASTER_KEY` (base64 32B) else `DATA_DIR/keys/master` `wx`+0600 create-on-first-enable; cache process-wide; track `hashKid` per row; KEK rotation rewraps DEKs only, never rehashes (raw gone) — old HKDF keys stay loadable until rows rotate away.
4. **Migration (switch-on only, after YAN-352 backup):** `rebuildTable(apiKeys, newDef, copySql)` hashing each raw key in place (`legacy=1`, `workspaceId=Default`, `userId=NULL` service key); `usageHistory.apiKey` raw → `apiKeyId`, `usageDaily.byApiKey` `${raw}|model|provider` → `${apiKeyId}|model|provider` (owned YAN-370; do not duplicate here). Switch off: raw storage + exact-match validation byte-identical.
5. **MITM internal credential:** same `th_` generator, `keyHash` in settings next to `mitmSudoEncrypted`, passed as `ROUTER_API_KEY` at spawn (auto-start + restart + `ACTIVE.defaultApiKey` fallback); never an `apiKeys` row, never UI-listed. `src/mitm/handlers/base.js` unchanged.

## Constraints and Gotchas

- **Switch default off** (`docs/users/spec.md:20`, ADR-0009): all hashing/migration/reshape code paths gated; CI runs gate switch-off and switch-on. Irreversible migration runs once, only switch-on, post-backup.
- **ADD COLUMN can't add UNIQUE** (sqlite.org §4): `keyHash UNIQUE` + dropping `key` forces full `rebuildTable`, not `ALTER ADD COLUMN`. Repo `syncSchemaFromTables` strips UNIQUE on ADD COLUMN (`migrate.js:165-177`) — must not be used for this reshape.
- **FK pragma outside txn** (sqlite.org step 1-2; enforced `migrate.js:132-136` throwing if `foreign_keys` stuck ON): keep `rebuildTable` inside `up()` only.
- **`timingSafeEqual` length-throw**: never compare variable-length user input directly; HMAC-then-DB-lookup avoids it.
- **`Math.random` in current `generateKeyId`** (`apiKey.js:12`): must not be reused for `th_` entropy; `randomBytes` only.
- **better-sqlite3 transaction wrapper is sync-only**: migration/validation code must stay synchronous inside `transaction(fn)`; sql.js/node adapters emulate via SAVEPOINT — same rule.
- **sql.js durability**: `exec` only marks dirty, debounced persist (`sqljsAdapter.js:64-77`); migration must `close()`/flush path so `keyHash` rebuild survives crash — `runMigrationOnce` runs pre-persist; rely on existing shutdown flushers.
- **Master-key loss = validation impossible** until re-issue (ADR-0005 consequences); docs YAN-379 must state backup requirement. Changing `TOKENHOP_MASTER_KEY` without old-kid loadable breaks all rows.
- **Raw-key leak surface today** (`GET /api/keys` returns `k.key`; `usageRepo` joins on `k.key`; `local-no-key` sentinel): creation-response-only + prefix-only lists + `apiKeyId` joins close it; scan for `\.key\b` reads post-migration.

## Code Examples

```js
// token generation + keyed hash (node:crypto only, Node >=22.5)
import { randomBytes, createHmac, hkdfSync } from "node:crypto";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const raw =
  "th_" +
  Buffer.from(randomBytes(24))
    .map((b) => BASE62[b % 62])
    .join("");
const hashKey = Buffer.from(hkdfSync("sha256", masterKey, "", "tokenhop/api-key-hash", 32));
const keyHash = createHmac("sha256", hashKey).update(raw, "utf8").digest("hex");
const prefix = raw.slice(0, 7) + "…" + raw.slice(-4);
```

```js
// validation: same shape as today's exact-match query, no timingSafeEqual needed
const h = createHmac("sha256", hashKey).update(presented, "utf8").digest("hex");
const row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ? AND isActive = 1`, [h]);
if (!row || (row.expiresAt && Date.now() > Date.parse(row.expiresAt))) return null;
```

```js
// safe master-key file creation (wx + 0600, mirrors sqljsAdapter.js:35 pattern)
import fs from "node:fs";
fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
const fd = fs.openSync(masterPath, "wx", 0o600);
try {
  fs.writeSync(fd, randomBytes(32));
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
```

## Open Questions

1. `budgetId` now vs later: issue scope says later, ADR-0005 reshape includes it — confirm nullable-now decision with tech-designer (no enforcement until YAN-372).
2. `hashKid` initial value + old-kid retention policy: single `kid=1` at introduction, or versioned from day one for YAN-377 `keys rotate`?
3. MITM credential scoping: issue scope says "references a service key" but ADR-0005 says dedicated settings credential, never an `apiKeys` row — ADR wins per spec §1, confirm with business-analyzer.
4. `local-no-key` → owner+Default mapping vs refuse when `multiUserActive`: exact `requireApiKey=false` matrix owned by YAN-355/YAN-368 — external lane assumes principal-hook contract, no independent proposal.
