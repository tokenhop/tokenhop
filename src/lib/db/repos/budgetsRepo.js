// YAN-372: budget management. Scope ownership and authority are live inside
// each transaction; route scope is authoritative, foreign IDs stay invisible.
// YAN-1829: `ctx.budgetMode === "off"` (switch off, built by the route gate
// only): the dashboard admin manages workspace/key budgets on Default, or on
// the pending Default of a pristine install, created by the first budget.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { membershipRole } from "./membershipsRepo.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { isMultiUserEnabled, isMultiUserEnabledSync } from "@/lib/users/featureSwitch.js";
import {
  defaultWorkspaceIdUnscoped,
  ensurePendingDefaultWorkspaceUnscoped,
  offBudgetWorkspaceIdUnscoped,
} from "./ownership.js";
import { can } from "@/lib/users/principal.js";
import { audit, auditSync } from "@/lib/users/audit.js";
import {
  SCOPE_TYPES,
  WINDOWS,
  LIMIT_FIELDS,
  membershipScopeId,
  resetAtIso,
  isRaise,
  bumpBudgetsGeneration,
  budgetLimitsError,
} from "@/lib/users/budgets.js";

const COLS =
  "id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt";
const MUTABLE = [...LIMIT_FIELDS, "softLimitPct"];
const invalid = (message) => new TenancyError("INVALID", message);
const missing = () => new TenancyError("NOT_FOUND", "Budget scope not found");
const OFF_SCOPES = ["workspace", "key"];
// Path alias for the switch-off budget workspace (Default or pending).
export const OFF_WORKSPACE_ALIAS = "default";

const offMode = (ctx) => ctx?.budgetMode === "off";

/** Session principal, or the pristine switch-off admin (no user row). */
export async function assertBudgetActor(ctx) {
  if (!offMode(ctx)) return assertCtx(ctx);
  if (ctx.userId != null) assertCtx(ctx);
  // Off-mode authority exists only while the switch really is off.
  if (await isMultiUserEnabled()) throw new TenancyError("FORBIDDEN", "Switch is on");
}

function requireOffScope(row) {
  if (!OFF_SCOPES.includes(row.scopeType))
    throw new TenancyError("SCOPE_UNAVAILABLE", "This budget scope needs Users & teams");
}

/**
 * Off-mode authority and target: established installs need a live active
 * owner/admin session (or login-off local owner) with a membership in the
 * budget workspace; the pristine admin (session or login-off local) has no
 * user row. Path id: the alias or the resolved id, else NOT_FOUND.
 * `create` makes the pending Default when no budget workspace exists yet;
 * `list` reads an empty one; anything else needs it (NOT_FOUND).
 * The switch is re-read in the transaction: a flip after assertBudgetActor fails.
 */
function offAccess(db, ctx, { workspaceId = null, userId = null } = {}, opts = {}) {
  if (isMultiUserEnabledSync(db)) throw new TenancyError("FORBIDDEN", "Switch is on");
  if (!["session", "local"].includes(ctx.via) || ctx.apiKeyId != null)
    throw new TenancyError("FORBIDDEN", "Session required");
  if (ctx.userId != null) {
    const user = db.get("SELECT instanceRole, status FROM users WHERE id = ?", [ctx.userId]);
    if (user?.status !== "active") throw missing();
    if (!["owner", "admin"].includes(user.instanceRole))
      throw new TenancyError("FORBIDDEN", "Instance admin required");
  }
  if (userId !== null || typeof workspaceId !== "string" || !workspaceId) throw missing();
  let ws = offBudgetWorkspaceIdUnscoped(db);
  if (workspaceId !== OFF_WORKSPACE_ALIAS && workspaceId !== ws) throw missing();
  if (!ws && opts.create) ws = ensurePendingDefaultWorkspaceUnscoped(db);
  if (!ws && !opts.list) throw missing();
  // A user principal acts on the real Default only as a member, like key
  // management: an instance admin outside Default sees NOT_FOUND instead of
  // budgets whose keys it cannot list (a create rolls back). The pending
  // Default has no memberships by design.
  if (ctx.userId != null && ws && ws === defaultWorkspaceIdUnscoped(db)) {
    if (!membershipRole(db, ws, ctx.userId)) throw missing();
  }
  return { raise: true, allowed: () => true, workspaceId: ws };
}

