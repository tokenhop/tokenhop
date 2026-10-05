// Audit helper (YAN-367 Lane B). DENY-BY-DEFAULT allow-list: only these keys
// persist in before/after, nested included. Secret material never persists.
// NEVER throws; insert failures only console.warn.
import { getClientIp } from "@/lib/auth/loginLimiter";
import { insert } from "@/lib/db/repos/auditRepo.js";

const ALLOWED = new Set([
  "id",
  "userId",
  "actorUserId",
  "keyId",
  "workspaceId",
  "name",
  "email",
  "login",
  "provider",
  "role",
  "status",
  "enabled",
  "allowedModels",
  "keyPrefix",
  "reason",
  "days",
  "from",
  "to",
  "count",
  "method",
  "path",
  "capability",
  "keyNames",
]);

const TRUNCATE = 4096;

function scrub(value, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out = value.map((v) => scrub(v, depth + 1)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!ALLOWED.has(k)) continue;
      const s = scrub(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof value === "string") return value.length > TRUNCATE ? value.slice(0, TRUNCATE) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function encodeSnapshot(obj) {
  if (obj === null || obj === undefined) return null;
  const scrubbed = scrub(obj);
  if (scrubbed === undefined) return null;
  return JSON.stringify(scrubbed);
}

/**
 * Record a graded security/admin event. Fire-and-forget: never throws.
 * @param {{ principal?: { userId, apiKeyId, via }|null, ip?: string, request?: Request, workspaceId?: string|null }} [ctx]
 * @param {string} action "resource.verb"
 * @param {{ type?: string, id?: string }|null} [target]
 * @param {{ before?: object, after?: object, result?: string }} [opts]
 */
export async function audit(ctx = {}, action, target = null, { before, after, result } = {}) {
  try {
    const principal = ctx?.principal ?? null;
    let ip = ctx?.ip ?? null;
    if (!ip && ctx?.request) {
      try {
        ip = getClientIp(ctx.request) || null;
      } catch {
        ip = null;
      }
    }
    await insert({
      actorUserId: principal?.userId ?? null,
      actorApiKeyId: principal?.apiKeyId ?? null,
      via: principal?.via ?? "system",
      ip,
      workspaceId: ctx?.workspaceId ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id != null ? String(target.id) : null,
      before: encodeSnapshot(before),
      after: encodeSnapshot(after),
      result: result ?? "success",
    });
  } catch (err) {
    console.warn("[audit]", err?.message ?? err);
  }
}

export const __test__ = { scrub, encodeSnapshot, ALLOWED };
