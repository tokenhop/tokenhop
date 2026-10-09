// Shared prelude for the YAN-372 budget routes: switch (404 off), same-origin,
// JSON for mutators, full browser session, fixed error messages (repo text is
// never echoed), and the public row projection (no createdByUserId).
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { getAdapter } from "@/lib/db/driver.js";
import { spentFor } from "@/sse/services/budgetGuard.js";

export const MAX_BODY = 2048;

const ERRORS = {
  NOT_FOUND: [404, "Budget not found"],
  FORBIDDEN: [403, "Forbidden"],
  INVALID: [400, "Invalid request"],
  BUDGET_EXISTS: [409, "A budget already exists for this scope and window"],
};

export function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: err.code.toLowerCase() }, hit[0]);
  if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
  return json({ error: "Internal error" }, 500);
}

export async function gate(request, { body = false } = {}) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const principal = await getPrincipal();
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  return { principal };
}

/** Parsed JSON object whose keys are all allowed, else null (→ 400). */
export async function readBody(request, keys) {
  const body = await readJsonBody(request, { max: MAX_BODY });
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return Object.keys(body).every((k) => keys.includes(k)) ? body : null;
}

export const badRequest = () => json({ error: "Invalid request", code: "invalid_request" }, 400);

/** Public rows plus settled `spent` for each budget's current window (GET only). */
export async function withSpent(rows) {
  const db = await getAdapter();
  const now = Date.now();
  return rows.map((b) => ({ ...publicBudget(b), spent: spentFor(db, b, now) }));
}

export const publicBudget = (b) => ({
  id: b.id,
  scopeType: b.scopeType,
  scopeId: b.scopeId,
  window: b.window,
  limitUsd: b.limitUsd,
  limitTokens: b.limitTokens,
  limitRequests: b.limitRequests,
  softLimitPct: b.softLimitPct,
  resetAt: b.resetAt,
  createdAt: b.createdAt,
});
