// YAN-1226. Additive upgrade: never rebuild usageRollup (it can hold totals
// whose history was pruned). Backfill only new metrics from retained history;
// history pruned before this migration ships is unrecoverable for savings and
// combos, exactly like 017's header contract for latency. Runner owns the
// transaction + version stamp; the marker prevents a manual rerun from
// overwriting metrics after history has been pruned.
import { tableHasColumn, tableExists } from "./helpers.js";

// Frozen copies (never import the live helpers, per 017): column DDL, the
// savings counting rules and the combo truncation rule from usageRepo.js.
const COLUMNS = [
  ["savingsSavedEst", "REAL NOT NULL DEFAULT 0"],
  ["savingsBeforeEst", "REAL NOT NULL DEFAULT 0"],
  ["savingsRequests", "INTEGER NOT NULL DEFAULT 0"],
  ["rtkSavedEst", "REAL NOT NULL DEFAULT 0"],
  ["rtkBeforeEst", "REAL NOT NULL DEFAULT 0"],
  ["rtkRequests", "INTEGER NOT NULL DEFAULT 0"],
  ["headroomSavedEst", "REAL NOT NULL DEFAULT 0"],
  ["headroomBeforeEst", "REAL NOT NULL DEFAULT 0"],
  ["headroomRequests", "INTEGER NOT NULL DEFAULT 0"],
  ["pxpipeSavedEst", "REAL NOT NULL DEFAULT 0"],
  ["pxpipeBeforeEst", "REAL NOT NULL DEFAULT 0"],
  ["pxpipeRequests", "INTEGER NOT NULL DEFAULT 0"],
  ["lastUsedAt", "TEXT NOT NULL DEFAULT ''"],
];
const METHODS = ["rtk", "headroom", "pxpipe"];
const COMBO_DDL =
  "CREATE TABLE IF NOT EXISTS usageComboRollup (dateKey TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT 'local-no-key', comboName TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, comboName))";

const methodSaved = (m) => {
  if (typeof m !== "object" || !m) return 0;
  const saved = Number(m.tokensSavedEst) || 0;
  return saved > 0 ? saved : 0;
};

// Frozen copy of the savings counting rules (helpers/usageSavingsRollup.js).
function savingsAccumulate(acc, meta) {
  const savings = meta?.savings;
  if (!savings || typeof savings !== "object") return;
  const methods = savings.byMethod && typeof savings.byMethod === "object" ? savings.byMethod : {};
  let rowSaved = 0;
  for (const m of Object.values(methods)) rowSaved += methodSaved(m);
  if (rowSaved <= 0) return;
  acc.savingsSavedEst += rowSaved;
  acc.savingsBeforeEst += Number(savings.tokensBeforeEst) || 0;
  acc.savingsRequests += 1;
  for (const method of METHODS) {
    const m = methods[method];
    if (m === undefined) continue;
    const saved = methodSaved(m);
    if (saved <= 0) continue;
    acc[`${method}SavedEst`] += saved;
    acc[`${method}BeforeEst`] += Number(m.tokensBeforeEst) || 0;
    acc[`${method}Requests`] += 1;
  }
}

function zeroSavings() {
  return Object.fromEntries(
    [
      ...METHODS.flatMap((m) => [`${m}SavedEst`, `${m}BeforeEst`, `${m}Requests`]),
      "savingsSavedEst",
      "savingsBeforeEst",
      "savingsRequests",
    ].map((k) => [k, 0]),
  );
}

