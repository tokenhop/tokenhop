import fs from "node:fs";
import path from "node:path";
import { LEGACY_FILES, DB_DIR } from "./paths.js";
import { TABLES, HASHED_API_KEYS_TABLE, buildCreateTableSql } from "./schema.js";
import { readApiKeyStorageState } from "./apiKeyState.js";
import { readCredentialEncryptionState } from "./credentialEncryptionState.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import { makeBackupDir, backupFile, backupDbLite, pruneOldBackups } from "./backup.js";
import { getAppVersion } from "./version.js";
import { stringifyJson } from "./helpers/jsonCol.js";
import { rebuildRollupFromHistoryUnscoped } from "./repos/usageRollupRepo.js";

// Marker file: prevents re-importing legacy JSON when user wipes data.sqlite.
const MIGRATED_MARKER = path.join(DB_DIR, ".migrated-from-json");

// Track per-adapter so reusing same adapter skips re-run, but new adapter (after reset) re-runs.
const _migratedAdapters = new WeakSet();

// Thrown when row-count assertion fails. Outer transaction rolls back,
// legacy db.json kept intact, marker not written → next boot retries.
export class MigrationAborted extends Error {
  constructor(message, droppedRows) {
    super(message);
    this.name = "MigrationAborted";
    this.droppedRows = droppedRows;
  }
}

// Keep the first row per id and per UNIQUE column. INSERT OR REPLACE would
// otherwise silently delete the earlier row and trip the row-count assertion.
function dedupeRows(rows, uniqueCols, rowMeta, skipped) {
  const seen = Object.fromEntries(uniqueCols.map((c) => [c, new Set()]));
  return rows.filter((row) => {
    const dup = uniqueCols.find((c) => row?.[c] != null && seen[c].has(row[c]));
    if (dup) {
      skipped.push({ ...rowMeta(row), reason: `duplicate ${dup}` });
      return false;
    }
    for (const c of uniqueCols) if (row?.[c] != null) seen[c].add(row[c]);
    return true;
  });
}

