// YAN-376: audit log read API. Scoped (ADR-0002 workspace.audit.read):
// workspace owner/manager of the selected workspace, or instance owner/admin
// via oversight. Switch off: 404 (requireMultiUser). Rows hold no secrets by
// design (redacted at write).
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { resolvePrincipal } from "@/lib/users/session";
import { auditRepo } from "@/lib/db/index.js";
import { membershipRole } from "@/lib/db/repos/membershipsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const FILTERS = [
  ["workspaceId", "workspaceId"],
  ["actorUserId", "actorUserId"],
  ["action", "action"],
  ["targetType", "targetType"],
  ["targetId", "targetId"],
  ["from", "fromTs"],
  ["to", "toTs"],
];

/**
 * GET /api/audit
 * Query: page, pageSize (1-100), workspaceId, actorUserId, action (prefix),
 * targetType, targetId, from, to.
 */
export async function GET(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;

    // Bearers never authorize dashboard reads, including alongside a cookie.
    if (request.headers.get("authorization")) return json({ error: "Forbidden" }, 403);
    const principal = await resolvePrincipal(request);
    if (!principal) return json({ error: "Unauthorized" }, 401);
    if (!["session", "cli"].includes(principal.via) || principal.apiKeyId != null)
      return json({ error: "Forbidden" }, 403);

    const { searchParams } = new URL(request.url);
    const pageRaw = parseInt(searchParams.get("page"), 10);
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const sizeRaw = parseInt(searchParams.get("pageSize"), 10);
    const pageSize = Number.isNaN(sizeRaw) ? 20 : sizeRaw;
    if (page < 1) return json({ error: "Page must be >= 1" }, 400);
    if (pageSize < 1 || pageSize > 100)
      return json({ error: "PageSize must be between 1 and 100" }, 400);

    const filter = { page, pageSize };
    for (const [param, key] of FILTERS) {
      const v = searchParams.get(param);
      if (v) filter[key] = v;
    }

    // Live authority (stale claims never grant): user status/instanceRole and
    // the membership role are re-read from the DB. Instance owner/admin keep
    // cross-workspace semantics (oversight); everyone else must own or manage
    // the workspace they read — selected or active. Missing workspace or
    // non-membership is 404 (no leak); an in-workspace member/viewer is 403.
    const db = await getAdapter();
    // Direct SQL: the session-user cache (5s TTL) must not delay a revocation.
    const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [principal.userId]);
    if (user?.status !== "active") return json({ error: "Forbidden" }, 403);
    if (!can({ instanceRole: user.instanceRole }, "instance.audit.read")) {
      const target = filter.workspaceId ?? principal.activeWorkspaceId;
      const ws = target ? db.get(`SELECT id FROM workspaces WHERE id = ?`, [target]) : null;
      const role = ws ? membershipRole(db, target, principal.userId) : null;
      if (!ws || !role) return json({ error: "Workspace not found" }, 404);
      const live = { instanceRole: "user", workspaceRoles: { [target]: role } };
      if (!can(live, "workspace.audit.read", { workspaceId: target }))
        return json({ error: "Forbidden" }, 403);
      // Forced after the query copy: an actorUserId filter can never widen scope.
      filter.workspaceId = target;
    }

    const { events, pagination } = await auditRepo.list(filter);
    return json({ events, pagination });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.error("[API] Failed to read audit log:", error);
    return json({ error: "Failed to fetch audit log" }, 500);
  }
}
