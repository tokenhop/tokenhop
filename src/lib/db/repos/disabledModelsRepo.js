import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { TenancyError } from "@/lib/users/errors.js";
import { memberWorkspaceId, defaultWorkspaceIdUnscoped } from "./ownership.js";

const SCOPE = "disabledModels";

// Reserved workspace kv prefix (ADR-0001); mirrors makeKv's scoping (Task 2.1).
function wsKey(workspaceId, key) {
  return workspaceId ? `ws:${workspaceId}/${key}` : key;
}

// Scoped writes reject provider aliases inside the reserved `ws:` namespace.
function assertBareKey(key) {
  if (typeof key === "string" && key.startsWith("ws:")) {
    throw new TenancyError("INVALID", "Reserved key prefix");
  }
}

// ─── Scoped API (YAN-364): per-workspace disabled map, prefixed keys ───────

export async function getDisabledModels(ctx, workspaceId) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const prefix = wsKey(workspaceId, "");
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
    SCOPE,
    prefix.length,
    prefix,
  ]);
  const out = {};
  for (const r of rows) out[r.key.slice(prefix.length)] = parseJson(r.value, []);
  return out;
}

export async function getDisabledByProvider(ctx, workspaceId, providerAlias) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
    SCOPE,
    wsKey(workspaceId, providerAlias),
  ]);
  return row ? parseJson(row.value, []) || [] : [];
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(ctx, workspaceId, providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  assertBareKey(providerAlias);
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const key = wsKey(workspaceId, providerAlias);
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    const current = row ? parseJson(row.value, []) || [] : [];
    const merged = [...new Set([...current, ...ids])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, key, stringifyJson(merged)],
    );
  });
}

export async function enableModels(ctx, workspaceId, providerAlias, ids) {
  if (!providerAlias) return;
  assertBareKey(providerAlias);
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const key = wsKey(workspaceId, providerAlias);
  db.transaction(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    const current = row ? parseJson(row.value, []) || [] : [];
    const removeSet = new Set(ids);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, key, stringifyJson(next)],
      );
    }
  });
}

// ─── Unscoped twins (switch-off / legacy path). Before bootstrap: bare keys,
// byte-identical. After: Default workspace rows, unprefixed logical keys ─ ──

export async function getDisabledModelsUnscoped() {
  const db = await getAdapter();
  return await makeKv(SCOPE, { workspaceId: defaultWorkspaceIdUnscoped(db) }).getAll();
}

export async function getDisabledByProviderUnscoped(providerAlias) {
  const db = await getAdapter();
  const kv = makeKv(SCOPE, { workspaceId: defaultWorkspaceIdUnscoped(db) });
  return (await kv.get(providerAlias, [])) || [];
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModelsUnscoped(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  const key = wsKey(defaultWorkspaceIdUnscoped(db), providerAlias);
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    const current = row ? parseJson(row.value, []) || [] : [];
    const merged = [...new Set([...current, ...ids])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, key, stringifyJson(merged)],
    );
  });
}

export async function enableModelsUnscoped(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  const key = wsKey(defaultWorkspaceIdUnscoped(db), providerAlias);
  db.transaction(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    const current = row ? parseJson(row.value, []) || [] : [];
    const removeSet = new Set(ids);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, key, stringifyJson(next)],
      );
    }
  });
}