function validateBody(body, keys) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw invalid("Invalid budget fields");
}

function validateLimits(row) {
  const error = budgetLimitsError(row);
  if (error) throw invalid(error);
}

/**
 * Live budget authority for a target (sync, inside the caller's transaction;
 * returns `{ raise, allowed(cap), workspaceId }`). Rechecks the live user,
 * membership and switch. Shared with budget webhooks (YAN-1831).
 */
export function budgetWorkspaceAccess(
  db,
  ctx,
  { workspaceId = null, userId = null } = {},
  opts = {},
) {
  if (offMode(ctx)) return offAccess(db, ctx, { workspaceId, userId }, opts);
  assertCtx(ctx);
  if (ctx.via !== "session" || ctx.apiKeyId != null) {
    throw new TenancyError("FORBIDDEN", "Session required");
  }
  const user = db.get("SELECT instanceRole, status FROM users WHERE id = ?", [ctx.userId]);
  if (user?.status !== "active") throw missing();
  const live = { instanceRole: user.instanceRole, workspaceRoles: {} };
  const raise = can(live, "instance.budgets.raise");
  if (userId !== null) {
    if (workspaceId !== null || typeof userId !== "string" || !userId)
      throw invalid("Invalid user scope");
    if (!raise) throw new TenancyError("FORBIDDEN", "Instance admin required");
    if (!db.get("SELECT id FROM users WHERE id = ?", [userId])) throw missing();
  } else {
    if (typeof workspaceId !== "string" || !workspaceId) throw invalid("Workspace required");
    if (!db.get("SELECT id FROM workspaces WHERE id = ?", [workspaceId])) throw missing();
    const role = membershipRole(db, workspaceId, ctx.userId);
    live.workspaceRoles[workspaceId] = role;
    if (!role && !can(live, "workspace.budgets.read", { workspaceId })) throw missing();
  }
  return { raise, allowed: (cap) => can(live, cap, { workspaceId }), workspaceId };
}

/**
 * Resolve a budget's target the way the API does: the scope must exist in
 * `workspaceId` (key: in that workspace on hashed storage, by id on legacy
 * storage and only while off). Throws NOT_FOUND / INVALID TenancyErrors.
 * Returns the key or grant row (owner fields), else null.
 */
export function resolveBudgetScopeUnscoped(
  db,
  row,
  { workspaceId = null, userId = null, off = false } = {},
) {
  const { scopeType, scopeId } = row;
  if (typeof scopeId !== "string" || !scopeId) throw invalid("scopeId required");
  if (userId !== null) {
    if (scopeType !== "user" || scopeId !== userId || row.workspaceId !== null) throw missing();
    return null;
  }
  if (row.workspaceId !== workspaceId || scopeType === "user") throw missing();
  if (scopeType === "workspace") {
    if (scopeId !== workspaceId) throw missing();
  } else if (scopeType === "membership") {
    const prefix = `${workspaceId}:`;
    const memberId = scopeId.startsWith(prefix) ? scopeId.slice(prefix.length) : null;
    if (
      !memberId ||
      scopeId !== membershipScopeId(workspaceId, memberId) ||
      !membershipRole(db, workspaceId, memberId)
    )
      throw missing();
  } else if (scopeType === "key") {
    const legacy = readApiKeyStorageState(db).storage !== "hashed";
    if (legacy && !off) throw invalid("Key budgets require hashed API keys");
    // Switch-off legacy storage: global keys, budgeted on apiKeys.id (the
    // usage writer's legacyKeyId); hashing keeps the id (YAN-1829).
    const key = legacy
      ? db.get("SELECT id, NULL AS userId FROM apiKeys WHERE id = ?", [scopeId])
      : db.get("SELECT id, userId FROM apiKeys WHERE id = ? AND workspaceId = ?", [
          scopeId,
          workspaceId,
        ]);
    if (!key) throw missing();
    return key;
  } else if (scopeType === "grant") {
    const grant = db.get(
      `SELECT g.id, g.createdByUserId FROM connectionGrants g
      JOIN providerConnections c ON c.id = g.connectionId
      WHERE g.id = ? AND c.workspaceId = ? AND g.revokedAt IS NULL`,
      [scopeId, workspaceId],
    );
    if (!grant) throw missing();
    return grant;
  } else throw invalid("Invalid scope type");
  return null;
}

