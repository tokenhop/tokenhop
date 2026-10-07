// Usage attribution (YAN-370, ADR-0001/0005). Additive columns on usageHistory
// and requestDetails, the usageRollup table replacing the per-day usageDaily
// blob, and an in-DB backfill:
// - workspaceId/userId from the row's own JSON (meta / data);
// - apiKeyId from the old credential slot, after which `apiKey` is NULL: a
//   legacy raw key maps to its apiKeys id, an unknown raw to a `historical:`
//   pseudonym (sha256, no master-key dependency inside a migration), a hashed
//   slot is already an identity;
// - rollup rows rebuilt from usageHistory (the blob's marginal buckets can't
//   be decomposed into one grain without double counting), then usageDaily
//   is dropped (the runner's pre-migration backup is the rollback).
// Default/owner attribution of rows still NULL happens at owner bootstrap
// (ownership.adoptOwnerlessRowsUnscoped), like 005/009.
// Frozen: literal DDL, kept identical to TABLES in ../schema.js.
import { createHash } from "node:crypto";
import { indexExists, tableExists, tableHasColumn } from "./helpers.js";

const NO_KEY = "local-no-key";
const COLS = ["workspaceId", "userId", "apiKeyId", "grantId"];
const COL_DDL = {
  workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE SET NULL",
  userId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
  apiKeyId: "TEXT",
  grantId: "TEXT",
};
const INDEXES = [
  [
    "idx_uh_ws_ts",
    "CREATE INDEX IF NOT EXISTS idx_uh_ws_ts ON usageHistory(workspaceId, timestamp DESC)",
  ],
  [
    "idx_uh_user_ts",
    "CREATE INDEX IF NOT EXISTS idx_uh_user_ts ON usageHistory(userId, timestamp DESC)",
  ],
  [
    "idx_uh_key_ts",
    "CREATE INDEX IF NOT EXISTS idx_uh_key_ts ON usageHistory(apiKeyId, timestamp DESC)",
  ],
  [
    "idx_rd_ws_ts",
    "CREATE INDEX IF NOT EXISTS idx_rd_ws_ts ON requestDetails(workspaceId, timestamp DESC)",
  ],
  [
    "idx_rd_user_ts",
    "CREATE INDEX IF NOT EXISTS idx_rd_user_ts ON requestDetails(userId, timestamp DESC)",
  ],
  [
    "idx_rd_key_ts",
    "CREATE INDEX IF NOT EXISTS idx_rd_key_ts ON requestDetails(apiKeyId, timestamp DESC)",
  ],
  [
    "idx_ur_ws_date",
    "CREATE INDEX IF NOT EXISTS idx_ur_ws_date ON usageRollup(workspaceId, dateKey)",
  ],
];
const ROLLUP_DDL =
  "CREATE TABLE IF NOT EXISTS usageRollup (dateKey TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT 'local-no-key', provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', connectionId TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, tokensIn INTEGER NOT NULL DEFAULT 0, tokensOut INTEGER NOT NULL DEFAULT 0, tokensCached INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint))";

