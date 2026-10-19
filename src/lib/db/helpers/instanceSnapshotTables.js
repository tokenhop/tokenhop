// YAN-375 complete-table snapshot parity: the raw-row instance sections a
// hashed/encrypted snapshot must carry beyond the identity graph —
// workspaceSettings, userPreferences, connectionGrants, budgets, auditEvents,
// invitations, usageHistory, usageRollup, usageBudgetCarry, requestDetails. Rows travel as the
// exact stored SQL values (JSON blobs and ciphertext envelopes stay verbatim
// strings; nothing here decrypts or re-encodes). Sync + adapter-passed, no
// barrel/driver imports (cycle-free), same contract as gatewayKeyTransfer.
//
// Column sets mirror TABLES in ../schema.js (kept local so the schema stays
// the single runtime source; a schema/migration test pins the two together).
// Absent sections retain live rows at import (older-v2 snapshots never
// silently drop new data); an explicit [] is the authoritative clear — the
// same contract gatewayVideoJobs established.

import { fail, isPlainObject, SECTIONS } from "./instanceSnapshotSchema.js";

export const INSTANCE_SNAPSHOT_SECTION_NAMES = SECTIONS.map((s) => s.name);

/**
 * Placeholder for a section whose rows are streamed by the export writer.
 * Only ever present in deferred export heads; never serialized itself.
 */
export const STREAMED_SECTION = Object.freeze({ streamed: true });

/** `seen` stand-in for paths whose duplicates are caught elsewhere (DB constraints / stage UNIQUE). */
export const NOOP_SEEN = Object.freeze({
  has: () => false,
  add() {},
});

const COLUMN_SETS = new WeakMap();

function columnSet(section) {
  let set = COLUMN_SETS.get(section);
  if (!set) {
    set = new Set(section.columns);
    COLUMN_SETS.set(section, set);
  }
  return set;
}

/**
 * Structural + reference validation of ONE row: plain object, no unknown
 * field, then the section's own validator. Shared by the in-memory
 * validateInstanceTableSections, the export writer and the staged import.
 */
export function validateSectionRow(section, row, refs, seen = NOOP_SEEN) {
  if (!isPlainObject(row)) {
    fail("TRANSFER_STATE_INVALID", `${section.name} entries must be objects`);
  }
  const columns = columnSet(section);
  for (const field of Object.keys(row)) {
    if (!columns.has(field)) {
      fail("TRANSFER_STATE_INVALID", `${section.name} entry has unknown field "${field}"`);
    }
  }
  section.validate(row, refs, seen);
}

/**
 * Keyset-page the live rows of one section (`rowid` order, constant memory).
 * `onRows(rows)` receives each page with the internal `__rid` cursor column
 * stripped. Callers must not write to the table between pages.
 */