// NULL is unlimited, so it exceeds a finite cap.
const exceedsCeiling = (ceiling, row) =>
  Boolean(ceiling) &&
  LIMIT_FIELDS.some((f) => ceiling[f] !== null && (row[f] === null || row[f] > ceiling[f]));

/**
 * Key-budget ceiling rule (ADR-0007): a key budget may not exceed the
 * workspace budget of the same window. `ceiling` overrides the stored
 * workspace row (an import preview's not-yet-written one). Returns the
 * error message, else null.
 */
export function budgetCeilingErrorUnscoped(db, row, workspaceId, ceiling) {
  if (row.scopeType !== "key" || !workspaceId) return null;
  const cap =
    ceiling ??
    db.get("SELECT * FROM budgets WHERE scopeType = 'workspace' AND scopeId = ? AND window = ?", [
      workspaceId,
      row.window,
    ]);
  return exceedsCeiling(cap, row) ? "Exceeds workspace budget" : null;
}

function requireWrite(db, ctx, access, before, after, scope, target) {
  const row = after ?? before;
  if (row.scopeType === "user" || isRaise(before, after)) {
    if (!access.raise) throw new TenancyError("FORBIDDEN", "Instance admin required");
    return;
  }
  const ownKey =
    row.scopeType === "key" &&
    scope.userId === ctx.userId &&
    access.allowed("workspace.keys.create");
  const ownGrant =
    row.scopeType === "grant" &&
    (scope.createdByUserId === ctx.userId || access.allowed("workspace.grants.manage"));
  if (!access.allowed("workspace.budgets.lower") && !ownKey && !ownGrant) {
    throw new TenancyError("FORBIDDEN", "Budget management forbidden");
  }
  // Every non-raising key-budget write obeys the workspace ceiling, whoever
  // makes it (ADR-0007).
  const ceilingError = budgetCeilingErrorUnscoped(db, row, target.workspaceId);
  if (ceilingError) throw invalid(ceilingError);
}

function scopedBudget(db, budgetId, target) {
  const row = db.get(`SELECT ${COLS} FROM budgets WHERE id = ?`, [budgetId]);
  if (
    !row ||
    (target.userId != null
      ? row.scopeType !== "user" || row.scopeId !== target.userId || row.workspaceId !== null
      : row.workspaceId !== target.workspaceId)
  )
    throw missing();
  return row;
}

async function committed(ctx, action, before, after) {
  const row = after ?? before;
  bumpBudgetsGeneration();
  await audit(
    { principal: ctx, workspaceId: row.workspaceId },
    `budget.${action}`,
    { type: "budget", id: row.id },
    { before, after },
  );
  return row;
}

export async function listBudgets(ctx, { workspaceId } = {}) {
  await assertBudgetActor(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const access = budgetWorkspaceAccess(db, ctx, { workspaceId }, { list: true });
    if (!access.allowed("workspace.budgets.read"))
      throw new TenancyError("FORBIDDEN", "Budget read forbidden");
    if (offMode(ctx)) {
      if (!access.workspaceId) return [];
      return db.all(
        `SELECT ${COLS} FROM budgets WHERE workspaceId = ? AND scopeType IN ('workspace', 'key') ORDER BY createdAt, id`,
        [access.workspaceId],
      );
    }
    return db.all(`SELECT ${COLS} FROM budgets WHERE workspaceId = ? ORDER BY createdAt, id`, [
      workspaceId,
    ]);
  });
}

/** Resolved id of the route workspace: the off-mode budget workspace, else the path id. */
export async function budgetWorkspaceId(ctx, workspaceId) {
  if (!offMode(ctx)) return workspaceId;
  return offBudgetWorkspaceIdUnscoped(await getAdapter());
}

