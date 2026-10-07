// INERT: no registration or runtime activation. Caller must quiesce writers,
// verify owner/Default, complete a protected backup, and vet other credential
// sinks (including cliToolSettings/browser presets) before calling this core.
// Caller must persist/flush with throwing durability semantics before exposing
// hashed mode, then invalidate caches. Transaction commit is NOT disk durability
// or forensic erasure; protected backups/WAL/free pages may still contain raws.
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "../schema.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { insertHashedApiKeySync } from "../repos/apiKeysRepo.js";
import { convertUsageDailyKeys, normalizeUsageKeyEntry } from "../helpers/usageKeyIdentity.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "../../security/masterKey.js";
import { apiKeyPrefix } from "../../../shared/utils/apiKey.js";
import { tableExists } from "./helpers.js";

function fail(code, message) {
  throw Object.assign(new Error(`[gateway-key-migration] ${message}`), { code });
}

function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    fail("API_KEY_MIGRATION_JSON_INVALID", "Invalid stored JSON; values withheld");
  }
}

/**
 * Synchronous, adapter-passed atomic transform. No backup or flush is performed.
 * backup: { completed: true, db } is a TRUSTED CALLER attestation bound to this
 * adapter, not proof of filesystem durability. Do not accept from request JSON.
 * masterKey: Buffer32; optional hashKey must equal its HKDF derivation;
 * expectedKid: optional expected master fingerprint; defaultWorkspaceId: vetted
 * Default workspace. Raw client keys remain valid under their original IDs.
 *
 * cliToolPresets/apiKeys stores [{ name, key, ... }], with no provenance.
 * Exact live-key matches become { ...metadata, apiKeyId } (raw key removed).
 * Every unmatched entry is ambiguous by default, NEVER inferred from shape.
 * Optional synchronous classifyPreset({ index, item }) must return 'external'
 * ONLY after caller vets provenance; those credentials remain byte-for-byte.
 * All other returns/throws stop with secret-free error before mutation.
 * Callback is read-only/trusted; no adapter supplied, no SQL/apply callbacks.
 * Other CLI settings are explicitly outside this bounded core's write set.
 */