export function forEachSectionPage(db, section, pageSize, onRows) {
  let last = 0;
  for (;;) {
    const rows = db.all(
      `SELECT *, rowid AS __rid FROM ${section.name} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [last, pageSize],
    );
    if (rows.length === 0) return;
    last = rows[rows.length - 1].__rid;
    for (const row of rows) delete row.__rid;
    onRows(rows);
    if (rows.length < pageSize) return;
  }
}

function strKey(value) {
  return typeof value === "string" && value ? value : null;
}

/**
 * Dedup keys `[k1, k2|null]` mirroring each section validator's `seen` set, so
 * a staging UNIQUE(k1)/UNIQUE(k2) catches the same duplicates. Never throws;
 * malformed values yield null (the later row validation rejects them).
 */
export function sectionDedupKeys(section, row) {
  if (!isPlainObject(row)) return [null, null];
  switch (section.name) {
    case "workspaceSettings":
      return [strKey(row.workspaceId), null];
    case "userPreferences":
      return [strKey(row.userId), null];
    case "invitations": {
      const id = strKey(row.id);
      return [strKey(row.tokenHash), id === null ? null : `id|${id}`];
    }
    case "usageHistory":
      return [Number.isInteger(row.id) ? row.id : null, null];
    case "usageRollup": {
      const dims = [];
      for (const field of [
        "dateKey",
        "workspaceId",
        "userId",
        "apiKeyId",
        "provider",
        "model",
        "connectionId",
        "endpoint",
      ]) {
        if (typeof row[field] !== "string") return [null, null];
        dims.push(row[field]);
      }
      return [JSON.stringify(dims), null];
    }
    case "usageBudgetCarry": {
      // validate(): non-empty YYYY-MM-DD day + four string attributions (''
      // allowed), keyed on JSON.stringify(dims).
      if (typeof row.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) return [null, null];
      const dims = [row.day];
      for (const field of ["workspaceId", "userId", "apiKeyId", "grantId"]) {
        if (typeof row[field] !== "string") return [null, null];
        dims.push(row[field]);
      }
      return [JSON.stringify(dims), null];
    }
    default:
      return [strKey(row.id), null];
  }
}

/**
 * Read the raw SQL rows of every complete-table section into `out`. Own-present
 * arrays always (the export is authoritative); rows are the stored values
 * verbatim so an encrypted restore rewrites identical bytes.
 */
export function exportInstanceTableSections(db, out) {
  for (const section of SECTIONS) {
    out[section.name] = db.all(`SELECT * FROM ${section.name}`);
  }
  return out;
}

/**
 * Structural + reference validation of every section. `refs` needs the sets
 * `validateIdentityGraph` builds: users, workspaces, connectionsById.
 * Own-present non-array sections fail typed; absent sections are valid (the
 * absent/retained decision is the caller's).
 */
export function validateInstanceTableSections(payload, refs) {
  for (const section of SECTIONS) {
    const value = payload[section.name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      fail("TRANSFER_STATE_INVALID", `${section.name} must be an array`);
    }
    const seen = new Set();
    for (const row of value) validateSectionRow(section, row, refs, seen);
  }
}

export function remapBudgetCarry(rows, refs) {
  const merged = new Map();
  for (const r of rows) {
    const row = {
      ...r,
      workspaceId: r.workspaceId && refs.workspaces.has(r.workspaceId) ? r.workspaceId : "",
      userId: r.userId && refs.users.has(r.userId) ? r.userId : "",
    };
    const key = JSON.stringify([row.day, row.workspaceId, row.userId, row.apiKeyId, row.grantId]);
    const prev = merged.get(key);
    if (prev) {
      for (const f of ["usd", "tokens", "requests", "notionalUsd"]) prev[f] += row[f] || 0;
    } else {
      merged.set(key, row);
    }
  }
  return [...merged.values()];
}

/**
 * Build the plan rows to write at apply: payload sections when own-present
 * (explicit [] = the authoritative clear), otherwise the live rows retained
 * across the older-snapshot restore. Retained rows are validated against the
 * incoming refs by the caller so an incompatible retain fails before mutation.
 */
export function readInstanceTableSections(db, payload, refs = null) {
  const sections = {};
  for (const section of SECTIONS) {
    if (Object.hasOwn(payload, section.name)) {
      sections[section.name] = payload[section.name];
      continue;
    }
    let rows = db.all(`SELECT * FROM ${section.name}`);
    // Usage attribution FKs are ON DELETE SET NULL: retained live telemetry
    // pointing at a workspace/user the snapshot replaces stays unattributed
    // (inserted after ownership adoption) exactly like the old cascade,
    // instead of failing the restore, being dropped or being reassigned.
    if (refs && (section.name === "usageHistory" || section.name === "requestDetails")) {
      rows = rows.map((r) => ({
        ...r,
        workspaceId: r.workspaceId && refs.workspaces.has(r.workspaceId) ? r.workspaceId : null,
        userId: r.userId && refs.users.has(r.userId) ? r.userId : null,
      }));
    }
    // YAN-424: carry has no FKs, but a retained row naming a workspace/user the
    // snapshot replaces moves to the unknown ('') attribution like the SET NULL
    // history rows above; rows that now share a primary key are summed.
    if (refs && section.name === "usageBudgetCarry") rows = remapBudgetCarry(rows, refs);
    sections[section.name] = rows;
  }
  return sections;
}

/** FK-safe destructive clear: exact reverse of the insert order. */
export function deleteInstanceTableSections(db) {
  for (const section of [...SECTIONS].reverse()) {
    db.run(`DELETE FROM ${section.name}`);
  }
}

/**
 * Write the planned sections inside the caller's transaction. Runs AFTER the
 * identity graph + connections exist (FK parents) and AFTER
 * adoptOwnerlessRowsUnscoped so restored rows keep their exported attribution
 * bytes verbatim. Any constraint violation throws and rolls the whole import
 * back — new data is never silently dropped.
 */
export function insertInstanceTableSections(db, sections) {
  for (const section of SECTIONS) {
    const rows = sections?.[section.name];
    if (!Array.isArray(rows)) continue;
    const cols = section.columns.join(", ");
    const marks = section.columns.map(() => "?").join(", ");
    for (const row of rows) {
      db.run(
        `INSERT INTO ${section.name}(${cols}) VALUES (${marks})`,
        section.columns.map((c) => row[c] ?? section.defaults?.[c] ?? null),
      );
    }
  }
}