export async function listUserBudgets(ctx, { userId } = {}) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    budgetWorkspaceAccess(db, ctx, { userId });
    return db.all(
      `SELECT ${COLS} FROM budgets WHERE scopeType = 'user' AND scopeId = ? AND workspaceId IS NULL ORDER BY createdAt, id`,
      [userId],
    );
  });
}

export async function createBudget(ctx, options = {}) {
  await assertBudgetActor(ctx);
  validateBody(options, ["workspaceId", "userId", "scopeType", "scopeId", "window", ...MUTABLE]);
  const { workspaceId = null, userId = null, scopeType, scopeId, window } = options;
  if (!SCOPE_TYPES.includes(scopeType) || !WINDOWS.includes(window))
    throw invalid("Invalid budget scope or window");
  const off = offMode(ctx);
  const row = {
    id: uuidv4(),
    workspaceId,
    scopeType,
    scopeId,
    window,
    ...Object.fromEntries(MUTABLE.map((field) => [field, options[field] ?? null])),
    resetAt: resetAtIso(window),
    createdByUserId: ctx.userId ?? null,
    createdAt: new Date().toISOString(),
  };
  if (off) requireOffScope(row);
  validateLimits(row);
  const db = await getAdapter();
  mapConstraintErrors(() =>
    db.transaction(() => {
      const access = budgetWorkspaceAccess(db, ctx, { workspaceId, userId }, { create: true });
      const target = { workspaceId: access.workspaceId ?? workspaceId, userId };
      if (off) {
        // The path alias (or id) names the resolved off workspace.
        if (
          scopeType === "workspace" &&
          [OFF_WORKSPACE_ALIAS, target.workspaceId].includes(scopeId)
        )
          row.scopeId = target.workspaceId;
        row.workspaceId = target.workspaceId;
      }
      const scope = resolveBudgetScopeUnscoped(db, row, { ...target, off });
      requireWrite(db, ctx, access, null, row, scope, target);
      db.run(
        `INSERT INTO budgets(${COLS}) VALUES(${Array(12).fill("?").join(", ")})`,
        COLS.split(", ").map((field) => row[field]),
      );
    }),
  );
  return committed(ctx, "create", null, row);
}

export async function updateBudget(
  ctx,
  { workspaceId = null, userId = null, budgetId } = {},
  patch = {},
) {
  await assertBudgetActor(ctx);
  validateBody(patch, MUTABLE);
  if (Object.keys(patch).length === 0) throw invalid("Empty patch");
  const db = await getAdapter();
  const off = offMode(ctx);
  const { before, after } = mapConstraintErrors(() =>
    db.transaction(() => {
      const access = budgetWorkspaceAccess(db, ctx, { workspaceId, userId });
      const target = { workspaceId: access.workspaceId ?? workspaceId, userId };
      const before = scopedBudget(db, budgetId, target);
      if (off) requireOffScope(before);
      const scope = resolveBudgetScopeUnscoped(db, before, { ...target, off });
      const after = { ...before, ...patch, resetAt: resetAtIso(before.window) };
      validateLimits(after);
      requireWrite(db, ctx, access, before, after, scope, target);
      db.run(
        "UPDATE budgets SET limitUsd = ?, limitTokens = ?, limitRequests = ?, softLimitPct = ?, resetAt = ? WHERE id = ?",
        [...MUTABLE.map((field) => after[field]), after.resetAt, budgetId],
      );
      return { before, after };
    }),
  );
  return committed(ctx, "update", before, after);
}

export async function deleteBudget(ctx, { workspaceId = null, userId = null, budgetId } = {}) {
  await assertBudgetActor(ctx);
  const db = await getAdapter();
  const before = db.transaction(() => {
    const access = budgetWorkspaceAccess(db, ctx, { workspaceId, userId });
    const target = { workspaceId: access.workspaceId ?? workspaceId, userId };
    const row = scopedBudget(db, budgetId, target);
    if (offMode(ctx)) requireOffScope(row);
    // No scope resolution: a budget whose key/grant/membership is gone must stay
    // deletable (scopedBudget already pins it to this workspace/user), and
    // delete is a raise, so only instance admins reach the DELETE anyway.
    requireWrite(db, ctx, access, row, null, {}, target);
    db.run("DELETE FROM budgets WHERE id = ?", [budgetId]);
    return row;
  });
  return committed(ctx, "delete", before, null);
}

