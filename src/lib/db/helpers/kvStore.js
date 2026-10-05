import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "./jsonCol.js";

export function makeKv(scope, ctx = null) {
  const prefix = ctx?.workspaceId ? `ws:${ctx.workspaceId}/` : "";
  return {
    async get(key, fallback = null) {
      const db = await getAdapter();
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, prefix + key]);
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll() {
      const db = await getAdapter();
      const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
        scope,
        prefix.length,
        prefix,
      ]);
      const out = {};
      for (const r of rows) out[r.key.slice(prefix.length)] = parseJson(r.value);
      return out;
    },
    async set(key, value) {
      const db = await getAdapter();
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [scope, prefix + key, stringifyJson(value)],
      );
    },
    async setMany(obj) {
      const db = await getAdapter();
      db.transaction(() => {
        for (const [k, v] of Object.entries(obj)) {
          db.run(
            `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
            [scope, prefix + k, stringifyJson(v)],
          );
        }
      });
    },
    async remove(key) {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, prefix + key]);
    },
    async clear() {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
        scope,
        prefix.length,
        prefix,
      ]);
    },
  };
}