// Insert rows one-by-one, collect failures, then assert COUNT(*) matches the
// deduped input length.
function importWithAssertion(adapter, tableName, allRows, insertFn, rowMeta, uniqueCols = ["id"]) {
  const skipped = [];
  const rows = dedupeRows(allRows, uniqueCols, rowMeta, skipped);
  if (skipped.length) {
    console.warn(`[DB][migrate] ${tableName}: skipped duplicate rows:`, skipped);
  }
  const dropped = [];
  for (const row of rows) {
    try {
      insertFn(row);
    } catch (err) {
      dropped.push({ ...rowMeta(row), reason: err.message });
    }
  }
  const inserted = adapter.get(`SELECT COUNT(*) as c FROM ${tableName}`)?.c ?? 0;
  if (inserted !== rows.length) {
    console.warn(
      `[DB][migrate] ${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}. Dropped:`,
      dropped,
    );
    throw new MigrationAborted(
      `${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}`,
      dropped,
    );
  }
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function isFreshDb(adapter) {
  // Table _meta may not exist yet on truly fresh DB
  try {
    const row = adapter.get(`SELECT COUNT(*) as c FROM _meta`);
    return !row || row.c === 0;
  } catch {
    return true;
  }
}

// Tables the legacy import fills. If the user already created data here (e.g.
// after an aborted import), importing would merge/overwrite it, so skip.
const LEGACY_ENTITY_TABLES = [
  "providerConnections",
  "providerNodes",
  "proxyPools",
  "apiKeys",
  "combos",
];

function legacyTablesEmpty(adapter) {
  return LEGACY_ENTITY_TABLES.every(
    (t) => (adapter.get(`SELECT COUNT(*) as c FROM ${t}`)?.c ?? 0) === 0,
  );
}

function storedSchemaVersion(adapter) {
  return parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0;
}

// True when the DB holds anything besides _meta: an existing install, including
// a legacy unstamped one (schemaVersion 0), as opposed to a brand-new file.
function hasUserTables(adapter) {
  return !!adapter.get(
    `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_meta'`,
  );
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
// Each migration runs in its own transaction with its version stamp, so a
// failure rolls back both. Foreign keys are off around it (SQLite ignores the
// PRAGMA inside a transaction) so a table rebuild's DROP can't cascade, and
// `foreign_key_check` must pass before the commit.
export function runVersionedMigrations(adapter, migrations = MIGRATIONS) {
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  const current = storedSchemaVersion(adapter);
  const pending = migrations.filter((m) => m.version > current);
  let lastApplied = current;
  for (const m of pending) {
    adapter.exec("PRAGMA foreign_keys = OFF");
    try {
      if (adapter.get("PRAGMA foreign_keys").foreign_keys !== 0) {
        throw new Error(
          `migration #${m.version}: run outside a transaction (foreign_keys stuck ON)`,
        );
      }
      adapter.transaction(() => {
        m.up(adapter);
        const violations = adapter.all("PRAGMA foreign_key_check");
        if (violations.length) {
          throw new Error(`migration #${m.version}: ${violations.length} foreign key violation(s)`);
        }
        setMetaSync(adapter, "schemaVersion", m.version);
      });
    } finally {
      adapter.exec("PRAGMA foreign_keys = ON");
    }
    lastApplied = m.version;
    console.log(`[DB][migrate] applied #${m.version} ${m.name}`);
  }
  return { applied: pending.length, from: current, to: lastApplied };
}

// ─── Auto-sync (additive only): add missing tables/columns/indexes ───────
// YAN-363: once the switch-on activation stamps _meta.apiKeysHashedVersion,
// the live apiKeys table is the hashed shape (HASHED_API_KEYS_TABLE); the
// declarative TABLES.apiKeys stays the legacy raw-key definition for
// not-yet-activated DBs. Sync must follow the marker so reopening an
// activated DB never re-adds the raw `key` column or its index. The marker
// is authoritative, never the table shape; a malformed marker pair fails
// closed (readApiKeyStorageState throws) rather than guessing a definition.
function apiKeysDefinitionForSync(adapter) {
  const state = readApiKeyStorageState(adapter);
  return state.storage === "hashed" ? HASHED_API_KEYS_TABLE : TABLES.apiKeys;
}

function syncSchemaFromTables(adapter) {
  for (const [tableName, declaredDef] of Object.entries(TABLES)) {
    const def = tableName === "apiKeys" ? apiKeysDefinitionForSync(adapter) : declaredDef;
    // Create table if absent
    adapter.exec(buildCreateTableSql(tableName, def));

    // Diff columns
    const existing = adapter.all(`PRAGMA table_info(${tableName})`);
    const existingNames = new Set(existing.map((r) => r.name));
    for (const [colName, colDef] of Object.entries(def.columns)) {
      if (!existingNames.has(colName)) {
        // SQLite ADD COLUMN restrictions: no PRIMARY KEY / UNIQUE w/o NULL ok.
        // We strip PRIMARY KEY / UNIQUE since those are only valid at create time.
        const safeDef = colDef
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .trim();
        try {
          adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`);
          console.log(`[DB][sync] +column ${tableName}.${colName}`);
        } catch (e) {
          console.warn(`[DB][sync] add column ${tableName}.${colName} failed: ${e.message}`);
        }
      }
    }

    // Indexes (idempotent)
    for (const idx of def.indexes || []) {
      try {
        adapter.exec(idx);
      } catch {}
    }
  }
}

// ─── Legacy JSON import (one-time) ───────────────────────────────────────
function importLegacyMain(adapter, data) {
  if (!data || typeof data !== "object") return;

  if (data.settings) {
    adapter.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(data.settings)],
    );
  }

  importWithAssertion(
    adapter,
    "providerConnections",
    data.providerConnections || [],
    (c) => {
      const {
        id,
        provider,
        authType,
        name,
        email,
        priority,
        isActive,
        createdAt,
        updatedAt,
        ...rest
      } = c;
      adapter.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          provider,
          authType || "oauth",
          name || null,
          email || null,
          priority || null,
          isActive === false ? 0 : 1,
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    },
    (c) => ({ id: c.id ?? null, provider: c.provider ?? null, name: c.name ?? null }),
  );

  importWithAssertion(
    adapter,
    "providerNodes",
    data.providerNodes || [],
    (n) => {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      adapter.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          id,
          type || null,
          name || null,
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    },
    (n) => ({ id: n.id ?? null, type: n.type ?? null, name: n.name ?? null }),
  );

  importWithAssertion(
    adapter,
    "proxyPools",
    data.proxyPools || [],
    (p) => {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      adapter.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          id,
          isActive === false ? 0 : 1,
          testStatus || "unknown",
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    },
    (p) => ({ id: p.id ?? null }),
  );

  importWithAssertion(
    adapter,
    "apiKeys",
    data.apiKeys || [],
    (k) => {
      adapter.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          k.id,
          k.key,
          k.name || null,
          k.machineId || null,
          k.isActive === false ? 0 : 1,
          k.createdAt || new Date().toISOString(),
        ],
      );
    },
    (k) => ({ id: k.id ?? null, name: k.name ?? null }),
    ["id", "key"],
  );

  importWithAssertion(
    adapter,
    "combos",
    data.combos || [],
    (c) => {
      adapter.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.name,
          c.kind || null,
          stringifyJson(c.models || []),
          c.createdAt || new Date().toISOString(),
          c.updatedAt || new Date().toISOString(),
        ],
      );
    },
    (c) => ({ id: c.id ?? null, name: c.name ?? null }),
    ["id", "name"],
  );

  for (const [alias, model] of Object.entries(data.modelAliases || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
      alias,
      stringifyJson(model),
    ]);
  }
  for (const m of data.customModels || []) {
    const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [
      k,
      stringifyJson(m),
    ]);
  }
  for (const [tool, mappings] of Object.entries(data.mitmAlias || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [
      tool,
      stringifyJson(mappings || {}),
    ]);
  }
  for (const [provider, models] of Object.entries(data.pricing || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [
      provider,
      stringifyJson(models || {}),
    ]);
  }
}

function importLegacyUsage(adapter, data) {
  if (!data || typeof data !== "object") return;
  for (const e of data.history || []) {
    const t = e.tokens || {};
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.timestamp || new Date().toISOString(),
        e.provider || null,
        e.model || null,
        e.connectionId || null,
        e.apiKey || null,
        e.endpoint || null,
        t.prompt_tokens || t.input_tokens || 0,
        t.completion_tokens || t.output_tokens || 0,
        e.cost || 0,
        e.status || "ok",
        stringifyJson(t),
        stringifyJson({}),
      ],
    );
  }
  // YAN-370: the daily rollup is rebuilt from the imported history rows (the
  // legacy dailySummary blob's marginal buckets can't be decomposed).
  rebuildRollupFromHistoryUnscoped(adapter);
  if (typeof data.totalRequestsLifetime === "number") {
    setMetaSync(adapter, "totalRequestsLifetime", data.totalRequestsLifetime);
  }
}

function importLegacyDisabled(adapter, data) {
  if (!data || typeof data.disabled !== "object") return;
  for (const [provider, ids] of Object.entries(data.disabled)) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [
      provider,
      stringifyJson(ids || []),
    ]);
  }
}

function importLegacyDetails(adapter, data) {
  if (!data || !Array.isArray(data.records)) return;
  for (const r of data.records) {
    adapter.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.timestamp || new Date().toISOString(),
        r.provider || null,
        r.model || null,
        r.connectionId || null,
        r.status || null,
        stringifyJson(r),
      ],
    );
  }
}

// YAN-365: B3 blocker — on established credential encryption the legacy
// JSON importer would write plaintext into ciphertext storage and drop
// `workspaceId`. Reject ANY legacy payload once the marker latches (or the
// state is ambiguous), before any backup or wipe.
function assertLegacyImportCredentialGuard(adapter) {
  let encrypted = false;
  try {
    encrypted = readCredentialEncryptionState(adapter, { strict: true }).storage === "encrypted";
  } catch {
    encrypted = true; // half/corrupt marker: fail closed, no legacy import
  }
  if (encrypted) {
    throw Object.assign(
      new Error(
        "[DB][migrate] legacy JSON import is refused on encrypted storage; restore a v3 snapshot with the matching root",
      ),
      { code: "ENCRYPTION_LEGACY_IMPORT_REJECTED" },
    );
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────
export async function runMigrationOnce(adapter) {
  if (_migratedAdapters.has(adapter)) return;
  await migrateAdapterOnce(adapter);
  _migratedAdapters.add(adapter);
}

async function migrateAdapterOnce(adapter) {
  // Capture freshness BEFORE migrations stamp _meta (otherwise we'd misclassify
  // a brand-new DB as non-fresh once schemaVersion is written).
  const fresh = isFreshDb(adapter);

  // Prune stale backups every boot so old oversized backups shrink to KEEP.
  pruneOldBackups();

  // Bootstrap _meta so we can read the stored schema version below
  // (runVersionedMigrations also ensures this, but we need it earlier here).
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  // Back up an existing DB before ANY pending migration touches it.
  const from = storedSchemaVersion(adapter);
  const to = latestVersion();
  if (from < to && hasUserTables(adapter)) {
    try {
      const backupDir = makeBackupDir(`schema-${from}-to-${to}`);
      backupDbLite(adapter, backupDir);
      pruneOldBackups();
      console.log(`[DB][migrate] pre-migration backup ${from} → ${to}: ${backupDir}`);
    } catch (e) {
      console.warn(`[DB][migrate] pre-migration backup failed (continuing): ${e.message}`);
    }
  }

  // 1. Always run versioned migrations chain (skip-version safe)
  runVersionedMigrations(adapter);

  // 2. Additive sync (auto add missing columns/indexes declared in TABLES)
  syncSchemaFromTables(adapter);

  // 3. One-time legacy JSON import. Gated on "never imported + entity tables
  // empty" rather than "fresh on entry": schemaVersion is stamped above, outside
  // the import transaction, so an aborted import must still retry next boot.
  const alreadyImported =
    fs.existsSync(MIGRATED_MARKER) || !!getMetaSync(adapter, "migratedAt", null);
  const legacyMain = readJsonSafe(LEGACY_FILES.main);
  const legacyUsage = readJsonSafe(LEGACY_FILES.usage);
  const legacyDisabled = readJsonSafe(LEGACY_FILES.disabled);
  const legacyDetails = readJsonSafe(LEGACY_FILES.details);
  const hasLegacy = !!(legacyMain || legacyUsage || legacyDisabled || legacyDetails);

  const storageHashed = readApiKeyStorageState(adapter).storage === "hashed";
  if (hasLegacy && !storageHashed && !alreadyImported && legacyTablesEmpty(adapter)) {
    assertLegacyImportCredentialGuard(adapter);
    const t0 = Date.now();
    const backupDir = makeBackupDir("migrate-from-json");
    for (const f of Object.values(LEGACY_FILES)) backupFile(f, backupDir);
    // Retry after an earlier abort: settings/kv the user edited since then get
    // overwritten by the import, so keep a copy of the current DB too.
    if (!fresh) backupDbLite(adapter, backupDir);

    try {
      adapter.transaction(() => {
        importLegacyMain(adapter, legacyMain);
        importLegacyUsage(adapter, legacyUsage);
        importLegacyDisabled(adapter, legacyDisabled);
        importLegacyDetails(adapter, legacyDetails);
        setMetaSync(adapter, "appVersion", getAppVersion());
        setMetaSync(adapter, "migratedAt", new Date().toISOString());
      });
    } catch (err) {
      if (err instanceof MigrationAborted) {
        console.error(
          `[DB][migrate] aborted: ${err.message} | legacy JSON kept | backup: ${backupDir}`,
        );
        return;
      }
      throw err;
    }

    try {
      fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString());
    } catch {}
    pruneOldBackups();
    console.log(
      `[DB][migrate] JSON → SQLite in ${Date.now() - t0}ms | legacy JSON kept at DATA_DIR | backup: ${backupDir}`,
    );
    return;
  }

  // Track app version for informational purposes only. App version bumps no
  // longer trigger a DB backup — only pending migrations do.
  const newVer = getAppVersion();
  const oldVer = getMetaSync(adapter, "appVersion", null);
  if (oldVer !== newVer) setMetaSync(adapter, "appVersion", newVer);
}
