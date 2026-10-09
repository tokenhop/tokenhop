// YAN-375 workspace transfer validation helpers: strict import payload shape,
// in-workspace conflict detection and reference remapping. Split out of
// ../workspaceTransfer.js so the transfer core stays small; nothing here
// mutates the database.
import { latestVersion } from "../migrations/index.js";
import { parseJson } from "./jsonCol.js";

export const WORKSPACE_EXPORT_TYPE = "tokenhop.workspaceExport";
export const WORKSPACE_EXPORT_VERSION = 1;
const MAX_PASSPHRASE_BYTES = 1024;
const MAX_ROWS = 10000;
const MAX_KV_ENTRIES = 10000;
export const KV_SCOPES = ["modelAliases", "customModels", "disabledModels"];

export function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

export function invalidFormat(message) {
  return fail("TRANSFER_FORMAT_INVALID", `Workspace snapshot is invalid: ${message}`);
}

export function requirePassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    fail("PASSPHRASE_REQUIRED", "A passphrase is required");
  }
  if (Buffer.byteLength(passphrase, "utf8") > MAX_PASSPHRASE_BYTES) {
    fail("PASSPHRASE_REQUIRED", "Passphrase is too long");
  }
  return passphrase;
}

// ─── scoped kv read (mirrors makeKv's `ws:<id>/` prefix) ───────────────────

