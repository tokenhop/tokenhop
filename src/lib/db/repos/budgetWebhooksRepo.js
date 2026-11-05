// YAN-1831: one optional budget webhook per workspace.
// Authority: the budget rules (budgetsRepo access) re-read inside each write
// transaction — switch on, live `workspace.budgets.lower` in that workspace;
// switch off, the off-mode dashboard admin on the budget workspace.
// Secret: minted here (`whsec_` + 32 random bytes), stored as the D10
// credential leaf `data.secret` (encrypted once credential encryption is
// active), returned to the caller only from the write that minted it. Reads
// never select `data`; audit snapshots carry only `{ host, enabled }`.
// The table is never exported (config, workspace or instance export).
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TABLE_NAMES } from "@/lib/security/envelope.js";
import {
  decodeCredentialRowSync,
  encodeCredentialRowSync,
  provisionBudgetWebhookDekSync,
} from "../helpers/credentialStorage.js";
import { assertCredentialCtxCurrent, prepareCredentialCtx } from "./connectionsRepo.js";
import { assertBudgetActor, budgetWorkspaceAccess } from "./budgetsRepo.js";
import { getSettings } from "./settingsRepo.js";
import { TenancyError } from "@/lib/users/errors.js";
import { auditSync } from "@/lib/users/audit.js";
import { egressUrlError } from "open-sse/utils/pinnedFetch.js";

const TABLE = TABLE_NAMES.budgetWebhooks;
const SECRET_PREFIX = "whsec_";
const CAP = "workspace.budgets.lower";
const PUBLIC_COLS = "id, workspaceId, url, enabled, createdAt, updatedAt";

const newSecret = () => SECRET_PREFIX + randomBytes(32).toString("base64url");

