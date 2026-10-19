// Legacy (non-hashed) snapshot apply: the body of the destructive import
// transaction, moved verbatim from the db barrel. Runs inside the caller's
// db.transaction, after assertStateCurrent().
import { stringifyJson } from "../helpers/jsonCol.js";
import { adoptOwnerlessRowsUnscoped } from "../repos/ownership.js";
import {
  encodeLegacyCredentialRows,
  insertLegacyEncryptedRowsSync,
} from "../helpers/legacyEncryptedImport.js";
import {
  insertLegacyKeysHashedSync,
  preserveLocalVerifierSettings,
} from "../helpers/gatewayKeyTransfer.js";
import { stripWsKey } from "./legacyKeys.js";

export function applyLegacySnapshotSync(
  db,
  payload,
  { legacyEncrypted, resolvedMaster, plan, instance },
) {
  // Host-local MITM verifier: read the live row BEFORE the wipe below.
  const restoredSettings = preserveLocalVerifierSettings(
    db,
    payload.settings ? { ...payload.settings } : undefined,
  );
  const encrypted = legacyEncrypted
    ? encodeLegacyCredentialRows(db, payload, restoredSettings, resolvedMaster, plan)
    : null;
  // Wipe all tables (keep _meta)
  db.run(`DELETE FROM settings`);
  db.run(`DELETE FROM providerConnections`);
  db.run(`DELETE FROM providerNodes`);
  db.run(`DELETE FROM proxyPools`);
  db.run(`DELETE FROM apiKeys`);
  db.run(`DELETE FROM combos`);
  db.run(
    `DELETE FROM kv WHERE scope IN ('modelAliases', 'disabledModels', 'customModels', 'mitmAlias', 'cliToolSettings', 'cliToolPresets', 'pricing')`,
  );

  // Settings: full destructive replace except the host-local MITM verifier
  // hash — a live local verifier (running child custody) survives and any
  // imported one is dropped, so no imported value can ever become the
  // runtime verifier.
  if (restoredSettings !== undefined) {
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [encrypted ? encrypted.settings : stringifyJson(restoredSettings)],
    );
  }

  if (encrypted) insertLegacyEncryptedRowsSync(db, encrypted);
  for (const c of encrypted ? [] : payload.providerConnections || []) {
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
      workspaceId: _ws,
      createdByUserId: _by,
      ...rest
    } = c;
    db.run(
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
  }
  for (const n of encrypted ? [] : payload.providerNodes || []) {
    const {
      id,
      type,
      name,
      createdAt,
      updatedAt,
      workspaceId: _ws,
      createdByUserId: _by,
      ...rest
    } = n;
    db.run(
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
  }
  for (const p of payload.proxyPools || []) {
    const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
    db.run(
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
  }
  // Legacy storage keeps the byte-identical raw-key import. A hashed
  // instance never receives a plaintext row: keys are HMAC'd into hashed
  // rows (Default workspace, legacy=1) and cliToolPresets are converted to
  // apiKeyId references after the generic loops wrote them.
  if (instance.storage === "legacy") {
    for (const k of payload.apiKeys || []) {
      db.run(
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
    }
  }
  for (const c of payload.combos || []) {
    db.run(
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
  }
  // Keys from newer workspace-aware snapshots lose their `ws:<id>/` prefix
  // so they land bare and are adopted into the local Default workspace.
  for (const [a, m] of Object.entries(payload.modelAliases || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
      stripWsKey(a),
      stringifyJson(m),
    ]);
  }
  for (const [provider, ids] of Object.entries(payload.disabledModels || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [
      stripWsKey(provider),
      stringifyJson(ids),
    ]);
  }
  for (const m of payload.customModels || []) {
    const k = stripWsKey(`${m.providerAlias}|${m.id}|${m.type || "llm"}`);
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [
      k,
      stringifyJson(m),
    ]);
  }
  for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [
      tool,
      stringifyJson(mappings || {}),
    ]);
  }
  for (const [tool, settings] of Object.entries(payload.cliToolSettings || {})) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolSettings', ?, ?)`, [
      tool,
      stringifyJson(settings || {}),
    ]);
  }
  for (const [kind, items] of Object.entries(payload.cliToolPresets || {})) {
    if (!["endpoints", "apiKeys"].includes(kind) || !Array.isArray(items)) continue;
    // Hashed instances never accept the raw apiKeys preset kind — converted
    // apiKeyId rows are written by insertLegacyKeysHashedSync instead, so
    // no plaintext ever reaches a table page or WAL frame.
    if (kind === "apiKeys" && instance.storage === "hashed") continue;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolPresets', ?, ?)`, [
      kind,
      stringifyJson(items),
    ]);
  }
  for (const [provider, models] of Object.entries(payload.pricing || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [
      provider,
      stringifyJson(models || {}),
    ]);
  }
  // YAN-361: imported connections and nodes belong to Default (no-op before bootstrap).
  adoptOwnerlessRowsUnscoped(db);

  if (instance.storage === "hashed") insertLegacyKeysHashedSync(db, payload, plan);
}
