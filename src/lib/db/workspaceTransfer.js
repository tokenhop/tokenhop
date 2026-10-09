// YAN-375 workspace transfer core: passphrase-protected per-workspace export
// and import. Scope is exactly one workspace's owned rows (connections, nodes,
// combos, the three scoped kv maps, workspaceSettings overrides) — never
// users, memberships, grants, budgets, usage, audit or sibling workspaces.
//
// Secret leaves never travel plaintext: they are decrypted with the source
// workspace DEK (when the instance encrypts), re-sealed under a fresh random
// portable DEK at export AAD `ws-export-v1|<table>|<sourceId>|<field>`.
// Source IDs bind credentials before fresh IDs are minted; the portable DEK is
// wrapped by one scrypt(passphrase) key via passphraseWrap.js. Import
// authenticates EVERY leaf before any mutation, then inside one transaction
// mints new ids, remaps references, re-encrypts under the destination
// workspace DEK (or stores plaintext when the destination never encrypted,
// exactly like the repos) and refuses atomically on any name/key conflict.
// Payload validation, conflict listing and id remapping live in
// ./helpers/workspaceTransferValidation.js.
import { randomUUID } from "node:crypto";
import { getAdapter } from "./driver.js";
import { latestVersion } from "./migrations/index.js";
import { isMultiUserEnabled } from "../users/featureSwitch.js";
import { decodeCredentialRowSync, encodeCredentialRowSync } from "./helpers/credentialStorage.js";
import { prepareCredentialCtx, assertCredentialCtxCurrent } from "./repos/connectionsRepo.js";
import { pickKeys, WORKSPACE_KEYS } from "../settings/settingsScope.js";
import { parseJson, stringifyJson } from "./helpers/jsonCol.js";
import {
  unwrapWorkspaceExportDek,
  wrapWorkspaceExportDek,
} from "./helpers/workspaceTransferCrypto.js";
import {
  CREDENTIAL_FIELD_ALLOWLIST,
  encryptBytes,
  decryptBytes,
  isEnvelopeShape,
  randomKey,
  zeroBuffer,
} from "../security/envelope.js";
import {
  KV_SCOPES,
  WORKSPACE_EXPORT_TYPE,
  WORKSPACE_EXPORT_VERSION,
  assertNoImportConflicts,
  createImportRemappers,
  fail,
  invalidFormat,
  parseImportPayload,
  readKvScope,
  remapComboStrategies,
  requirePassphrase,
} from "./helpers/workspaceTransferValidation.js";

export { WORKSPACE_EXPORT_TYPE, WORKSPACE_EXPORT_VERSION };
const EXPORT_KID = "ws-export-v1";
const EXPORT_AAD = (table, sourceId, field) => `ws-export-v1|${table}|${sourceId}|${field}`;
const PSD_PREFIX = "providerSpecificData.";

/**
 * Core re-check of the route-level gates (defense in depth; the URL id is
 * authoritative). Multi-user must be on (switch-off reads as not-found, like
 * the route's hidden 404), the workspace must exist, the principal's
 * workspaceRoles map must claim owner AND the live membership row must agree.
 * @returns {{name:string, kind:string}} the workspace row
 */
async function authorizeWorkspace(ctx, workspaceId) {
  if (!(await isMultiUserEnabled())) fail("NOT_FOUND", "Workspace not found");
  if (!ctx || typeof ctx.userId !== "string" || typeof workspaceId !== "string") {
    fail("NOT_FOUND", "Workspace not found");
  }
  const db = await getAdapter();
  const row = db.get(
    `SELECT w.name, w.kind, m.role FROM workspaces w
     LEFT JOIN memberships m ON m.workspaceId = w.id AND m.userId = ?
     WHERE w.id = ?`,
    [ctx.userId, workspaceId],
  );
  if (!row) fail("NOT_FOUND", "Workspace not found");
  if (ctx.workspaceRoles?.[workspaceId] !== "owner" || row.role !== "owner") {
    fail("FORBIDDEN", "Only the workspace owner may transfer a workspace");
  }
  return { name: row.name, kind: row.kind };
}