const publicWebhook = (row) => ({
  url: row.url,
  enabled: row.enabled === 1,
  secretSet: true,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function snapshot(row) {
  let host = null;
  try {
    host = new URL(row.url).host;
  } catch {
    host = null;
  }
  return { host, enabled: row.enabled === 1 };
}

async function allowPrivateNetworks() {
  return (await getSettings({ secretMode: "metadata" })).budgetWebhookAllowPrivateNetworks === true;
}

function authorize(db, ctx, workspaceId, opts) {
  const access = budgetWorkspaceAccess(db, ctx, { workspaceId }, opts);
  if (!access.allowed(CAP)) throw new TenancyError("FORBIDDEN", "Budget webhook forbidden");
  return access;
}

/** `{ webhook | null, workspaceId, allowPrivateNetworks }`; never the secret. */
export async function getBudgetWebhook(ctx, { workspaceId } = {}) {
  await assertBudgetActor(ctx);
  const allowPrivate = await allowPrivateNetworks();
  const db = await getAdapter();
  return db.transaction(() => {
    const access = authorize(db, ctx, workspaceId, { list: true });
    const ws = access.workspaceId ?? null;
    const row = ws
      ? db.get(`SELECT ${PUBLIC_COLS} FROM budgetWebhooks WHERE workspaceId = ?`, [ws])
      : null;
    return {
      webhook: row ? publicWebhook(row) : null,
      workspaceId: ws,
      allowPrivateNetworks: allowPrivate,
    };
  });
}

function validateInput({ url, enabled, rotateSecret }) {
  if (url !== undefined && typeof url !== "string")
    throw new TenancyError("INVALID", "Invalid url");
  if (enabled !== undefined && typeof enabled !== "boolean")
    throw new TenancyError("INVALID", "Invalid enabled");
  if (rotateSecret !== undefined && rotateSecret !== true)
    throw new TenancyError("INVALID", "Invalid rotateSecret");
}

/**
 * Create (no webhook yet) or update the workspace webhook. Returns
 * `{ webhook, secret, created }`; `secret` is non-null only when minted.
 */
export async function saveBudgetWebhook(
  ctx,
  { workspaceId, url, enabled, rotateSecret } = {},
  { request = null } = {},
) {
  await assertBudgetActor(ctx);
  validateInput({ url, enabled, rotateSecret });
  const allowPrivate = await allowPrivateNetworks();
  if (url !== undefined) {
    const error = egressUrlError(url, { allowPrivate });
    if (error === "blocked_destination")
      throw new TenancyError("BLOCKED_DESTINATION", "Webhook destination is not allowed");
    if (error) throw new TenancyError("INVALID_URL", "Webhook URL is not valid");
  }
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return db.transaction(() => {
    const access = authorize(db, ctx, workspaceId, { create: true });
    const ws = access.workspaceId;
    assertCredentialCtxCurrent(db, credCtx);
    const existing = db.get(`SELECT ${PUBLIC_COLS} FROM budgetWebhooks WHERE workspaceId = ?`, [
      ws,
    ]);
    const now = new Date().toISOString();
    const create = !existing;
    if (create && (url === undefined || rotateSecret !== undefined))
      throw new TenancyError("INVALID", "Webhook url required");
    if (!create && url === undefined && enabled === undefined && rotateSecret === undefined)
      throw new TenancyError("INVALID", "Nothing to update");

    const id = existing?.id ?? uuidv4();
    const mint = create || rotateSecret === true;
    let secret = null;
    let data = null;
    if (mint) {
      secret = newSecret();
      if (credCtx.encrypted) provisionBudgetWebhookDekSync(db, ws, credCtx);
      data = encodeCredentialRowSync(db, { id, data: { secret } }, credCtx, {
        table: TABLE,
        workspaceId: ws,
      });
    }
    const next = {
      url: url ?? existing?.url,
      enabled: enabled === undefined ? (existing ? existing.enabled : 1) : enabled ? 1 : 0,
    };
    if (create) {
      db.run(
        `INSERT INTO budgetWebhooks (id, workspaceId, url, enabled, data, createdByUserId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ws, next.url, next.enabled, data, ctx.userId ?? null, now, now],
      );
    } else if (mint) {
      db.run(
        `UPDATE budgetWebhooks SET url = ?, enabled = ?, data = ?, updatedAt = ? WHERE id = ?`,
        [next.url, next.enabled, data, now, id],
      );
    } else {
      db.run(`UPDATE budgetWebhooks SET url = ?, enabled = ?, updatedAt = ? WHERE id = ?`, [
        next.url,
        next.enabled,
        now,
        id,
      ]);
    }
    const row = db.get(`SELECT ${PUBLIC_COLS} FROM budgetWebhooks WHERE id = ?`, [id]);
    const action = create
      ? "budget.webhook.create"
      : rotateSecret === true
        ? "budget.webhook.rotate"
        : "budget.webhook.update";
    auditSync(
      db,
      { principal: ctx, workspaceId: ws, request },
      action,
      { type: "budgetWebhook", id: ws },
      { before: existing ? snapshot(existing) : undefined, after: snapshot(row) },
    );
    return { webhook: publicWebhook(row), secret, created: create };
  });
}

/** Remove the workspace webhook; NOT_FOUND when none. */
export async function deleteBudgetWebhook(ctx, { workspaceId } = {}, { request = null } = {}) {
  await assertBudgetActor(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const access = authorize(db, ctx, workspaceId, {});
    const ws = access.workspaceId;
    const row = db.get(`SELECT ${PUBLIC_COLS} FROM budgetWebhooks WHERE workspaceId = ?`, [ws]);
    if (!row) throw new TenancyError("NOT_FOUND", "Budget webhook not found");
    db.run(`DELETE FROM budgetWebhooks WHERE id = ?`, [row.id]);
    auditSync(
      db,
      { principal: ctx, workspaceId: ws, request },
      "budget.webhook.delete",
      { type: "budgetWebhook", id: ws },
      { before: snapshot(row) },
    );
    return publicWebhook(row);
  });
}

/**
 * Delivery-only read (trusted caller: sse/services/budgetWebhook.js).
 * `{ id, url, secret }`, or null when missing or disabled. Credential errors
 * propagate (typed codes, no secret material).
 */
export async function getBudgetWebhookForDeliveryUnscoped(workspaceId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT id, workspaceId, url, enabled, data FROM budgetWebhooks WHERE workspaceId = ?`,
    [workspaceId],
  );
  if (row?.enabled !== 1) return null;
  const credCtx = await prepareCredentialCtx(db);
  const blob = decodeCredentialRowSync(db, row, credCtx, {
    table: TABLE,
    workspaceId: row.workspaceId,
  });
  if (typeof blob.secret !== "string" || !blob.secret) return null;
  return { id: row.id, url: row.url, secret: blob.secret };
}
