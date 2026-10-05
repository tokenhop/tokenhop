// Workspace settings overrides and user preferences (YAN-362, ADR-0001).
// The `settings` blob stays the instance row AND the default; a row here
// holds explicit overrides only. Switch off: nothing reads these tables.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { assertCtx } from "@/lib/users/errors.js";
import { COMBO_NOT_FOUND } from "./settingsRepo.js";
import { defaultWorkspaceIdUnscoped, memberWorkspaceId } from "./ownership.js";
import { WORKSPACE_KEYS, USER_KEYS, pickKeys } from "@/lib/settings/settingsScope.js";

const WS_UPSERT = `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
  ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`;
const USER_UPSERT = `INSERT INTO userPreferences(userId, data, updatedAt) VALUES(?, ?, ?)
  ON CONFLICT(userId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`;

const now = () => new Date().toISOString();

function readWsData(db, workspaceId) {
  const row = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [workspaceId]);
  return parseJson(row?.data, {});
}

/**
 * One workspace's explicit overrides. Membership is re-verified in SQL
 * (`memberWorkspaceId`): a non-member id is NOT_FOUND, never "forbidden".
 * @returns {Promise<{ workspaceId: string, data: object, updatedAt: string|null }>}
 */
export async function getWorkspaceSettings(ctx, workspaceId) {
  assertCtx(ctx);
  const db = await getAdapter();
  const ws = memberWorkspaceId(ctx, db, workspaceId);
  const row = db.get(`SELECT data, updatedAt FROM workspaceSettings WHERE workspaceId = ?`, [ws]);
  return { workspaceId: ws, data: parseJson(row?.data, {}), updatedAt: row?.updatedAt ?? null };
}

/**
 * Merge `patch` (workspace keys only; others are dropped defensively) into the
 * row's overrides. @returns {Promise<object>} the merged row data.
 */
export async function updateWorkspaceSettings(ctx, workspaceId, patch) {
  assertCtx(ctx);
  const db = await getAdapter();
  const ws = memberWorkspaceId(ctx, db, workspaceId);
  const picked = pickKeys(patch, WORKSPACE_KEYS);
  let next;
  db.transaction(() => {
    next = { ...readWsData(db, ws), ...picked };
    db.run(WS_UPSERT, [ws, stringifyJson(next), now()]);
  });
  return next;
}

/**
 * Transform the workspace's comboStrategies map under one transaction.
 * `requireComboName`: the combo must exist there (guards stale names after
 * rename/delete); otherwise throws with code COMBO_NOT_FOUND and writes
 * nothing. Same semantics as settingsRepo.updateComboStrategies.
 */
export async function updateWorkspaceComboStrategies(
  ctx,
  workspaceId,
  transform,
  requireComboName,
) {
  assertCtx(ctx);
  const db = await getAdapter();
  const ws = memberWorkspaceId(ctx, db, workspaceId);
  let next;
  db.transaction(() => {
    if (
      requireComboName !== undefined &&
      !db.get(`SELECT id FROM combos WHERE name = ?`, [requireComboName])
    ) {
      throw Object.assign(new Error("Combo not found"), { code: COMBO_NOT_FOUND });
    }
    const current = readWsData(db, ws);
    const strategies = Object.hasOwn(current, "comboStrategies") ? current.comboStrategies : {};
    if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) {
      throw new Error("Invalid stored comboStrategies");
    }
    const nextStrategies = transform(strategies);
    if (
      !nextStrategies ||
      typeof nextStrategies !== "object" ||
      Array.isArray(nextStrategies) ||
      typeof nextStrategies.then === "function"
    ) {
      throw new Error("Invalid comboStrategies transform result");
    }
    if (nextStrategies === strategies) {
      next = current;
      return;
    }
    next = { ...current, comboStrategies: nextStrategies };
    db.run(WS_UPSERT, [ws, stringifyJson(next), now()]);
  });
  return next;
}

/** The user's explicit preferences (user keys only). */
export async function getUserPreferences(ctx) {
  assertCtx(ctx);
  const db = await getAdapter();
  const row = db.get(`SELECT data, updatedAt FROM userPreferences WHERE userId = ?`, [ctx.userId]);
  return { data: parseJson(row?.data, {}), updatedAt: row?.updatedAt ?? null };
}

/** Merge `patch` (user keys only; others dropped defensively). @returns merged data. */
export async function updateUserPreferences(ctx, patch) {
  assertCtx(ctx);
  const db = await getAdapter();
  const picked = pickKeys(patch, USER_KEYS);
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM userPreferences WHERE userId = ?`, [ctx.userId]);
    next = { ...parseJson(row?.data, {}), ...picked };
    db.run(USER_UPSERT, [ctx.userId, stringifyJson(next), now()]);
  });
  return next;
}

/**
 * Copy workspace keys from an instance-blob write into the Default row, inside
 * the caller's transaction. No Default workspace (switch never on) → no-op.
 * ponytail: mirror only for the single-user path; in split mode the workspace
 * route writes the workspace row directly and /api/settings carries no
 * workspace keys. Replace with nothing when the legacy blob path retires.
 * @param {object} db adapter (sync, inside caller's transaction)
 * @param {object} updates instance-blob patch
 */
export function mirrorToDefaultWorkspace(db, updates) {
  const patch = pickKeys(updates, WORKSPACE_KEYS);
  if (!Object.keys(patch).length) return false;
  const ws = defaultWorkspaceIdUnscoped(db);
  if (!ws) return false;
  const next = { ...readWsData(db, ws), ...patch };
  db.run(WS_UPSERT, [ws, stringifyJson(next), now()]);
  return true;
}

/**
 * Seed the Default row from the legacy blob's explicit workspace keys, if the
 * row is missing (INSERT OR IGNORE: never overwrites). Keys absent from the
 * blob stay absent, so defaults keep coming from the instance row.
 * No Default workspace → no-op.
 */
export function seedDefaultWorkspaceSettingsUnscoped(db) {
  const ws = defaultWorkspaceIdUnscoped(db);
  if (!ws) return false;
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const seed = pickKeys(parseJson(row?.data, {}), WORKSPACE_KEYS);
  db.run(`INSERT OR IGNORE INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)`, [
    ws,
    stringifyJson(seed),
    now(),
  ]);
  return true;
}

/**
 * Delete `password` from the settings blob (it lives in users.passwordHash).
 * Idempotent. The caller decides it is safe (owner has a non-null hash).
 * @returns {boolean} whether the blob changed
 */
export function removeLegacyPasswordUnscoped(db) {
  return db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row || !Object.hasOwn(parseJson(row.data, {}), "password")) return false;
    const { password: _drop, ...rest } = parseJson(row.data, {});
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(rest)],
    );
    return true;
  });
}

/**
 * The owner's password hash wherever it lives today: the legacy blob first,
 * else the owner row. Readers swap to this as the blob key goes away.
 * @param {object|null} settings a settings object (e.g. from getSettings())
 * @returns {Promise<string|null>}
 */
export async function getLegacyPasswordHash(settings) {
  if (settings?.password) return settings.password;
  const db = await getAdapter();
  return (
    db.get(`SELECT passwordHash FROM users WHERE instanceRole = 'owner'`)?.passwordHash ?? null
  );
}