const parse = (s) => {
  try {
    const v = s ? JSON.parse(s) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const str = (v) => (typeof v === "string" && v !== "" ? v : null);

function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// raw slot → stable non-secret identity.
function keyResolver(db) {
  const legacyKeys =
    tableHasColumn(db, "apiKeys", "key") && !tableHasColumn(db, "apiKeys", "keyHash");
  const ids = new Map();
  if (legacyKeys)
    for (const r of db.all("SELECT id, key FROM apiKeys")) if (r.key) ids.set(r.key, r.id);
  const known = new Set(db.all("SELECT id FROM apiKeys").map((r) => r.id));
  return (slot) => {
    if (!str(slot)) return NO_KEY;
    if (slot === NO_KEY) return NO_KEY;
    if (!legacyKeys) return slot; // hashed storage: slot is already an id or pseudonym
    if (ids.has(slot)) return ids.get(slot);
    if (slot.startsWith("historical:") || known.has(slot)) return slot;
    return `historical:${createHash("sha256").update(slot).digest("hex").slice(0, 24)}`;
  };
}

function backfill(db) {
  const resolve = keyResolver(db);
  for (const r of db.all(
    "SELECT id, apiKey, meta FROM usageHistory WHERE apiKeyId IS NULL OR apiKey IS NOT NULL",
  )) {
    const meta = parse(r.meta) || {};
    let metaOut = r.meta;
    if (Object.hasOwn(meta, "apiKey")) {
      delete meta.apiKey;
      metaOut = JSON.stringify(meta);
    }
    db.run(
      `UPDATE usageHistory SET apiKeyId = COALESCE(apiKeyId, ?), apiKey = NULL, meta = ?,
         workspaceId = COALESCE(workspaceId, (SELECT id FROM workspaces WHERE id = ?)),
         userId = COALESCE(userId, (SELECT id FROM users WHERE id = ?)) WHERE id = ?`,
      [resolve(r.apiKey), metaOut, str(meta.workspaceId), str(meta.userId), r.id],
    );
  }
  for (const r of db.all("SELECT id, data FROM requestDetails WHERE apiKeyId IS NULL")) {
    const d = parse(r.data) || {};
    db.run(
      `UPDATE requestDetails SET apiKeyId = ?,
         workspaceId = COALESCE(workspaceId, (SELECT id FROM workspaces WHERE id = ?)),
         userId = COALESCE(userId, (SELECT id FROM users WHERE id = ?)) WHERE id = ?`,
      [str(d.apiKeyId) ?? NO_KEY, str(d.workspaceId), str(d.userId), r.id],
    );
  }
}

function rebuildRollup(db) {
  db.run("DELETE FROM usageRollup");
  const sums = new Map();
  for (const r of db.all(
    "SELECT timestamp, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory",
  )) {
    const t = parse(r.tokens) || {};
    const dims = [
      localDateKey(r.timestamp),
      r.workspaceId || "",
      r.userId || "",
      r.apiKeyId || NO_KEY,
      r.provider || "",
      r.model || "",
      r.connectionId || "",
      r.endpoint || "",
    ];
    const k = JSON.stringify(dims);
    const s = sums.get(k) || {
      dims,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      cost: 0,
    };
    s.requests += 1;
    s.tokensIn += r.promptTokens || 0;
    s.tokensOut += r.completionTokens || 0;
    s.tokensCached += t.cached_tokens || t.cache_read_input_tokens || 0;
    s.cost += r.cost || 0;
    sums.set(k, s);
  }
  // Pre-SQLite installs kept only the newest 2000 history rows but complete
  // daily blobs. Whatever a day's blob counted beyond its history rows is
  // kept as an unattributed residual at the byModel grain (every request hit
  // byModel exactly once), so totals per day, provider and model survive.
  // ponytail: residual rows lose key/account/endpoint detail (shown as "no
  // key" / "Unknown"); the blob's other marginals can't be joined back.
  // Keyed by day+provider+model, and by day+model for pre-YAN-64 blobs whose
  // byModel keys carry no provider (else their history rows never subtract).
  const fromHistory = new Map();
  const add = (k, s) => {
    const h = fromHistory.get(k) || {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      cost: 0,
    };
    for (const f of Object.keys(h)) h[f] += s[f];
    fromHistory.set(k, h);
  };
  for (const s of sums.values()) {
    add(`${s.dims[0]}\0${s.dims[4]}\0${s.dims[5]}`, s);
    add(`${s.dims[0]}\0*\0${s.dims[5]}`, s);
  }
  for (const day of db.all("SELECT dateKey, data FROM usageDaily")) {
    const blob = parse(day.data) || {};
    for (const [key, m] of Object.entries(blob.byModel || {})) {
      if (!m || typeof m !== "object") continue;
      const model = str(m.rawModel) ?? key.split("|")[0] ?? "";
      const provider = str(m.provider) ?? key.split("|")[1] ?? "";
      const h = fromHistory.get(`${day.dateKey}\0${provider || "*"}\0${model}`) || {};
      const residual = {
        requests: Math.max(0, (m.requests || 0) - (h.requests || 0)),
        tokensIn: Math.max(0, (m.promptTokens || 0) - (h.tokensIn || 0)),
        tokensOut: Math.max(0, (m.completionTokens || 0) - (h.tokensOut || 0)),
        tokensCached: Math.max(0, (m.cachedTokens || 0) - (h.tokensCached || 0)),
        cost: Math.max(0, (m.cost || 0) - (h.cost || 0)),
      };
      if (!residual.requests) continue;
      const dims = [day.dateKey, "", "", NO_KEY, provider, model, "", ""];
      const k = JSON.stringify(dims);
      const s = sums.get(k) || {
        dims,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
        cost: 0,
      };
      for (const f of Object.keys(residual)) s[f] += residual[f];
      sums.set(k, s);
    }
  }
  for (const s of sums.values()) {
    db.run(
      "INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [...s.dims, s.requests, s.tokensIn, s.tokensOut, s.tokensCached, s.cost],
    );
  }
}

export default {
  version: 14,
  name: "usage-attribution",
  up(db) {
    for (const table of ["usageHistory", "requestDetails"]) {
      for (const col of COLS) {
        if (!tableHasColumn(db, table, col))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${COL_DDL[col]}`);
      }
    }
    if (!tableExists(db, "usageRollup")) db.exec(ROLLUP_DDL);
    for (const [name, sql] of INDEXES) if (!indexExists(db, name)) db.exec(sql);
    backfill(db);
    if (tableExists(db, "usageDaily")) {
      rebuildRollup(db);
      db.exec("DROP TABLE usageDaily");
    }
  },
};
