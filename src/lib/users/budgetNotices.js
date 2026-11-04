// Budget notices on the usage stream (YAN-1830): who may receive a notice,
// and the exact fields it carries. The audience mirrors the budget GET routes
// (budgetRoutes.gate + budgetsRepo.listBudgets/listUserBudgets), re-resolved
// from the stream's request on every notice, so a revoked session or role
// stops notices at once. Fails closed: any error means "not this viewer".
import { getAdapter } from "@/lib/db/driver.js";
import {
  defaultWorkspaceIdUnscoped,
  offBudgetWorkspaceIdUnscoped,
} from "@/lib/db/repos/ownership.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { pristineAdminPrincipal, resolvePrincipal } from "@/lib/users/session.js";
import { offScoped } from "@/sse/services/budgetSubject.js";

const GATEWAY_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

/**
 * Wire shape of a notice: a strict allow-list. scopeId is the same id the
 * budget GET shows these viewers (key id, user id, membership id, grant id);
 * no workspace id, key material, hashes or secrets.
 */
export function publicNotice(n) {
  return {
    id: n.id,
    kind: n.kind,
    budgetId: n.budgetId,
    scopeType: n.scopeType,
    scopeId: n.scopeId,
    window: n.window,
    limitUsd: n.limitUsd,
    limitTokens: n.limitTokens,
    limitRequests: n.limitRequests,
    softLimitPct: n.softLimitPct,
    spent: { usd: n.spent.usd, tokens: n.spent.tokens, requests: n.spent.requests },
    windowStart: n.windowStart,
    resetAt: n.resetAt,
    at: n.at,
  };
}

// Switch off: the dashboard admin of the off-mode budget workspace manages
// its workspace and key budgets (budgetRoutes.offPrincipal + offAccess).
async function offAdminMayRead(request, notice) {
  if (!offScoped(notice)) return false;
  const db = await getAdapter();
  const ws = offBudgetWorkspaceIdUnscoped(db);
  if (!ws || notice.workspaceId !== ws) return false;
  if (await isUserSecurityEnforced()) {
    const ctx = await resolvePrincipal(request);
    if (ctx?.via !== "session" && ctx?.via !== "local") return false;
    if (!["owner", "admin"].includes(ctx.instanceRole)) return false;
    // An admin acts on the real Default only as a member (offAccess).
    return ws !== defaultWorkspaceIdUnscoped(db) || Boolean(ctx.workspaceRoles?.[ws]);
  }
  return (await pristineAdminPrincipal(request, { cli: false })) !== null;
}

/**
 * May the viewer behind the stream's `request` see this notice?
 * Switch on: a browser session holding workspace.budgets.read in the
 * budget's workspace — the stream's selected workspace when it is scoped —
 * or, for user-level budgets, instance.budgets.raise. Switch off: the
 * dashboard admin, for workspace/key budgets of the off-mode workspace.
 * @param {Request} request the stream request (cookies/headers)
 * @param {object} notice the guard's notice (with workspaceId)
 * @param {{ workspaceId?: string|null }} [stream] the stream's usage scope
 */
export async function canReceiveNotice(request, notice, stream = null) {
  try {
    if (GATEWAY_HEADERS.some((h) => request.headers.has(h))) return false;
    if (!(await isMultiUserEnabled())) return await offAdminMayRead(request, notice);
    const ctx = await resolvePrincipal(request);
    if (ctx?.via !== "session") return false;
    if (notice.workspaceId == null) {
      return notice.scopeType === "user" && can(ctx, "instance.budgets.raise");
    }
    if (stream?.workspaceId && stream.workspaceId !== notice.workspaceId) return false;
    return can(ctx, "workspace.budgets.read", { workspaceId: notice.workspaceId });
  } catch {
    return false;
  }
}
