import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

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

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY ${ORDER_BY}`);
  return rows.map(rowToCombo);
}

// Persist a manual order. `ids` is the new relative order of a subset (the
// dashboard lists LLM combos only): those ids take the slots they already
// occupy in the full list, so combos of other kinds never move. Ranks are
// rewritten densely, which also repairs ties. Unknown/duplicate ids are
// ignored. Returns false when nothing was reordered.
export async function reorderCombos(ids) {
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

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
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
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, sortOrder)
     VALUES(?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM combos))`,
    [
      combo.id,
      combo.name,
      combo.kind,
      stringifyJson(combo.models),
      combo.createdAt,
      combo.updatedAt,
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

// Combos are globally named until YAN-364, so a rename/delete must migrate
// fromName in the instance blob AND every workspaceSettings row (each row's
// comboStrategies override shadows the blob for that workspace), preserving
// unrelated entries and the row's other prefs. Caller must hold the
// transaction that writes the combo row, so rename/delete and strategy
// migration commit or roll back together. No own entry: no settings write.
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

export async function updateCombo(id, data) {
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

export async function deleteCombo(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const row = db.get(`SELECT name FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    moveComboStrategy(db, row.name, null);
    deleted = true;
  });
  return deleted;
}
