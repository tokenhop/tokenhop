// YAN-701 move items between workspaces the actor manages. IDs are retained
// and ownership is rewritten in place inside ONE synchronous transaction:
// live authority and the conflict plan are recomputed in the transaction, so
// any conflict, key failure or audit failure rolls everything back. Credentials
// are decoded under their source coordinates and re-sealed for the target
// (same row id, new workspaceId → new AAD, target DEK). Usage history is
// untouched. Plaintext never leaves the transaction and is never logged.
import { getAdapter } from "../db/driver.js";
import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";
import {
  clearCredentialCache,
  decodeCredentialRowSync,
  encodeCredentialRowSync,
  provisionMoveTargetDekSync,
} from "../db/helpers/credentialStorage.js";
import { assertCredentialCtxCurrent, prepareCredentialCtx } from "../db/repos/connectionsRepo.js";
import { auditSync } from "./audit.js";
import { buildPlan, kvKey } from "./workspaceMovePlan.js";
import { authorizeMove, moveError, validateMoveInput } from "./workspaceMoveShared.js";

export { MOVE_TYPES, MAX_ITEMS } from "./workspaceMoveShared.js";

async function loadDeps() {
  // Lazy: grants.js pulls in the provider registry; keep it off the static graph.
  const { resolveSharing, getSharingWarning } = await import("./grants.js");
  return { resolveSharing, getSharingWarning };
}

function planInTx(db, ctx, input, deps) {
  const { target } = authorizeMove(
    db,
    ctx,
    input.sourceWorkspaceId,
    input.targetWorkspaceId,
    input.items,
  );
  return buildPlan(db, { ...input, targetKind: target.kind }, deps);
}

const view = (plan) => ({ conflicts: plan.conflicts, warnings: plan.warnings });

/**
 * Dry run: conflicts and warnings, never a mutation.
 * @param {object} ctx session principal
 * @param {{sourceWorkspaceId:string,targetWorkspaceId:string,items:Array<{type:string,id:string}>}} input
 * @returns {Promise<{preview:true,moved:[],conflicts:object[],warnings:object[]}>}
 */
export async function planWorkspaceMove(ctx, input) {
  const clean = validateMoveInput(input);
  const db = await getAdapter();
  const deps = await loadDeps();
  const plan = db.transaction(() => planInTx(db, ctx, clean, deps));
  return { preview: true, moved: [], ...view(plan) };
}

function moveCredentialRow(db, credCtx, table, row, targetId) {
  const blob = decodeCredentialRowSync(db, row, credCtx, { table, workspaceId: row.workspaceId });
  const data = encodeCredentialRowSync(db, { id: row.id, data: blob }, credCtx, {
    table,
    workspaceId: targetId,
  });
  db.run(`UPDATE ${table} SET data = ?, workspaceId = ?, updatedAt = ? WHERE id = ?`, [
    data,
    targetId,
    new Date().toISOString(),
    row.id,
  ]);
}

// Dense 1..N priority per (workspace, provider), same order rule as the repo.
function renumber(db, provider, workspaceId) {
  const rows = db.all(
    `SELECT id FROM providerConnections WHERE provider = ? AND workspaceId = ?
     ORDER BY COALESCE(priority, 0) ASC, updatedAt DESC, id ASC`,
    [provider, workspaceId],
  );
  rows.forEach((r, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, r.id]);
  });
}

function moveStrategy(db, src, dst, comboId, now) {
  const read = (ws) =>
    parseJson(db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [ws])?.data, {});
  const from = read(src);
  const strategies = from.comboStrategies;
  if (!strategies || typeof strategies !== "object" || !Object.hasOwn(strategies, comboId)) return;
  const { [comboId]: strategy, ...rest } = strategies;
  const to = read(dst);
  const write = `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
    ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`;
  db.run(write, [src, stringifyJson({ ...from, comboStrategies: rest }), now]);
  db.run(write, [
    dst,
    stringifyJson({
      ...to,
      comboStrategies: { ...(to.comboStrategies || {}), [comboId]: strategy },
    }),
    now,
  ]);
}

