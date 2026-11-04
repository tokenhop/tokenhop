// Shared prelude for the YAN-372 budget routes: switch (404 off unless the
// route allows off mode), same-origin, JSON for mutators, full browser
// session, fixed error messages (repo text is never echoed), and the public
// row projection (no createdByUserId).
// YAN-1829 off mode (workspace routes): the dashboard admin manages workspace
// and key budgets on Default — an owner/admin session on established
// installs; on pristine ones a legacy session or login-off local access,
// never a gateway credential.
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { getPrincipal, hasValidSession, singleUserMode } from "@/lib/users/session.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { getAdapter } from "@/lib/db/driver.js";
import { spentFor } from "@/sse/services/budgetGuard.js";

export const MAX_BODY = 2048;

const ERRORS = {
  NOT_FOUND: [404, "Budget not found"],
  FORBIDDEN: [403, "Forbidden"],
  INVALID: [400, "Invalid request"],
  BUDGET_EXISTS: [409, "A budget already exists for this scope and window"],
  SCOPE_UNAVAILABLE: [400, "This budget scope needs Users & teams"],
};

export function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: err.code.toLowerCase() }, hit[0]);
  if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
  return json({ error: "Internal error" }, 500);
}

const GATEWAY_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];
const unauthorized = () => ({ res: json({ error: "Unauthorized" }, 401) });

// Switch-off actor (budgetMode "off"): see the header comment.
async function offPrincipal(request) {
  if (await isUserSecurityEnforced()) {
    const principal = await getPrincipal();
    if (principal?.via !== "session") return unauthorized();
    return { principal: { ...principal, budgetMode: "off" } };
  }
  if (GATEWAY_HEADERS.some((h) => request.headers.has(h))) return unauthorized();
  const via = (await hasValidSession(request))
    ? "session"
    : (await singleUserMode(await getSettings({ secretMode: "metadata" })))
      ? "local"
      : null;
  if (!via) return unauthorized();
  return {
    principal: { userId: null, instanceRole: "owner", workspaceIds: [], via, budgetMode: "off" },
  };
}

export async function gate(request, { body = false, offAllowed = false } = {}) {
  const on = await isMultiUserEnabled();
  // Same 404 body as requireMultiUser, without a second switch read.
  if (!on && !offAllowed) return { res: json({ error: "Not found" }, 404) };
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  if (!on) return offPrincipal(request);
  const principal = await getPrincipal();
  if (principal?.via !== "session") return unauthorized();
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
