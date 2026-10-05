// Workspace ownership of provider connections and nodes (YAN-361, ADR-0001),
// combos, scoped kv keys and combo strategies (YAN-364).
// Sync helpers that run inside the caller's transaction.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";

const OWNED = ["providerConnections", "providerNodes", "combos"];

/** The Default workspace id once the owner bootstrap created it, else null. */
export function defaultWorkspaceIdUnscoped(db) {
  return (
    db.get(
      `SELECT w.id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = 'defaultWorkspaceId'`,
    )?.id ?? null
  );
}

// Bare legacy keys → Default in the three workspace-scoped kv scopes.
// Only ws-prefixed-with-slash keys count as already-scoped: an ambiguous
// foreign row fails safe — never adopted into Default, never silently
// discarded. A slashless legacy `ws:foo` key is bare data and gets adopted
// like any other. Idempotent: no bare keys after the first run.
// Count of newly prefixed keys.
function adoptKvScopes(db, ws) {
  let n = 0;
  for (const scope of ["modelAliases", "customModels", "disabledModels"]) {
    n += db.run(
      `INSERT OR IGNORE INTO kv(scope, key, value)
       SELECT scope, 'ws:' || ? || '/' || key, value FROM kv
       WHERE scope = ? AND key NOT GLOB 'ws:*/*'`,
      [ws, scope],
    ).changes;
    db.run(`DELETE FROM kv WHERE scope = ? AND key NOT GLOB 'ws:*/*'`, [scope]);
  }
  return n;
}

/**
 * Blob `comboStrategies` (name-keyed) → Default workspace row keyed by combo
 * id. INSERT-only: ids already in the row are never overwritten, so reruns
 * are no-ops. Names without a combo in Default stay blob-only (today's
 * behaviour for renamed/deleted combos). Count of newly seeded ids.
 */
function seedComboStrategies(db, ws) {
  const blob = parseJson(db.get(`SELECT data FROM settings WHERE id = 1`)?.data, {});
  const strategies = blob.comboStrategies;
  if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) return 0;
  const row = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [ws]);
  const current = parseJson(row?.data, {});
  const existing = current.comboStrategies;
  const ids = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const seeded = {};
  for (const [name, entry] of Object.entries(strategies)) {
    const id = db.get(`SELECT id FROM combos WHERE name = ? AND workspaceId IS ?`, [name, ws])?.id;
    if (!id || Object.hasOwn(ids, id) || Object.hasOwn(seeded, id)) continue;
    seeded[id] = entry;
  }
  if (!Object.keys(seeded).length) return 0;
  const next = { ...current, comboStrategies: { ...ids, ...seeded } };
  db.run(
    `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
     ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
    [ws, stringifyJson(next), new Date().toISOString()],
  );
  return Object.keys(seeded).length;
}

/**
 * Ownerless rows (written before the switch was first on) → Default workspace,
 * created by the owner: connections, nodes, combos, bare keys of the scoped
 * kv scopes, and blob combo strategies. Idempotent; 0 before bootstrap.
 */
export function adoptOwnerlessRowsUnscoped(db) {
  const ws = defaultWorkspaceIdUnscoped(db);
  if (!ws) return 0;
  const owner = db.get(`SELECT id FROM users WHERE instanceRole = 'owner'`)?.id ?? null;
  let n = 0;
  for (const t of OWNED) {
    n += db.run(
      `UPDATE ${t} SET workspaceId = ?, createdByUserId = COALESCE(createdByUserId, ?) WHERE workspaceId IS NULL`,
      [ws, owner],
    ).changes;
  }
  n += adoptKvScopes(db, ws);
  n += seedComboStrategies(db, ws);
  return n;
}

export async function adoptOwnerlessUnscoped() {
  const db = await getAdapter();
  return db.transaction(() => adoptOwnerlessRowsUnscoped(db));
}

/**
 * `workspaceId` when the principal belongs to it, else NOT_FOUND. A client
 * value is only a selector; never "forbidden", so ids don't leak existence.
 */
export function memberWorkspaceId(ctx, db, workspaceId) {
  assertCtx(ctx);
  const ok =
    typeof workspaceId === "string" &&
    db.get(`SELECT 1 AS x FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      ctx.userId,
    ]);
  if (!ok) throw new TenancyError("NOT_FOUND", "Workspace not found");
  return workspaceId;
}
