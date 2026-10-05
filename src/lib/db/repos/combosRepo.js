import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { assertCtx } from "@/lib/users/errors.js";
import { memberWorkspaceId, defaultWorkspaceIdUnscoped } from "./ownership.js";

// Manual order first (drag-and-drop), creation order as the tiebreaker.
const ORDER_BY = `sortOrder IS NULL, sortOrder ASC, createdAt ASC, id ASC`;

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Scoped reads also expose the owning workspace (routes need it for rotation keys).
function rowToScopedCombo(row) {
  return row ? { ...rowToCombo(row), workspaceId: row.workspaceId ?? null } : null;
}

// ─── Unscoped API (switch-off / legacy path; byte-identical behaviour) ─────

export async function getCombosUnscoped() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY ${ORDER_BY}`);
  return rows.map(rowToCombo);
}

// Persist a manual order. `ids` is the new relative order of a subset (the
// dashboard lists LLM combos only): those ids take the slots they already
// occupy in the full list, so combos of other kinds never move. Ranks are
// rewritten densely, which also repairs ties. Unknown/duplicate ids are
// ignored. Returns false when nothing was reordered.
export async function reorderCombosUnscoped(ids) {
  const db = await getAdapter();
  let changed = false;
  db.transaction(() => {
    const all = db.all(`SELECT id FROM combos ORDER BY ${ORDER_BY}`).map((r) => r.id);
    const known = new Set(all);
    const wanted = [...new Set(ids)].filter((id) => known.has(id));
    if (wanted.length < 2) return;
    const wantedSet = new Set(wanted);
    let next = 0;
    const reordered = all.map((id) => (wantedSet.has(id) ? wanted[next++] : id));
    reordered.forEach((id, rank) => {
      db.run(`UPDATE combos SET sortOrder = ? WHERE id = ?`, [rank, id]);
    });
    changed = reordered.some((id, i) => id !== all[i]);
  });
  return changed;
}

export async function getComboByIdUnscoped(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByNameUnscoped(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createComboUnscoped(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  // YAN-364: post-bootstrap creates belong to Default (mirror of
  // createProviderConnectionUnscoped); before bootstrap the row stays
  // ownerless and globally name-unique via idx_combo_name_legacy.
  const workspaceId = defaultWorkspaceIdUnscoped(db);
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  // New combos land at the end of the manual order.
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, sortOrder, workspaceId)
     VALUES(?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM combos WHERE workspaceId IS ?), ?)`,
    [
      combo.id,
      combo.name,
      combo.kind,
      stringifyJson(combo.models),
      combo.createdAt,
      combo.updatedAt,
      workspaceId,
      workspaceId,
    ],
  );
  return combo;
}

// Rewrite one comboStrategies map: fromName -> toName, or drop it (toName null).
// Invalid maps are left untouched. Returns null when nothing changed.
function migrateStrategies(strategies, fromName, toName) {
  if (
    !strategies ||
    typeof strategies !== "object" ||
    Array.isArray(strategies) ||
    !Object.hasOwn(strategies, fromName)
  ) {
    return null;
  }
  const next = { ...strategies };
  if (toName) next[toName] = next[fromName];
  delete next[fromName];
  return next;
}

// Pre-split name-keyed cascade: instance blob AND workspaceSettings rows that
// still carry name keys. Id-keyed workspace entries (YAN-364) never match a
// combo name, so this can never rewrite them. Combos are workspace-scoped now,
// so only the Unscoped update/delete paths run this (the scoped pair below
// needs no rewrite — ids survive renames). Caller must hold the transaction
// that writes the combo row, so both commit or roll back together.
function moveComboStrategy(db, fromName, toName) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const current = row ? parseJson(row.data, {}) : {};
  const nextStrategies = migrateStrategies(current.comboStrategies, fromName, toName);
  if (nextStrategies) {
    db.run(`UPDATE settings SET data = ? WHERE id = 1`, [
      stringifyJson({ ...current, comboStrategies: nextStrategies }),
    ]);
  }
  for (const ws of db.all(`SELECT workspaceId, data FROM workspaceSettings`)) {
    const wsData = parseJson(ws.data, {});
    const migrated = migrateStrategies(wsData.comboStrategies, fromName, toName);
    if (!migrated) continue;
    db.run(`UPDATE workspaceSettings SET data = ?, updatedAt = ? WHERE workspaceId = ?`, [
      stringifyJson({ ...wsData, comboStrategies: migrated }),
      new Date().toISOString(),
      ws.workspaceId,
    ]);
  }
}

export async function updateComboUnscoped(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(`UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`, [
      merged.name,
      merged.kind,
      stringifyJson(merged.models || []),
      merged.updatedAt,
      id,
    ]);
    if (merged.name !== row.name) moveComboStrategy(db, row.name, merged.name);
    result = merged;
  });
  return result;
}

