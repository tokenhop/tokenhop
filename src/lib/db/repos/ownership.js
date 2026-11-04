// Workspace ownership of provider connections and nodes (YAN-361, ADR-0001),
// combos, scoped kv keys and combo strategies (YAN-364).
// Sync helpers that run inside the caller's transaction.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { setMetaSync } from "../helpers/metaStore.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";
import { LATENCY_COLUMNS, LATENCY_MERGE_SQL } from "../helpers/usageLatencyRollup.js";
import { SAVINGS_COLUMNS, SAVINGS_MERGE_SQL } from "../helpers/usageSavingsRollup.js";

const OWNED = ["providerConnections", "providerNodes", "combos"];

// YAN-1553: install-local and retained across imports, even user-less restores.
export const USAGE_ADOPTED_AT = "usageAdoptedAt";
// YAN-1829: Default row created for switch-off budgets before any owner
// exists. A separate key: `defaultWorkspaceId` stays unset, so pristine
// routing and storage never change; the owner bootstrap promotes the row.
export const PENDING_DEFAULT_WORKSPACE = "pendingDefaultWorkspaceId";

/** The Default workspace id once the owner bootstrap created it, else null. */
export function defaultWorkspaceIdUnscoped(db) {
  return (
    db.get(
      `SELECT w.id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = 'defaultWorkspaceId'`,
    )?.id ?? null
  );
}

/** The pending (pre-bootstrap) Default workspace id, else null. */
export function pendingDefaultWorkspaceIdUnscoped(db) {
  return (
    db.get(
      `SELECT w.id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = '${PENDING_DEFAULT_WORKSPACE}'`,
    )?.id ?? null
  );
}

/** Workspace switch-off budgets live on: Default, else the pending Default. */
export function offBudgetWorkspaceIdUnscoped(db) {
  return defaultWorkspaceIdUnscoped(db) ?? pendingDefaultWorkspaceIdUnscoped(db);
}

/**
 * Switch-off budget workspace, creating the pending Default (shared, no
 * owner, no membership) when neither exists. Existing ownerless usage moves
 * into it so workspace budgets count the whole window; requestDetails stay
 * NULL. Runs inside the caller's transaction; a dangling key is overwritten.
 */