export function readKvScope(db, scope, workspaceId) {
  const prefix = `ws:${workspaceId}/`;
  return db
    .all(`SELECT key, value FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
      scope,
      prefix.length,
      prefix,
    ])
    .map((r) => [r.key.slice(prefix.length), r.value]);
}

// ─── import: strict payload shape ─────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, max, context) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalidFormat(`${context} must be a non-empty string of at most ${max} chars`);
  }
  return value;
}

export function parseImportPayload(payload) {
  if (!isPlainObject(payload)) invalidFormat("payload must be an object");
  if (payload.type !== WORKSPACE_EXPORT_TYPE || payload.version !== WORKSPACE_EXPORT_VERSION) {
    invalidFormat("unsupported snapshot type or version");
  }
  const schemaVersion = payload.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > latestVersion()) {
    invalidFormat("unsupported schema version");
  }
  if (!isPlainObject(payload.sourceWorkspace)) invalidFormat("sourceWorkspace is missing");
  if (!isPlainObject(payload.kdf) || payload.kdf.alg !== "scrypt") {
    invalidFormat("kdf parameters are missing");
  }
  if (!isPlainObject(payload.wrappedDek)) invalidFormat("wrappedDek is missing");
  for (const field of ["connections", "nodes", "combos"]) {
    if (!Array.isArray(payload[field]) || payload[field].length > MAX_ROWS) {
      invalidFormat(`${field} must be an array of at most ${MAX_ROWS} entries`);
    }
  }
  if (!isPlainObject(payload.kv)) invalidFormat("kv section is missing");
  if (!isPlainObject(payload.preferences)) invalidFormat("preferences section is missing");

  const connections = payload.connections.map((c, i) => {
    if (!isPlainObject(c)) invalidFormat(`connections[${i}] must be an object`);
    boundedString(c.sourceId, 128, `connections[${i}].sourceId`);
    boundedString(c.provider, 256, `connections[${i}].provider`);
    boundedString(c.authType || "oauth", 64, `connections[${i}].authType`);
    if (!isPlainObject(c.data)) invalidFormat(`connections[${i}].data must be an object`);
    return c;
  });
  const nodes = payload.nodes.map((n, i) => {
    if (!isPlainObject(n)) invalidFormat(`nodes[${i}] must be an object`);
    boundedString(n.sourceId, 128, `nodes[${i}].sourceId`);
    if (!isPlainObject(n.data)) invalidFormat(`nodes[${i}].data must be an object`);
    return n;
  });
  const combos = payload.combos.map((c, i) => {
    if (!isPlainObject(c)) invalidFormat(`combos[${i}] must be an object`);
    boundedString(c.sourceId, 128, `combos[${i}].sourceId`);
    boundedString(c.name, 256, `combos[${i}].name`);
    if (!Array.isArray(c.models)) invalidFormat(`combos[${i}].models must be an array`);
    return c;
  });
  const kv = {};
  for (const scope of KV_SCOPES) {
    const section = payload.kv[scope];
    if (section === undefined || section === null) {
      kv[scope] = {};
      continue;
    }
    if (!isPlainObject(section)) invalidFormat(`kv.${scope} must be an object`);
    if (Object.keys(section).length > MAX_KV_ENTRIES) {
      invalidFormat(`kv.${scope} exceeds ${MAX_KV_ENTRIES} entries`);
    }
    if (scope === "customModels") {
      const models = {};
      for (const [key, value] of Object.entries(section)) {
        boundedString(key, 512, `kv.customModels key`);
        if (!isPlainObject(value)) invalidFormat(`kv.customModels["${key}"] must be an object`);
        models[key] = value;
      }
      kv[scope] = models;
    } else {
      const out = {};
      for (const [key, value] of Object.entries(section)) {
        boundedString(key, 512, `kv.${scope} key`);
        if (scope === "disabledModels" && !Array.isArray(value)) {
          invalidFormat(`kv.disabledModels["${key}"] must be an array`);
        }
        out[key] = value;
      }
      kv[scope] = out;
    }
  }
  return { connections, nodes, combos, kv, preferences: payload.preferences };
}

// ─── import: conflicts (refuse atomically, no merge) ──────────────────────

/** Connection identity for conflict listing: provider + name, else email. */
function connectionLabel(c) {
  return c.name ? `${c.provider}/${c.name}` : `${c.provider}/${c.email ?? "(unnamed)"}`;
}

/** Throw TRANSFER_CONFLICT when any incoming entry clashes with this workspace. */
export function assertNoImportConflicts(db, workspaceId, sections) {
  const conflicts = [];
  const conflict = (label) => {
    if (conflicts.length < 64) conflicts.push(label);
  };

  const seenCombos = new Set();
  // Combo name conflicts (per-workspace UNIQUE).
  for (const c of sections.combos) {
    if (seenCombos.has(c.name)) conflict(`combo:${c.name}`);
    seenCombos.add(c.name);
    if (
      db.get(`SELECT 1 AS x FROM combos WHERE name = ? AND workspaceId = ?`, [c.name, workspaceId])
    ) {
      conflict(`combo:${c.name}`);
    }
  }
  // Connection conflicts: same provider + name (apikey rows) or provider +
  // email (oauth rows), matching the repo dedup keys. No merge, ever.
  const seenConnections = new Set();
  for (const c of sections.connections) {
    const identity =
      typeof c.name === "string" && c.name
        ? `${c.provider}\u0000name\u0000${c.name}`
        : typeof c.email === "string" && c.email
          ? `${c.provider}\u0000email\u0000${c.email}`
          : null;
    if (identity && seenConnections.has(identity)) conflict(`connection:${connectionLabel(c)}`);
    if (identity) seenConnections.add(identity);
    let row = null;
    if (typeof c.name === "string" && c.name) {
      row = db.get(
        `SELECT 1 AS x FROM providerConnections WHERE provider = ? AND workspaceId = ? AND name = ?`,
        [c.provider, workspaceId, c.name],
      );
    }
    if (!row && typeof c.email === "string" && c.email) {
      row = db.get(
        `SELECT 1 AS x FROM providerConnections WHERE provider = ? AND workspaceId = ? AND email = ?`,
        [c.provider, workspaceId, c.email],
      );
    }
    if (row) conflict(`connection:${connectionLabel(c)}`);
  }
  // Node prefix conflicts (unique per workspace by repo contract).
  const existingPrefixes = new Set(
    db
      .all(`SELECT data FROM providerNodes WHERE workspaceId = ?`, [workspaceId])
      .map((r) => parseJson(r.data, {}).prefix),
  );
  const seenPrefixes = new Set();
  for (const n of sections.nodes) {
    const prefix = n.data.prefix;
    if (typeof prefix === "string" && prefix && seenPrefixes.has(prefix)) {
      conflict(`node:${prefix}`);
    }
    if (typeof prefix === "string" && prefix) seenPrefixes.add(prefix);
    if (typeof prefix === "string" && prefix && existingPrefixes.has(prefix)) {
      conflict(`node:${prefix}`);
    }
  }
  // kv key conflicts (this workspace's scoped rows only).
  for (const scope of KV_SCOPES) {
    const existing = new Set(readKvScope(db, scope, workspaceId).map(([k]) => k));
    const incoming = Object.keys(sections.kv[scope]);
    const seenKeys = new Set();
    for (const key of incoming) {
      if (seenKeys.has(key)) conflict(`kv:${scope}/${key}`);
      seenKeys.add(key);
      if (existing.has(key)) conflict(`kv:${scope}/${key}`);
    }
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 16).join(", ");
    fail(
      "TRANSFER_CONFLICT",
      `Import would conflict with existing entries in this workspace: ${shown}${conflicts.length > 16 ? " …" : ""}`,
      { conflicts },
    );
  }
}

// ─── import: reference remapping onto freshly minted ids ──────────────────

/** Remappers over the live `nodeIdMap` (source node id → new node id). */
export function createImportRemappers(nodeIdMap) {
  const remapProvider = (provider) =>
    typeof provider === "string" ? (nodeIdMap.get(provider) ?? provider) : provider;
  const remapModel = (model) => {
    if (typeof model !== "string") return model;
    const split = model.indexOf("/");
    return split < 0 ? model : `${remapProvider(model.slice(0, split))}${model.slice(split)}`;
  };
  const remapKvEntry = (scope, key, value) => {
    if (scope === "modelAliases") return [key, remapModel(value)];
    if (scope === "disabledModels") return [remapProvider(key), value];
    if (scope === "customModels") {
      const split = key.indexOf("|");
      const nextKey = split < 0 ? key : `${remapProvider(key.slice(0, split))}${key.slice(split)}`;
      return [
        nextKey,
        isPlainObject(value) && typeof value.providerAlias === "string"
          ? { ...value, providerAlias: remapProvider(value.providerAlias) }
          : value,
      ];
    }
    return [key, value];
  };
  return { remapProvider, remapModel, remapKvEntry };
}

/** Re-key combo strategies to the new combo ids; unknown combos are dropped. */
export function remapComboStrategies(prefs, comboIdMap) {
  if (prefs.comboStrategies && isPlainObject(prefs.comboStrategies)) {
    const remapped = {};
    for (const [key, value] of Object.entries(prefs.comboStrategies)) {
      const next = comboIdMap.get(key);
      if (next) remapped[next] = value;
    }
    prefs.comboStrategies = remapped;
  }
}
