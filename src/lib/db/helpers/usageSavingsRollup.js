// YAN-1226: token-savings measures folded into usageRollup. Columns are a
// stored contract (migration 021, snapshots): headline sums follow the
// history counting rules in usageRepo.js exactly — per-method contributions
// only when that method's tokensSavedEst > 0, and a row's top-level
// savings.tokensBeforeEst counts (not the sum of per-method befores), so
// partial/legacy rows keep their old totals. tokensBeforeEst values may be
// negative on legacy rows; they are preserved, never clamped.
export const SAVINGS_METHODS = ["rtk", "headroom", "pxpipe"];
export const SAVINGS_COLUMNS = [
  "savingsSavedEst",
  "savingsBeforeEst",
  "savingsRequests",
  "rtkSavedEst",
  "rtkBeforeEst",
  "rtkRequests",
  "headroomSavedEst",
  "headroomBeforeEst",
  "headroomRequests",
  "pxpipeSavedEst",
  "pxpipeBeforeEst",
  "pxpipeRequests",
];
export const SAVINGS_DEFAULTS = Object.freeze(
  Object.fromEntries(SAVINGS_COLUMNS.map((c) => [c, 0])),
);

// Upsert merge (inside the writer's txn; lastUsedAt is merged separately as
// MAX(lastUsedAt, excluded.lastUsedAt) by the caller). Real deltas only touch
// savings columns, so non-savings requests pay no JSON work.
export const SAVINGS_MERGE_SQL = SAVINGS_COLUMNS.map(
  (col) => `${col} = ${col} + excluded.${col}`,
).join(", ");

function methodSaved(m) {
  if (typeof m !== "object" || !m) return 0;
  const saved = Number(m.tokensSavedEst) || 0;
  return saved > 0 ? saved : 0;
}

/**
 * One request's savings deltas, frozen copy of the counting rules
 * (getUsageSavings in usageSavingsRepo.js / rowSavedFromSavings in usageRepo.js). Returns the shared frozen
 * SAVINGS_DEFAULTS when the row contributes nothing — no per-request
 * allocation in the common case (latencyDeltas precedent).
 */
export function savingsDeltas(meta) {
  const savings = meta?.savings;
  if (!savings || typeof savings !== "object") return SAVINGS_DEFAULTS;
  const methods = savings.byMethod && typeof savings.byMethod === "object" ? savings.byMethod : {};
  let rowSaved = 0;
  for (const m of Object.values(methods)) rowSaved += methodSaved(m);
  if (rowSaved <= 0) return SAVINGS_DEFAULTS;
  const d = { ...SAVINGS_DEFAULTS };
  d.savingsSavedEst = rowSaved;
  // Top-level before, deliberately not the sum of per-method befores.
  d.savingsBeforeEst = Number(savings.tokensBeforeEst) || 0;
  d.savingsRequests = 1;
  for (const method of SAVINGS_METHODS) {
    const m = methods[method];
    if (m === undefined) continue;
    const saved = methodSaved(m);
    if (saved <= 0) continue;
    d[`${method}SavedEst`] = saved;
    d[`${method}BeforeEst`] = Number(m.tokensBeforeEst) || 0;
    d[`${method}Requests`] = 1;
  }
  return d;
}

const ROLLUP_DIMS = [
  "workspaceId",
  "userId",
  "apiKeyId",
  "provider",
  "model",
  "connectionId",
  "endpoint",
];
const COMBO_DIMS = ["workspaceId", "userId", "apiKeyId"];

/**
 * Reset and recompute the savings/combo/lastUsedAt measures from retained
 * usageHistory (live copy of migration 021's frozen backfill). Used after
 * restoring a pre-021 snapshot and after the legacy JSON import, where the
 * migration marker must not suppress re-derivation. `lastUsedAt` per group
 * comes from one SQL MAX/GROUP BY; only history rows whose meta can carry
 * savings or a combo name are fetched and parsed. Caller owns the transaction.
 * @param {object} db sync adapter
 */