export function ensurePendingDefaultWorkspaceUnscoped(db) {
  const existing = offBudgetWorkspaceIdUnscoped(db);
  if (existing) return existing;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, 'Default', 'shared', NULL, ?, ?)`,
    [id, now, now],
  );
  setMetaSync(db, PENDING_DEFAULT_WORKSPACE, id);
  adoptUsage(db, id, null, { details: false });
  return id;
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
 *
 * YAN-1553: usage adoption is opt-in; bootstrapOwnerUnscoped opts in only
 * before the durable usageAdoptedAt marker exists. Later owner bootstraps
 * (including after a user-less restore), restarts, switch toggles and config
 * imports leave deliberately detached usage untouched. Scoped usage views
 * never show it.
 * YAN-1829: `reusedWs` (the promoted pending Default, first adoption only)
 * also gives the owner that workspace's user-less usage.
 * @param {object} db adapter (inside the caller's transaction)
 * @param {{ includeUsage?: boolean, reusedWs?: string|null }} [opts]
 */
export function adoptOwnerlessRowsUnscoped(db, { includeUsage = false, reusedWs = null } = {}) {
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
  if (includeUsage) n += adoptUsage(db, ws, owner, { reusedWs: reusedWs === ws ? ws : null });
  return n;
}

// Rollup and carry rows matching `where` → (ws, owner); a '' user becomes the
// owner. Merges by summing into any existing target row.
function foldRollups(db, where, params, ws, owner) {
  let n = db.run(
    `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost, ${LATENCY_COLUMNS.join(", ")}, ${SAVINGS_COLUMNS.join(", ")}, lastUsedAt)
     SELECT dateKey, ?, CASE WHEN userId = '' THEN ? ELSE userId END, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost, ${LATENCY_COLUMNS.join(", ")}, ${SAVINGS_COLUMNS.join(", ")}, lastUsedAt
     FROM usageRollup WHERE ${where}
     ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint) DO UPDATE SET
       requests = requests + excluded.requests, tokensIn = tokensIn + excluded.tokensIn,
       tokensOut = tokensOut + excluded.tokensOut, tokensCached = tokensCached + excluded.tokensCached,
       cost = cost + excluded.cost, ${LATENCY_MERGE_SQL}, ${SAVINGS_MERGE_SQL},
       lastUsedAt = MAX(lastUsedAt, excluded.lastUsedAt)`,
    [ws, owner ?? "", ...params],
  ).changes;
  db.run(`DELETE FROM usageRollup WHERE ${where}`, params);
  n += db.run(
    `INSERT INTO usageComboRollup (dateKey, workspaceId, userId, apiKeyId, comboName, requests)
     SELECT dateKey, ?, CASE WHEN userId = '' THEN ? ELSE userId END, apiKeyId, comboName, requests
     FROM usageComboRollup WHERE ${where}
     ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, comboName) DO UPDATE SET
       requests = requests + excluded.requests`,
    [ws, owner ?? "", ...params],
  ).changes;
  db.run(`DELETE FROM usageComboRollup WHERE ${where}`, params);
  // YAN-424: pruned-history budget carry follows its (formerly ownerless) rows.
  n += db.run(
    `INSERT INTO usageBudgetCarry (day, workspaceId, userId, apiKeyId, grantId, usd, tokens, requests, notionalUsd)
     SELECT day, ?, CASE WHEN userId = '' THEN ? ELSE userId END, apiKeyId, grantId, usd, tokens, requests, notionalUsd
     FROM usageBudgetCarry WHERE ${where}
     ON CONFLICT (day, workspaceId, userId, apiKeyId, grantId) DO UPDATE SET
       usd = usd + excluded.usd, tokens = tokens + excluded.tokens,
       requests = requests + excluded.requests, notionalUsd = notionalUsd + excluded.notionalUsd`,
    [ws, owner ?? "", ...params],
  ).changes;
  db.run(`DELETE FROM usageBudgetCarry WHERE ${where}`, params);
  return n;
}

// YAN-370: usage written before bootstrap → Default workspace, the owner.
// `details: false` (pending Default) leaves requestDetails NULL, so the
// per-workspace details cap never doubles. `reusedWs`: see adoptOwnerless.
function adoptUsage(db, ws, owner, { details = true, reusedWs = null } = {}) {
  let n = 0;
  for (const t of details ? ["usageHistory", "requestDetails"] : ["usageHistory"]) {
    n += db.run(
      `UPDATE ${t} SET workspaceId = ?, userId = COALESCE(userId, ?) WHERE workspaceId IS NULL`,
      [ws, owner],
    ).changes;
  }
  n += foldRollups(db, "workspaceId = ''", [], ws, owner);
  if (reusedWs && owner) {
    n += db.run(`UPDATE usageHistory SET userId = ? WHERE workspaceId = ? AND userId IS NULL`, [
      owner,
      reusedWs,
    ]).changes;
    n += foldRollups(db, "workspaceId = ? AND userId = ''", [reusedWs], reusedWs, owner);
  }
  return n;
}

/**
 * YAN-1547: write the stored users & teams switch and, on an effective
 * off→on transition with an owner present, adopt rows created while it was
 * off — in ONE transaction, so a failed adoption never leaves the switch on
 * with invisible ownerless rows. Detached usage history is never adopted.
 * @param {boolean} enabled
 * @param {{ adopt: boolean }} opts adopt = caller-determined off→on transition
 * @returns {Promise<number>} rows adopted
 */
export async function setMultiUserEnabledUnscoped(enabled, { adopt }) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const next = { ...(row ? parseJson(row.data, {}) : {}), multiUserEnabled: enabled === true };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
    if (!adopt || !db.get(`SELECT 1 AS x FROM users WHERE instanceRole = 'owner'`)) return 0;
    return adoptOwnerlessRowsUnscoped(db);
  });
}

/** Existing-owner adoption in its own transaction; never adopts usage (YAN-1549). */
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