// ─── credential leaf accessors (dotted psd paths, like credentialStorage) ──

function leafGet(obj, field) {
  if (field.startsWith(PSD_PREFIX)) {
    const psd = obj.providerSpecificData;
    if (!psd || typeof psd !== "object" || Array.isArray(psd)) return undefined;
    return psd[field.slice(PSD_PREFIX.length)];
  }
  return obj[field];
}

function leafSet(obj, field, value) {
  if (field.startsWith(PSD_PREFIX)) {
    obj.providerSpecificData = { ...(obj.providerSpecificData || {}) };
    obj.providerSpecificData[field.slice(PSD_PREFIX.length)] = value;
  } else {
    obj[field] = value;
  }
}

/** Seal every covered non-empty leaf of `blob` under the portable DEK. */
function sealLeaves(blob, table, sourceId, dek) {
  for (const field of CREDENTIAL_FIELD_ALLOWLIST[table]) {
    const leaf = leafGet(blob, field);
    if (typeof leaf !== "string" || leaf.length === 0) continue;
    leafSet(
      blob,
      field,
      encryptBytes(dek, EXPORT_KID, Buffer.from(leaf, "utf8"), EXPORT_AAD(table, sourceId, field)),
    );
  }
}

/**
 * Open every covered leaf of `blob` under the portable DEK. Every failure —
 * missing envelope, malformed envelope, failed authentication — is the same
 * generic TRANSFER_FORMAT_INVALID (no oracle).
 * @returns {object} the blob with plaintext leaves (strings)
 */
function openLeaves(blob, table, sourceId, dek, context) {
  for (const field of CREDENTIAL_FIELD_ALLOWLIST[table]) {
    const leaf = leafGet(blob, field);
    if (leaf === undefined || leaf === null || leaf === "") continue;
    if (!isEnvelopeShape(leaf)) invalidFormat(`${context} has an invalid credential envelope`);
    let plain;
    try {
      plain = decryptBytes(dek, leaf, EXPORT_AAD(table, sourceId, field));
    } catch {
      invalidFormat(`${context} has an invalid credential envelope`);
    }
    leafSet(blob, field, plain.toString("utf8"));
    zeroBuffer(plain);
  }
  return blob;
}

// ─── export ───────────────────────────────────────────────────────────────

function buildExportDoc(db, credCtx, workspaceId, source, portableDek) {
  const connections = db
    .all(`SELECT * FROM providerConnections WHERE workspaceId = ?`, [workspaceId])
    .map((row) => {
      const blob = decodeCredentialRowSync(db, row, credCtx, {
        table: "providerConnections",
        workspaceId,
      });
      sealLeaves(blob, "providerConnections", row.id, portableDek);
      return {
        sourceId: row.id,
        provider: row.provider,
        authType: row.authType,
        name: row.name ?? null,
        email: row.email ?? null,
        priority: row.priority ?? null,
        isActive: row.isActive === 1,
        createdAt: row.createdAt,
        data: blob,
      };
    });
  const nodes = db
    .all(`SELECT * FROM providerNodes WHERE workspaceId = ?`, [workspaceId])
    .map((row) => {
      const blob = decodeCredentialRowSync(db, row, credCtx, {
        table: "providerNodes",
        workspaceId,
      });
      sealLeaves(blob, "providerNodes", row.id, portableDek);
      return {
        sourceId: row.id,
        type: row.type ?? null,
        name: row.name ?? null,
        createdAt: row.createdAt,
        data: blob,
      };
    });
  const combos = db.all(`SELECT * FROM combos WHERE workspaceId = ?`, [workspaceId]).map((row) => ({
    sourceId: row.id,
    name: row.name,
    kind: row.kind ?? null,
    models: parseJson(row.models, []),
    sortOrder: row.sortOrder ?? null,
    createdAt: row.createdAt,
  }));
  const kv = {};
  kv.modelAliases = Object.fromEntries(
    readKvScope(db, "modelAliases", workspaceId).map(([k, v]) => [k, parseJson(v)]),
  );
  kv.customModels = Object.fromEntries(
    readKvScope(db, "customModels", workspaceId).map(([k, v]) => [k, parseJson(v, {})]),
  );
  kv.disabledModels = Object.fromEntries(
    readKvScope(db, "disabledModels", workspaceId).map(([k, v]) => [k, parseJson(v, [])]),
  );
  const prefsRow = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [
    workspaceId,
  ]);
  return {
    type: WORKSPACE_EXPORT_TYPE,
    version: WORKSPACE_EXPORT_VERSION,
    schemaVersion: latestVersion(),
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { name: source.name, kind: source.kind },
    connections,
    nodes,
    combos,
    kv,
    preferences: pickKeys(parseJson(prefsRow?.data, {}), WORKSPACE_KEYS),
  };
}