export function backfillSavingsComboFromHistory(db) {
  db.exec(
    `UPDATE usageRollup SET ${[...SAVINGS_COLUMNS, "lastUsedAt"].map((c) => `${c} = ${c === "lastUsedAt" ? "''" : "0"}`).join(", ")}`,
  );
  db.exec(`DELETE FROM usageComboRollup`);
  const dayOf = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dimsOf = (r, fields) => fields.map((f) => r[f] || (f === "apiKeyId" ? "local-no-key" : ""));
  const groups = new Map();
  const groupFor = (dims) => {
    const key = JSON.stringify(dims);
    let g = groups.get(key);
    if (!g) {
      g = { dims, ...SAVINGS_DEFAULTS, lastUsedAt: "" };
      groups.set(key, g);
    }
    return g;
  };
  // date(..., 'localtime'): history timestamps are ISO instants; the rollup
  // day is server-local, exactly like localDateKey().
  for (const r of db.all(
    `SELECT date(timestamp, 'localtime') AS dateKey, ${ROLLUP_DIMS.join(", ")}, MAX(timestamp) AS lastUsedAt
     FROM usageHistory GROUP BY dateKey, ${ROLLUP_DIMS.join(", ")}`,
  )) {
    if (!r.dateKey || !Number.isFinite(Date.parse(r.lastUsedAt))) continue;
    const g = groupFor([r.dateKey, ...dimsOf(r, ROLLUP_DIMS)]);
    if (r.lastUsedAt > g.lastUsedAt) g.lastUsedAt = r.lastUsedAt;
  }
  const combos = new Map();
  let id = 0;
  for (;;) {
    const rows = db.all(
      `SELECT id, timestamp, ${ROLLUP_DIMS.join(", ")}, meta FROM usageHistory
       WHERE id > ? AND (meta LIKE '%"savings"%' OR meta LIKE '%"comboName"%') ORDER BY id LIMIT 1000`,
      [id],
    );
    if (!rows.length) break;
    for (const r of rows) {
      let meta = null;
      try {
        meta = JSON.parse(r.meta);
      } catch {}
      const d = savingsDeltas(meta);
      if (d !== SAVINGS_DEFAULTS) {
        const g = groupFor([dayOf(r.timestamp), ...dimsOf(r, ROLLUP_DIMS)]);
        for (const c of SAVINGS_COLUMNS) g[c] += d[c];
      }
      const rawCombo = meta?.comboName;
      if (typeof rawCombo === "string" && rawCombo !== "") {
        const dims = [dayOf(r.timestamp), ...dimsOf(r, COMBO_DIMS), rawCombo.slice(0, 128)];
        const key = JSON.stringify(dims);
        const c = combos.get(key) || { dims, requests: 0 };
        c.requests += 1;
        combos.set(key, c);
      }
    }
    id = rows[rows.length - 1].id;
  }
  for (const g of groups.values()) {
    const res = db.run(
      `UPDATE usageRollup SET ${[...SAVINGS_COLUMNS, "lastUsedAt"].map((c) => `${c} = ?`).join(", ")}
       WHERE dateKey = ? AND ${ROLLUP_DIMS.map((c) => `${c} = ?`).join(" AND ")}`,
      [...SAVINGS_COLUMNS.map((c) => g[c]), g.lastUsedAt, ...g.dims],
    );
    if (res.changes === 0) {
      db.run(
        `INSERT INTO usageRollup (dateKey, ${ROLLUP_DIMS.join(", ")},
           requests, tokensIn, tokensOut, tokensCached, cost, ${[...SAVINGS_COLUMNS, "lastUsedAt"].join(", ")})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ${[...SAVINGS_COLUMNS, "lastUsedAt"].map(() => "?").join(", ")})`,
        [...g.dims, ...SAVINGS_COLUMNS.map((c) => g[c]), g.lastUsedAt],
      );
    }
  }
  for (const c of combos.values()) {
    db.run(
      `INSERT INTO usageComboRollup (dateKey, ${COMBO_DIMS.join(", ")}, comboName, requests)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [...c.dims, c.requests],
    );
  }
  db.run(
    `INSERT INTO _meta(key, value) VALUES('usageSavingsComboBackfilled', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

/** Snapshot-row check of the savings columns (all optional: older snapshots lack them). */
export function validateSavingsColumns(row, fail) {
  const bad = (what) => fail("TRANSFER_STATE_INVALID", `usageRollup ${what}`);
  for (const f of ["savingsRequests", "rtkRequests", "headroomRequests", "pxpipeRequests"]) {
    if (row[f] !== undefined && !(Number.isInteger(row[f]) && row[f] >= 0)) {
      bad(`${f} must be a non-negative integer`);
    }
  }
  for (const f of ["savingsSavedEst", "rtkSavedEst", "headroomSavedEst", "pxpipeSavedEst"]) {
    if (row[f] !== undefined && !(Number.isFinite(row[f]) && row[f] >= 0)) {
      bad(`${f} must be a finite number >= 0`);
    }
  }
  for (const f of ["savingsBeforeEst", "rtkBeforeEst", "headroomBeforeEst", "pxpipeBeforeEst"]) {
    if (row[f] !== undefined && !Number.isFinite(row[f])) {
      bad(`${f} must be a finite number`);
    }
  }
  const requests = row.savingsRequests ?? 0;
  for (const method of SAVINGS_METHODS) {
    if ((row[`${method}Requests`] ?? 0) > requests) {
      bad(`${method}Requests exceeds savingsRequests`);
    }
  }
  if (row.lastUsedAt !== undefined) {
    if (typeof row.lastUsedAt !== "string") {
      bad("lastUsedAt must be a string");
    } else if (row.lastUsedAt !== "" && !Number.isFinite(Date.parse(row.lastUsedAt))) {
      bad("lastUsedAt must be an empty string or a parseable timestamp");
    }
  }
}