function applyOps(db, ctx, credCtx, plan, src, dst, items) {
  const now = new Date().toISOString();
  // Only now (live auth, conflicts and confirmation all passed) may the target
  // get a DEK, and only when a credential row is actually re-sealed for it.
  if (credCtx.encrypted && plan.ops.some((o) => o.type === "connection" || o.type === "node")) {
    provisionMoveTargetDekSync(db, dst, credCtx);
  }
  const touchedProviders = new Set();
  // Nodes first: a moving connection's provider id may be a moving node's id.
  const order = { node: 0, connection: 1 };
  const ops = [...plan.ops].sort((a, b) => (order[a.type] ?? 2) - (order[b.type] ?? 2));
  for (const op of ops) {
    if (op.type === "node") {
      moveCredentialRow(db, credCtx, "providerNodes", op.row, dst);
    } else if (op.type === "connection") {
      moveCredentialRow(db, credCtx, "providerConnections", op.row, dst);
      touchedProviders.add(op.row.provider);
      const tail = db.get(
        `SELECT COALESCE(MAX(priority), 0) AS n FROM providerConnections WHERE provider = ? AND workspaceId = ? AND id != ?`,
        [op.row.provider, dst, op.id],
      ).n;
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [tail + 1, op.id]);
      if (op.grants > 0) {
        db.run(
          `UPDATE connectionGrants SET revokedAt = ? WHERE connectionId = ? AND revokedAt IS NULL`,
          [Date.now(), op.id],
        );
      }
    } else if (op.type === "combo") {
      db.run(
        `UPDATE combos SET workspaceId = ?, updatedAt = ?, sortOrder = (SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM combos WHERE workspaceId = ?) WHERE id = ?`,
        [dst, now, dst, op.id],
      );
      moveStrategy(db, src, dst, op.id, now);
    } else if (op.type === "apiKey") {
      db.run(`UPDATE apiKeys SET workspaceId = ? WHERE id = ? AND workspaceId = ?`, [
        dst,
        op.id,
        src,
      ]);
      // Key-scoped budgets follow their key. Ids, limits, windows and resetAt
      // are untouched; spend is derived from usageHistory by apiKeyId, so the
      // ledger and the in-memory window counters carry over unchanged.
      db.run(`UPDATE budgets SET workspaceId = ? WHERE scopeType = 'key' AND scopeId = ?`, [
        dst,
        op.id,
      ]);
    } else {
      db.run(`UPDATE kv SET key = ? WHERE scope = ? AND key = ?`, [
        kvKey(dst, op.id),
        op.scope,
        kvKey(src, op.id),
      ]);
    }
    auditSync(
      db,
      { principal: ctx, workspaceId: src },
      "workspace.move",
      { type: op.type, id: op.id },
      { before: { workspaceId: src }, after: { workspaceId: dst } },
    );
  }
  for (const provider of touchedProviders) {
    renumber(db, provider, src);
    renumber(db, provider, dst);
  }
  return items.map(({ type, id }) => ({ type, id }));
}

/**
 * Move the items. Conflicts → MOVE_CONFLICT (nothing moves); warnings without
 * `confirm: true` → CONFIRM_REQUIRED; otherwise one atomic transaction.
 * @returns {Promise<{preview:false,moved:object[],conflicts:[],warnings:object[]}>}
 */
export async function moveWorkspaceItems(ctx, input) {
  const clean = validateMoveInput(input);
  const confirm = input?.confirm === true;
  const db = await getAdapter();
  const deps = await loadDeps();
  // Async prep (master key) strictly before the synchronous transaction.
  const credCtx = await prepareCredentialCtx(db);
  const { src, dst } = { src: clean.sourceWorkspaceId, dst: clean.targetWorkspaceId };
  let result;
  try {
    result = db.transaction(() => {
      assertCredentialCtxCurrent(db, credCtx);
      const plan = planInTx(db, ctx, clean, deps);
      if (plan.conflicts.length > 0) {
        moveError("MOVE_CONFLICT", "Move has conflicts", { conflicts: plan.conflicts });
      }
      if (plan.warnings.length > 0 && !confirm) {
        moveError("CONFIRM_REQUIRED", "Move needs confirmation", { warnings: plan.warnings });
      }
      const moved = applyOps(db, ctx, credCtx, plan, src, dst, clean.items);
      return { preview: false, moved, conflicts: [], warnings: plan.warnings };
    });
  } finally {
    // Commit or rollback: a DEK provisioned (and cached) inside a rolled-back
    // transaction must not survive in memory.
    clearCredentialCache(db, dst);
  }
  // Post-commit cache hygiene (never inside the transaction).
  const [{ resetAccountSelection }, { clearApiKeyPrincipalCache }, { bumpBudgetsGeneration }] =
    await Promise.all([
      import("@/sse/services/auth.js"),
      import("@/lib/auth/apiKeyPrincipal.js"),
      import("./budgets.js"),
    ]);
  // Rotating state belongs to (workspace, provider); reset per moved provider
  // (resetAccountSelection is provider-keyed, not per-workspace, hence all or
  // one target provider). API-key moves clear the digest cache via
  // clearApiKeyPrincipalCache.
  if (result.moved.some((m) => m.type === "connection")) resetAccountSelection();
  if (result.moved.some((m) => m.type === "apiKey")) {
    clearApiKeyPrincipalCache();
    bumpBudgetsGeneration(); // gateway guard reloads budget rows (workspaceId changed)
  }
  return result;
}