/**
 * Export one workspace as a passphrase-protected portable document.
 * @param {import("../users/principal.js").Principal} ctx
 * @param {string} workspaceId
 * @param {{ passphrase: string }} opts
 */
export async function exportWorkspace(ctx, workspaceId, { passphrase } = {}) {
  requirePassphrase(passphrase);
  const source = await authorizeWorkspace(ctx, workspaceId);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  const portableDek = randomKey();
  try {
    const doc = db.transaction(() => buildExportDoc(db, credCtx, workspaceId, source, portableDek));
    // Wrap the portable DEK while it is ALIVE: leaves were sealed with these
    // exact bytes, so zeroing before the wrap would export an all-zero key.
    const wrapped = await wrapWorkspaceExportDek(passphrase, portableDek);
    doc.kdf = wrapped.kdf;
    doc.saltB64 = wrapped.saltB64;
    doc.wrappedDek = wrapped.wrappedDek;
    return doc;
  } finally {
    // Single zero point: after the wrap captured the key material.
    zeroBuffer(portableDek);
  }
}

/** Open (authenticate) every sealed leaf of every row BEFORE any mutation. */
function openAllLeaves(sections, portableDek) {
  sections.connections.forEach((c, i) => {
    openLeaves(c.data, "providerConnections", c.sourceId, portableDek, `connections[${i}]`);
  });
  sections.nodes.forEach((n, i) => {
    openLeaves(n.data, "providerNodes", n.sourceId, portableDek, `nodes[${i}]`);
  });
}

function mergeWorkspacePreferences(db, workspaceId, prefs) {
  const existing = pickKeys(
    parseJson(
      db.get("SELECT data FROM workspaceSettings WHERE workspaceId = ?", [workspaceId])?.data,
      {},
    ),
    WORKSPACE_KEYS,
  );
  const merged = { ...existing, ...prefs };
  if (existing.comboStrategies || prefs.comboStrategies) {
    merged.comboStrategies = {
      ...(existing.comboStrategies || {}),
      ...(prefs.comboStrategies || {}),
    };
  }
  return merged;
}

// ─── import: apply (single transaction, all-or-nothing) ───────────────────

