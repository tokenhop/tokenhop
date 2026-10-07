// Usage route scope (YAN-370, plan D1/D10). Switch off or a single active
// user: null, and the route passes it straight to the readers — their null
// branch is today's unscoped view. Switch on with 2+ users: the principal's
// usage scope for the selected workspace, applied by the readers' WHERE
// builder. Response shapes are unchanged either way.
import { NextResponse } from "next/server";
import { principalScope } from "@/lib/users/workspaceScope.js";
import { can } from "@/lib/users/principal.js";

const json = (error, status) => NextResponse.json({ error }, { status });

const INSTANCE_ADMIN = (ctx) => ctx.instanceRole === "owner" || ctx.instanceRole === "admin";

/**
 * Resolve the caller's usage scope.
 * @returns {Promise<null|Response|{ ctx: object, workspaceId: string, userId: string|null, bodies: boolean }>}
 * - null: switch off / ≤1 active user — pass straight to readers (unscoped).
 * - Response: 401 (no principal) or 404 (`?workspaceId=` outside the caller's
 *   reach — no existence leak, matching workspaceScope conventions).
 * - object: `userId` narrows the reader to the caller's own rows (workspace
 *   member/viewer); null means the whole workspace (its owner/manager, or an
 *   instance owner/admin exercising oversight). `bodies` mirrors D10.
 */
export async function usageScope(request) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  const { ctx } = scope;
  const wanted = new URL(request.url).searchParams.get("workspaceId");
  const workspaceId = wanted || ctx.activeWorkspaceId || ctx.workspaceIds[0] || null;
  // can() covers instance owner/admin oversight (ADMIN_ANY_WORKSPACE) and
  // every workspace role — including viewer — holds workspace.usage.read.
  if (!workspaceId || !can(ctx, "workspace.usage.read", { workspaceId })) {
    return json("Workspace not found", 404);
  }
  const role = ctx.workspaceRoles?.[workspaceId];
  if (role === "owner" || role === "manager") {
    return { ctx, workspaceId, userId: null, bodies: true };
  }
  // Instance owner/admin oversight outside their own management: the whole
  // workspace's usage metadata, never other people's request bodies
  // (ADR-0002: admin powers are management, not reading others' content).
  if (INSTANCE_ADMIN(ctx)) return { ctx, workspaceId, userId: null, bodies: false };
  return { ctx, workspaceId, userId: ctx.userId, bodies: false };
}

/**
 * Per-row body entitlement (plan D10): the row's own user or a manager/owner
 * member of the row's workspace. Instance admins without that membership get
 * metadata only. Switch off never calls this — the request-details route keeps
 * today's full redaction there.
 */
export function canSeeBodies(ctx, row) {
  if (!ctx) return false;
  if (row?.userId && row.userId === ctx.userId) return true;
  const role = ctx.workspaceRoles?.[row?.workspaceId];
  return role === "owner" || role === "manager";
}
