// Shared prelude for the YAN-372 budget routes: switch (404 off unless the
// route allows off mode), same-origin, JSON for mutators, full browser
// session, fixed error messages (repo text is never echoed), and the public
// row projection (no createdByUserId).
// YAN-1829 off mode (workspace routes): the dashboard admin manages workspace
// and key budgets on Default — an owner/admin session, or login-off local
// access (the repo re-checks the live user row), on established installs; on
// pristine ones the switch control's single-admin proof (session or login-off
// local, see pristineAdminPrincipal). Gateway credentials never authorize.
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { getPrincipal, pristineAdminPrincipal } from "@/lib/users/session.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { getAdapter } from "@/lib/db/driver.js";
import { listBudgetNoticesUnscoped } from "@/lib/db/repos/budgetNoticesRepo.js";
import { windowStart } from "@/lib/users/budgets.js";
import { noticeSignature } from "@/shared/utils/budgetNotice.js";
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

// Switch-off actor (budgetMode "off"): see the header comment. Gateway
// credentials are refused on every install type, before any principal read.
async function offPrincipal(request) {
  if (GATEWAY_HEADERS.some((h) => request.headers.has(h))) return unauthorized();
  if (await isUserSecurityEnforced()) {
    const principal = await getPrincipal();
    if (principal?.via !== "session" && principal?.via !== "local") return unauthorized();
    return { principal: { ...principal, budgetMode: "off" } };
  }
  // Same proof as the switch control (live sub-session checks, single admin),
  // without the CLI token: budgets are browser-session management.
  const principal = await pristineAdminPrincipal(request, { cli: false });
  if (!principal) return unauthorized();
  return { principal: { ...principal, budgetMode: "off" } };
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

// YAN-1830: which notices were sent for the current window. A claim counts
// only for this window and the budget's current limits (signature), matching
// the guard: a changed limit re-arms the notice and clears the marker.
function noticesFor(budget, claims, now) {
  const start = new Date(windowStart(budget.window, now)).toISOString();
  const sent = (kind) =>
    claims.some(
      (c) =>
        c.budgetId === budget.id &&
        c.kind === kind &&
        c.windowStart === start &&
        c.signature === noticeSignature(budget, kind),
    );
  return { soft: sent("soft"), hard: sent("hard") };
}

/**
 * Public rows plus settled `spent` and the current window's sent `notices`
 * ({ soft, hard }) for each budget (GET only). Rows are already authorized
 * by the repo list; a failed claim read shows no markers.
 */
export async function withSpent(rows) {
  const db = await getAdapter();
  const now = Date.now();
  let claims = [];
  try {
    claims = listBudgetNoticesUnscoped(
      db,
      rows.map((b) => b.id),
    );
  } catch (e) {
    console.warn("[budgets] notice read failed:", e?.message);
  }
  return rows.map((b) => ({
    ...publicBudget(b),
    spent: spentFor(db, b, now),
    notices: noticesFor(b, claims, now),
  }));
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