// Trusted gateway reader only; never expose this through management routes.
export function listAllBudgetsUnscoped(db) {
  return db.all(`SELECT ${COLS} FROM budgets ORDER BY createdAt, id`);
}

// ─── YAN-1834: portable budget definitions (config document) ─────────────
// Limits only: ids, the managing workspace, creator, timestamps, resetAt,
// spend, notices and reservations never leave the instance.

const portableKey = (e) => `${e.scopeType}:${e.scopeId ?? "workspace"}:${e.window}`;
const sameLimits = (a, b) => MUTABLE.every((f) => (a[f] ?? null) === (b[f] ?? null));
const limitsOf = (row) => Object.fromEntries(MUTABLE.map((f) => [f, row[f] ?? null]));

function portableDefinition(row, workspaceId) {
  let scopeId = row.scopeId;
  if (row.scopeType === "workspace") scopeId = null;
  else if (row.scopeType === "membership") scopeId = row.scopeId.slice(workspaceId.length + 1);
  return { scopeType: row.scopeType, scopeId, window: row.window, ...limitsOf(row) };
}

/**
 * Budgets of the config document's workspace: Default (switch on), or the
 * switch-off budget workspace (Default or pending Default; workspace and key
 * scopes only, like the off-mode list). Workspace rows come first.
 */
export function exportPortableBudgetsUnscoped(db) {
  const off = !isMultiUserEnabledSync(db);
  const ws = off ? offBudgetWorkspaceIdUnscoped(db) : defaultWorkspaceIdUnscoped(db);
  if (!ws) return [];
  const scopes = off ? " AND scopeType IN ('workspace', 'key')" : "";
  return db
    .all(
      `SELECT ${COLS} FROM budgets WHERE workspaceId = ?${scopes} ORDER BY scopeType <> 'workspace', createdAt, id`,
      [ws],
    )
    .filter(
      // A membership scopeId outside this workspace is unenforceable here and
      // would export as a wrong user id: leave it behind.
      (row) => row.scopeType !== "membership" || row.scopeId.startsWith(`${ws}:`),
    )
    .map((row) => portableDefinition(row, ws));
}

const SKIP_REASONS = {
  NOT_FOUND: "target not found on this instance",
  SCOPE_UNAVAILABLE: "needs Users & teams",
};
// Off with no budget workspace yet: plan against this placeholder; the write
// creates the pending Default only when something will be written.
const PENDING_WS = "\u0000pending-default";

function portableRow(entry, target) {
  const { scopeType } = entry;
  let scopeId = entry.scopeId;
  if (scopeType === "workspace") scopeId = target;
  else if (scopeType === "membership") scopeId = membershipScopeId(target, entry.scopeId);
  return { workspaceId: target, scopeType, scopeId, window: entry.window, ...limitsOf(entry) };
}

/** Why one entry can't map onto `target` (API rules), else null. */
function portableSkipReason(db, row, target, { off, ceilings }) {
  if (row.scopeType === "user") return "user budgets are not part of config files";
  try {
    if (off) requireOffScope(row);
    resolveBudgetScopeUnscoped(db, row, { workspaceId: target, off });
  } catch (err) {
    if (!(err instanceof TenancyError)) throw err;
    return SKIP_REASONS[err.code] ?? err.message;
  }
  const existing = db.get(
    `SELECT ${COLS} FROM budgets WHERE scopeType = ? AND scopeId = ? AND window = ?`,
    [row.scopeType, row.scopeId, row.window],
  );
  if (existing && existing.workspaceId !== target) return "budget exists in another workspace";
  // Same ceiling rule as the API: a raise needs instance.budgets.raise (the
  // import holds it) and skips the ceiling; any other key write obeys it.
  if (existing && isRaise(existing, row)) return null;
  return budgetCeilingErrorUnscoped(db, row, target, ceilings.get(row.window));
}