export default {
  version: 21,
  name: "usage-savings-combo-rollup",
  up(db) {
    for (const [col, def] of COLUMNS) {
      if (!tableHasColumn(db, "usageRollup", col))
        db.exec(`ALTER TABLE usageRollup ADD COLUMN ${col} ${def}`);
    }
    if (!tableExists(db, "usageComboRollup")) db.exec(COMBO_DDL);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ucr_ws_date ON usageComboRollup(workspaceId, dateKey)`);
    if (db.get(`SELECT value FROM _meta WHERE key = 'usageSavingsComboBackfilled'`)?.value === "1")
      return;
    // Reset only the new measures: re-running the backfill (marker lost via a
    // restore, or a crash before the stamp) reproduces identical values by
    // assignment rather than double-counting. Never touch requests/tokens/cost
    // or the latency columns.
    db.exec(
      `UPDATE usageRollup SET ${COLUMNS.map(([col]) => `${col} = ${col === "lastUsedAt" ? "''" : "0"}`).join(", ")}`,
    );
    db.exec(`DELETE FROM usageComboRollup`);
    const dayOf = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const groupKey = (r) =>
      JSON.stringify([
        dayOf(r.timestamp),
        r.workspaceId || "",
        r.userId || "",
        r.apiKeyId || "local-no-key",
        r.provider || "",
        r.model || "",
        r.connectionId || "",
        // Legacy rows can carry NULL endpoint; the column is NOT NULL.
        r.endpoint || "",
      ]);
    const comboKey = (r, comboName) =>
      JSON.stringify([
        dayOf(r.timestamp),
        r.workspaceId || "",
        r.userId || "",
        r.apiKeyId || "local-no-key",
        comboName,
      ]);
    const sums = new Map();
    const combos = new Map();
    // lastUsedAt per group via one SQL MAX/GROUP BY; only rows whose meta can
    // carry savings or a combo name are fetched and parsed below.
    for (const r of db.all(
      `SELECT date(timestamp, 'localtime') AS dateKey, workspaceId, userId, apiKeyId, provider, model,
              connectionId, endpoint, MAX(timestamp) AS lastUsedAt
       FROM usageHistory GROUP BY dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint`,
    )) {
      if (!r.dateKey || !Number.isFinite(Date.parse(r.lastUsedAt))) continue;
      const dims = [
        r.dateKey,
        r.workspaceId || "",
        r.userId || "",
        r.apiKeyId || "local-no-key",
        r.provider || "",
        r.model || "",
        r.connectionId || "",
        r.endpoint || "",
      ];
      sums.set(JSON.stringify(dims), { dims, ...zeroSavings(), lastUsedAt: r.lastUsedAt });
    }
    let id = 0;
    for (;;) {
      const rows = db.all(
        `SELECT id, timestamp, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, meta
         FROM usageHistory WHERE id > ? AND (meta LIKE '%"savings"%' OR meta LIKE '%"comboName"%') ORDER BY id LIMIT 1000`,
        [id],
      );
      if (!rows.length) break;
      for (const r of rows) {
        const key = groupKey(r);
        let meta = null;
        try {
          meta = JSON.parse(r.meta);
        } catch {}
        const s =
          sums.get(key) ||
          (sums.set(key, { dims: JSON.parse(key), ...zeroSavings(), lastUsedAt: "" }),
          sums.get(key));
        savingsAccumulate(s, meta);
        // Combo counting is independent of savings: every row with a
        // non-empty meta.comboName counts, truncated to 128 chars.
        const rawCombo = meta?.comboName;
        if (typeof rawCombo === "string" && rawCombo !== "") {
          const comboName = rawCombo.slice(0, 128);
          const ck = comboKey(r, comboName);
          const c = combos.get(ck) || { dims: JSON.parse(ck), requests: 0 };
          c.requests += 1;
          combos.set(ck, c);
        }
      }
      id = rows[rows.length - 1].id;
    }
    const SET_COLS = COLUMNS.slice(0, -1).map(([col]) => col); // all but lastUsedAt
    for (const s of sums.values()) {
      const res = db.run(
        `UPDATE usageRollup SET ${[...SET_COLS, "lastUsedAt"].map((c) => `${c} = ?`).join(", ")}
         WHERE dateKey = ? AND workspaceId = ? AND userId = ? AND apiKeyId = ?
           AND provider = ? AND model = ? AND connectionId = ? AND endpoint = ?`,
        [...SET_COLS.map((c) => s[c]), s.lastUsedAt, ...s.dims],
      );
      // Legacy history rows that were never rolled up (retention tolerates
      // them): insert a zero-measure row so their savings/lastUsedAt become
      // prune-proof too, without corrupting request totals.
      if (res.changes === 0) {
        db.run(
          `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint,
             requests, tokensIn, tokensOut, tokensCached, cost, ${[...SET_COLS, "lastUsedAt"].join(", ")})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ${[...SET_COLS, "lastUsedAt"].map(() => "?").join(", ")})`,
          [...s.dims, ...SET_COLS.map((c) => s[c]), s.lastUsedAt],
        );
      }
    }
    for (const c of combos.values()) {
      db.run(
        `INSERT INTO usageComboRollup (dateKey, workspaceId, userId, apiKeyId, comboName, requests)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [...c.dims, c.requests],
      );
    }
    db.run(
      `INSERT INTO _meta(key, value) VALUES('usageSavingsComboBackfilled', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  },
};
