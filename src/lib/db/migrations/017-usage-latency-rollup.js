// YAN-771. Additive upgrade: never rebuild usageRollup (it can hold totals
// whose history was pruned). Backfill only new metrics from retained history.
// Runner owns transaction + version stamp; marker prevents a manual rerun
// from overwriting metrics after history has been pruned.
import { tableHasColumn } from "./helpers.js";

// Frozen copy of histogram v1 (helpers/usageLatencyRollup.js); never import it.
const BOUNDS = [0, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 120000];
const COLUMNS = [
  "latencySumMs",
  "latencyCount",
  "emptyCount",
  "latencyRequests",
  "latencyHistogram",
];

export default {
  version: 17,
  name: "usage-latency-rollup",
  up(db) {
    const ddl = ["REAL", "INTEGER", "INTEGER", "INTEGER", "TEXT"];
    for (const [i, col] of COLUMNS.entries()) {
      const def = i === 4 ? "'[0,0,0,0,0,0,0,0,0,0,0,0]'" : "0";
      if (!tableHasColumn(db, "usageRollup", col))
        db.exec(`ALTER TABLE usageRollup ADD COLUMN ${col} ${ddl[i]} NOT NULL DEFAULT ${def}`);
    }
    if (db.get(`SELECT value FROM _meta WHERE key = 'usageLatencyBackfilled'`)?.value === "1")
      return;
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
        r.endpoint,
      ]);
    // Groups are bounded by rollup rows; batches bound the request scan.
    const sums = new Map();
    let id = 0;
    for (;;) {
      const rows = db.all(
        `SELECT id, timestamp, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, meta
         FROM usageHistory WHERE endpoint = 'completions' AND id > ? ORDER BY id LIMIT 1000`,
        [id],
      );
      if (!rows.length) break;
      for (const r of rows) {
        const key = groupKey(r);
        const s = sums.get(key) || {
          dims: JSON.parse(key),
          sum: 0,
          count: 0,
          empty: 0,
          requests: 0,
          bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        let meta = null;
        try {
          meta = JSON.parse(r.meta);
        } catch {}
        // YAN-743 json_extract + Number/Boolean conversion, frozen copy.
        const raw = meta?.latencyMs;
        const ms = Number(raw && typeof raw === "object" ? JSON.stringify(raw) : raw);
        if (raw != null && Number.isFinite(ms)) {
          s.sum += ms;
          s.count++;
          const bin = BOUNDS.findIndex((b) => ms <= b);
          s.bins[bin === -1 ? BOUNDS.length - 1 : bin]++;
        }
        if (meta?.empty) s.empty++;
        s.requests++;
        sums.set(key, s);
      }
      id = rows[rows.length - 1].id;
    }
    for (const s of sums.values()) {
      db.run(
        `UPDATE usageRollup SET latencySumMs = ?, latencyCount = ?, emptyCount = ?,
           latencyRequests = ?, latencyHistogram = ?
         WHERE dateKey = ? AND workspaceId = ? AND userId = ? AND apiKeyId = ?
           AND provider = ? AND model = ? AND connectionId = ? AND endpoint = ?`,
        [s.sum, s.count, s.empty, s.requests, JSON.stringify(s.bins), ...s.dims],
      );
    }
    db.run(
      `INSERT INTO _meta(key, value) VALUES('usageLatencyBackfilled', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  },
};