export function hashGatewayKeysSync(
  db,
  {
    masterKey,
    hashKey = null,
    expectedKid = null,
    defaultWorkspaceId,
    backup,
    classifyPreset = null,
  } = {},
) {
  if (backup?.completed !== true || backup.db !== db) {
    fail("API_KEY_MIGRATION_BACKUP_REQUIRED", "Completed protected backup attestation required");
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    fail("API_KEY_MIGRATION_MASTER_KEY_INVALID", "masterKey must be a 32-byte Buffer");
  }
  const derived = deriveApiKeyHashKey(masterKey);
  const kid = masterKeyId(masterKey);
  if (hashKey !== null && (!Buffer.isBuffer(hashKey) || !derived.equals(hashKey))) {
    fail("API_KEY_MIGRATION_KID_MISMATCH", "Hash key does not match master");
  }
  if (expectedKid !== null && expectedKid !== kid) {
    fail("API_KEY_MIGRATION_KID_MISMATCH", "Master key does not match expected kid");
  }
  const context = { hashKey: derived, keyIdByHash: new Map() };
  let result;
  db.transaction(() => {
    const state = readApiKeyStorageState(db);
    const columns = db.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
    if (state.storage === "hashed") {
      if (state.hashKid !== kid) fail("API_KEY_MIGRATION_KID_MISMATCH", "Durable kid mismatch");
      if (
        columns.includes("key") ||
        columns.length !== Object.keys(HASHED_API_KEYS_TABLE.columns).length ||
        Object.keys(HASHED_API_KEYS_TABLE.columns).some((c) => !columns.includes(c)) ||
        db.get(
          "SELECT 1 AS invalid FROM apiKeys WHERE hashKid != ? OR keyHash IS NULL OR length(keyHash) != 64 OR keyHash GLOB '*[^0-9a-f]*' LIMIT 1",
          [kid],
        )
      ) {
        fail("API_KEY_STATE_INVALID", "Hashed schema or row state invalid");
      }
      if (db.all("PRAGMA foreign_key_check").length)
        fail("API_KEY_STATE_INVALID", "Foreign key violations");
      result = { alreadyMigrated: true, hashKid: kid };
      return;
    }
    if (!columns.includes("key") || columns.includes("keyHash")) {
      fail("API_KEY_STATE_INVALID", "Legacy marker/schema mismatch");
    }
    if (
      typeof defaultWorkspaceId !== "string" ||
      !db.get("SELECT id FROM workspaces WHERE id = ?", [defaultWorkspaceId])
    ) {
      fail("API_KEY_MIGRATION_WORKSPACE_MISSING", "Vetted Default workspace required");
    }
    // Incoming key FKs need a separately reviewed retention/rebuild contract.
    // Stop rather than let DROP TABLE cascade history or rewrite references.
    for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const quoted = name.replaceAll('"', '""');
      if (db.all(`PRAGMA foreign_key_list("${quoted}")`).some((fk) => fk.table === "apiKeys")) {
        fail(
          "API_KEY_MIGRATION_FK_UNSUPPORTED",
          "Incoming apiKeys foreign key requires retention review",
        );
      }
    }
    if (db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'apiKeys_hash_stage'")) {
      fail("API_KEY_STATE_INVALID", "Migration staging table already exists");
    }
    const keys = db.all("SELECT * FROM apiKeys");
    for (const row of keys) context.keyIdByHash.set(hashApiKey(row.key, derived), row.id);
    const presetRow = db.get(
      "SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = 'apiKeys'",
    );
    const presets = presetRow ? parse(presetRow.value) : [];
    if (!Array.isArray(presets)) fail("API_KEY_MIGRATION_PRESET_INVALID", "Preset array required");
    let convertedPresets = 0;
    const nextPresets = presets.map((item, index) => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.key !== "string" ||
        !item.key
      ) {
        fail(
          "API_KEY_MIGRATION_PRESET_INVALID",
          `Invalid preset at index ${index}; values withheld`,
        );
      }
      const id = context.keyIdByHash.get(hashApiKey(item.key, derived));
      if (id) {
        const { key: _raw, ...metadata } = item;
        convertedPresets++;
        return { ...metadata, apiKeyId: id };
      }
      let classification;
      try {
        classification = classifyPreset?.({ index, item: structuredClone(item) });
      } catch {
        // Caller errors may contain credentials; do not expose their text/cause.
      }
      if (classification !== "external") {
        fail(
          "API_KEY_MIGRATION_AMBIGUOUS_PRESET",
          `Ambiguous preset at index ${index}; values withheld`,
        );
      }
      return item;
    });
    const counts = Object.fromEntries(
      // YAN-370: usageDaily is gone after migration 014 (usageRollup holds ids).
      ["apiKeys", "usageHistory", "usageDaily"]
        .filter((t) => tableExists(db, t))
        .map((table) => [table, db.get(`SELECT COUNT(*) AS n FROM ${table}`).n]),
    );
    db.exec(buildCreateTableSql("apiKeys_hash_stage", HASHED_API_KEYS_TABLE));
    // Use reviewed strict row validator/inserter against staging table without
    // renaming live table (SQLite renames can retarget incoming FK references).
    const staging = {
      run: (sql, params) =>
        db.run(sql.replace("INSERT INTO apiKeys(", "INSERT INTO apiKeys_hash_stage("), params),
    };
    for (const row of keys) {
      insertHashedApiKeySync(staging, {
        id: row.id,
        workspaceId: defaultWorkspaceId,
        userId: null,
        createdByUserId: null,
        keyHash: hashApiKey(row.key, derived),
        hashKid: kid,
        prefix: apiKeyPrefix(row.key),
        name: row.name,
        machineId: row.machineId,
        legacy: 1,
        isActive: row.isActive,
        createdAt: row.createdAt,
      });
    }
    db.exec("DROP TABLE apiKeys; ALTER TABLE apiKeys_hash_stage RENAME TO apiKeys");
    for (const sql of HASHED_API_KEYS_TABLE.indexes) db.exec(sql);
    const history = db.all("SELECT id, apiKey, meta FROM usageHistory");
    for (const row of history) {
      const entry = normalizeUsageKeyEntry(
        { apiKey: row.apiKey },
        { storage: "hashed", ...context },
      );
      let meta = row.meta;
      if (meta !== null) {
        const parsed = parse(meta);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.hasOwn(parsed, "apiKey")
        ) {
          meta = JSON.stringify(normalizeUsageKeyEntry(parsed, { storage: "hashed", ...context }));
        }
      }
      // Per-row updates: raw values that look like another key's ID must not
      // be double-converted by sequential UPDATE ... WHERE apiKey = raw.
      db.run("UPDATE usageHistory SET apiKey = ?, meta = ? WHERE id = ?", [
        entry.apiKey,
        meta,
        row.id,
      ]);
    }
    const days = tableExists(db, "usageDaily")
      ? db.all("SELECT dateKey, data FROM usageDaily")
      : [];
    for (const row of days) {
      const day = convertUsageDailyKeys(parse(row.data), { sourceStorage: "legacy", ...context });
      // Real aggregateEntryToDay stores credential in bucket.meta.apiKey.
      // Reviewed helper covers dict/direct field; explicitly cover this slot,
      // without recursive credential replacement or touching provider secrets.
      for (const bucket of Object.values(day.byApiKey || {})) {
        if (bucket.meta && Object.hasOwn(bucket.meta, "apiKey")) {
          bucket.meta = normalizeUsageKeyEntry(bucket.meta, { storage: "hashed", ...context });
        }
      }
      db.run("UPDATE usageDaily SET data = ? WHERE dateKey = ?", [
        JSON.stringify(day),
        row.dateKey,
      ]);
    }
    if (presetRow)
      db.run("UPDATE kv SET value = ? WHERE scope = 'cliToolPresets' AND key = 'apiKeys'", [
        JSON.stringify(nextPresets),
      ]);
    for (const [table, before] of Object.entries(counts)) {
      if (db.get(`SELECT COUNT(*) AS n FROM ${table}`).n !== before)
        fail("API_KEY_MIGRATION_COUNT_MISMATCH", "Row count changed");
    }
    if (db.all("PRAGMA foreign_key_check").length)
      fail("API_KEY_MIGRATION_FK_VIOLATION", "Foreign key violations");
    db.run(
      "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
      [kid],
    );
    result = {
      alreadyMigrated: false,
      hashKid: kid,
      keysMigrated: keys.length,
      usageHistoryRowsUpdated: history.length,
      usageDailyDaysUpdated: days.length,
      presetsConverted: convertedPresets,
      presetsPreserved: presets.length - convertedPresets,
    };
  });
  return result;
}