function applyImport(db, credCtx, ctx, workspaceId, sections) {
  // Re-check in-tx: only a live owner membership of an active, non-pending
  // user may mutate this workspace's rows (defense in depth; the route gate
  // alone is not enough once imports run inside one transaction).
  const member = db.get(
    `SELECT m.role AS role, u.status AS status, u.instanceRole AS instanceRole
     FROM memberships m JOIN users u ON u.id = m.userId
     WHERE m.workspaceId = ? AND m.userId = ?`,
    [workspaceId, ctx?.userId],
  );
  if (member?.role !== "owner" || member.status !== "active" || member.instanceRole === "pending") {
    fail("FORBIDDEN", "Only an active workspace owner may import into this workspace");
  }

  assertCredentialCtxCurrent(db, credCtx);
  assertNoImportConflicts(db, workspaceId, sections);

  const now = new Date().toISOString();
  // Mint NEW ids and remap every cross reference (nodes first: connections
  // reference their gateway node by provider = node id).
  const nodeIdMap = new Map();
  const nodeRows = sections.nodes.map((n) => {
    if (nodeIdMap.has(n.sourceId)) invalidFormat("duplicate source node ID");
    const id = randomUUID();
    nodeIdMap.set(n.sourceId, id);
    return { id, n };
  });
  const { remapProvider, remapModel, remapKvEntry } = createImportRemappers(nodeIdMap);

  for (const { id, n } of nodeRows) {
    const data = encodeCredentialRowSync(db, { id, data: structuredClone(n.data) }, credCtx, {
      table: "providerNodes",
      workspaceId,
    });
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, n.type ?? null, n.name ?? null, data, n.createdAt ?? now, now, workspaceId, ctx.userId],
    );
  }

  const comboIdMap = new Map();
  for (const c of sections.combos) {
    const id = randomUUID();
    if (comboIdMap.has(c.sourceId)) invalidFormat("duplicate source combo ID");
    comboIdMap.set(c.sourceId, id);
    comboIdMap.set(c.name, id); // combo models reference combos by NAME
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, sortOrder, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        c.name,
        c.kind ?? null,
        stringifyJson(c.models.map(remapModel)),
        c.createdAt ?? now,
        now,
        c.sortOrder ?? null,
        workspaceId,
        ctx.userId,
      ],
    );
  }

  const connectionSourceIds = new Set();
  for (const c of sections.connections) {
    if (connectionSourceIds.has(c.sourceId)) invalidFormat("duplicate source connection ID");
    connectionSourceIds.add(c.sourceId);
    const id = randomUUID();
    const data = encodeCredentialRowSync(db, { id, data: structuredClone(c.data) }, credCtx, {
      table: "providerConnections",
      workspaceId,
    });
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        remapProvider(c.provider),
        c.authType || "oauth",
        c.name ?? null,
        c.email ?? null,
        c.priority ?? null,
        c.isActive === false ? 0 : 1,
        data,
        c.createdAt ?? now,
        now,
        workspaceId,
        ctx.userId,
      ],
    );
  }

  const prefix = `ws:${workspaceId}/`;
  for (const scope of KV_SCOPES) {
    const entries = Object.entries(sections.kv[scope]).map(([key, value]) =>
      remapKvEntry(scope, key, value),
    );
    for (const [key, value] of entries) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)`, [
        scope,
        prefix + key,
        stringifyJson(value),
      ]);
    }
  }

  // Preferences: workspace keys only, combo strategy ids remapped to the new
  // combo ids (entries whose combo is not in this snapshot are dropped).
  const prefs = pickKeys(structuredClone(sections.preferences), WORKSPACE_KEYS);
  remapComboStrategies(prefs, comboIdMap);
  db.run(
    `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
     ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
    [workspaceId, stringifyJson(mergeWorkspacePreferences(db, workspaceId, prefs)), now],
  );
  return {
    connections: sections.connections.length,
    nodes: sections.nodes.length,
    combos: sections.combos.length,
  };
}

/**
 * Import a workspace snapshot into `workspaceId` (the caller must own it).
 * The passphrase wrap and EVERY sealed leaf authenticate before any mutation;
 * writes happen in one transaction and any conflict rolls everything back.
 * @param {import("../users/principal.js").Principal} ctx
 * @param {string} workspaceId
 * @param {object} payload the parsed export document
 * @param {{ passphrase: string }} opts
 */
export async function importWorkspace(ctx, workspaceId, payload, { passphrase } = {}) {
  requirePassphrase(passphrase);
  await authorizeWorkspace(ctx, workspaceId);
  const sections = parseImportPayload(structuredClone(payload));
  const portableDek = await unwrapWorkspaceExportDek(payload, { passphrase });
  try {
    // Authenticate every leaf before touching the database.
    openAllLeaves(sections, portableDek);
    const db = await getAdapter();
    const credCtx = await prepareCredentialCtx(db);
    const counts = db.transaction(() => applyImport(db, credCtx, ctx, workspaceId, sections));
    return { success: true, imported: counts };
  } finally {
    zeroBuffer(portableDek);
  }
}