/**
 * Plan how portable definitions (already value-checked with
 * budgetDefinitionError) map onto this instance with the budget API's rules.
 * Read-only. Unmappable entries are skipped with a reason, never attached
 * elsewhere.
 * @returns {{ ws: string|null, plan: Array<{row, existing, status}>, entries: Array<{key, status, from, to}>, skipped: Array<{key, scopeType, scopeId, window, reason}> }}
 */
export function planPortableBudgetsUnscoped(db, entries) {
  const off = !isMultiUserEnabledSync(db);
  const ws = off ? offBudgetWorkspaceIdUnscoped(db) : defaultWorkspaceIdUnscoped(db);
  const target = ws ?? PENDING_WS;
  const out = { ws, plan: [], entries: [], skipped: [] };
  const ceilings = new Map(); // window → planned workspace budget
  // Workspace entries first, so key entries meet the imported ceiling.
  const ordered = [...(entries ?? [])].sort(
    (a, b) => (a.scopeType !== "workspace") - (b.scopeType !== "workspace"),
  );
  for (const entry of ordered) {
    const key = portableKey(entry);
    const row = portableRow(entry, target);
    const reason =
      !off && !ws ? "no Default workspace" : portableSkipReason(db, row, target, { off, ceilings });
    if (reason) {
      const { scopeType, window } = entry;
      out.skipped.push({ key, scopeType, scopeId: entry.scopeId ?? null, window, reason });
      continue;
    }
    if (row.scopeType === "workspace") ceilings.set(row.window, row);
    const existing = db.get(
      `SELECT ${COLS} FROM budgets WHERE scopeType = ? AND scopeId = ? AND window = ?`,
      [row.scopeType, row.scopeId, row.window],
    );
    const status = !existing ? "added" : sameLimits(existing, row) ? "unchanged" : "changed";
    out.plan.push({ row, existing, status });
    const from = existing ? portableDefinition(existing, target) : null;
    out.entries.push({ key, status, from, to: portableDefinition(row, target) });
  }
  return out;
}

/**
 * Write a plan from planPortableBudgetsUnscoped inside the caller's
 * transaction (adds and updates only), auditing every row with the import's
 * actor ({ principal, ip }). Creates the pending Default on first write.
 * @returns {number} Rows written.
 */
export function writePortableBudgetsUnscoped(db, planned, { actor = null } = {}) {
  let ws = planned.ws;
  let written = 0;
  const now = new Date().toISOString();
  const audit = (action, id, change) =>
    auditSync(
      db,
      { principal: actor?.principal ?? null, ip: actor?.ip ?? null, workspaceId: ws },
      action,
      { type: "budget", id },
      change,
    );
  for (const { row, existing, status } of planned.plan) {
    if (status === "unchanged") continue;
    ws ??= ensurePendingDefaultWorkspaceUnscoped(db);
    if (existing) {
      const after = { ...existing, ...limitsOf(row), resetAt: resetAtIso(existing.window) };
      db.run(
        "UPDATE budgets SET limitUsd = ?, limitTokens = ?, limitRequests = ?, softLimitPct = ?, resetAt = ? WHERE id = ?",
        [...MUTABLE.map((field) => after[field]), after.resetAt, existing.id],
      );
      audit("budget.update", existing.id, { before: existing, after });
    } else {
      const created = {
        ...row,
        id: uuidv4(),
        workspaceId: ws,
        scopeId: row.scopeId.replace(PENDING_WS, ws),
        resetAt: resetAtIso(row.window),
        createdByUserId: null, // the audit row names the importing actor
        createdAt: now,
      };
      db.run(
        `INSERT INTO budgets(${COLS}) VALUES(${Array(12).fill("?").join(", ")})`,
        COLS.split(", ").map((field) => created[field]),
      );
      audit("budget.create", created.id, { after: created });
    }
    written += 1;
  }
  return written;
}