export async function deleteComboUnscoped(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const row = db.get(`SELECT name, workspaceId FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    moveComboStrategy(db, row.name, null);
    removeIdStrategyEntry(db, row.workspaceId, id);
    deleted = true;
  });
  return deleted;
}

// ─── Scoped API (YAN-364): every call takes the request principal ─────────
// Rows are looked up by (id, member workspace), so an id from another
// workspace reads as "not found" (no IDOR). `workspaceId` arguments are only
// selectors: membership is re-verified in SQL. Role checks are the route's job.
const MEMBER_ROW = `SELECT c.* FROM combos c JOIN memberships m ON m.workspaceId = c.workspaceId WHERE c.id = ? AND m.userId = ?`;

/** Combos of one workspace the principal belongs to, in display order. */
export async function listCombos(ctx, workspaceId) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  return db
    .all(`SELECT * FROM combos WHERE workspaceId = ? ORDER BY ${ORDER_BY}`, [workspaceId])
    .map(rowToScopedCombo);
}

/** A combo in any workspace the principal belongs to, else null. */
export async function getCombo(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return rowToScopedCombo(db.get(MEMBER_ROW, [id, ctx.userId]));
}

/** Same-name lookup inside one member workspace (per-workspace names). */
export async function getComboByNameScoped(ctx, workspaceId, name) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  return rowToScopedCombo(
    db.get(`SELECT * FROM combos WHERE name = ? AND workspaceId = ?`, [name, workspaceId]),
  );
}

/** Create inside `workspaceId`; the creator is the principal. */
export async function createCombo(ctx, workspaceId, data) {
  const db = await getAdapter();
  return db.transaction(() => {
    memberWorkspaceId(ctx, db, workspaceId);
    const now = new Date().toISOString();
    const combo = {
      id: uuidv4(),
      name: data.name,
      kind: data.kind || null,
      models: data.models || [],
      createdAt: now,
      updatedAt: now,
      workspaceId,
    };
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, sortOrder, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM combos WHERE workspaceId IS ?), ?, ?)`,
      [
        combo.id,
        combo.name,
        combo.kind,
        stringifyJson(combo.models),
        combo.createdAt,
        combo.updatedAt,
        workspaceId,
        workspaceId,
        ctx.userId,
      ],
    );
    return combo;
  });
}

/** Rename/edit inside a member workspace. Id-keyed workspace strategy entries
 *  survive renames by design (YAN-364 decision 4): no rewrite happens here. */
export async function updateCombo(ctx, id, data) {
  assertCtx(ctx);
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(MEMBER_ROW, [id, ctx.userId]);
    if (!row) return;
    const merged = { ...rowToScopedCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(`UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`, [
      merged.name,
      merged.kind,
      stringifyJson(merged.models || []),
      merged.updatedAt,
      id,
    ]);
    result = merged;
  });
  return result;
}

/** Drop the id entry from that workspace's strategy overrides in the same
 *  transaction as the row delete. No global/name cascade (YAN-364). */
function removeIdStrategyEntry(db, workspaceId, comboId) {
  const row = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [workspaceId]);
  const data = parseJson(row?.data, {});
  if (!data.comboStrategies || !Object.hasOwn(data.comboStrategies, comboId)) return;
  const next = { ...data.comboStrategies };
  delete next[comboId];
  db.run(`UPDATE workspaceSettings SET data = ?, updatedAt = ? WHERE workspaceId = ?`, [
    stringifyJson({ ...data, comboStrategies: next }),
    new Date().toISOString(),
    workspaceId,
  ]);
}

export async function deleteCombo(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const row = db.get(MEMBER_ROW, [id, ctx.userId]);
    if (!row) return;
    db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    removeIdStrategyEntry(db, row.workspaceId, id);
    deleted = true;
  });
  return deleted;
}

/** reorderCombosUnscoped's algorithm, partitioned to one workspace's rows. */
export async function reorderCombos(ctx, workspaceId, ids) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  let changed = false;
  db.transaction(() => {
    const all = db
      .all(`SELECT id FROM combos WHERE workspaceId = ? ORDER BY ${ORDER_BY}`, [workspaceId])
      .map((r) => r.id);
    const known = new Set(all);
    const wanted = [...new Set(ids)].filter((id) => known.has(id));
    if (wanted.length < 2) return;
    const wantedSet = new Set(wanted);
    let next = 0;
    const reordered = all.map((id) => (wantedSet.has(id) ? wanted[next++] : id));
    reordered.forEach((id, rank) => {
      db.run(`UPDATE combos SET sortOrder = ? WHERE id = ?`, [rank, id]);
    });
    changed = reordered.some((id, i) => id !== all[i]);
  });
  return changed;
}
