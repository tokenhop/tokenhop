// Usage route scope (YAN-370, plan D1/D10; YAN-376 view/user/key filters).
// Switch off or a single active user: null, and the route passes it straight
// to the readers — their null branch is today's unscoped view. Switch on with
// 2+ users: the principal's usage scope for the selected workspace, applied by
// the readers' WHERE builder. Response shapes are unchanged either way.
//
// Filters (query params):
// - `view=me|workspace`: own rows vs the whole workspace. Default is the
//   caller's widest view — `me` for member/viewer, `workspace` for the
//   workspace's owner/manager and instance-admin oversight. A member/viewer
//   asking for `workspace` gets 403.
// - `userId=<id>`: one user's rows. Own id is always fine; another user's id
//   is a manager view. The target must be a live (active, non-pending) member
//   of the workspace — unknown or foreign users are 404, never leaked.
// - `apiKeyId=<id>`: rows made with one gateway key. The key must belong to this workspace (including revoked keys for
//   historical attribution) — anything else is 404. A member may filter by their own user key only; service keys (userId
//   null) and other users' keys are manager views.
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { membershipRole } from "@/lib/db/repos/membershipsRepo.js";
import { principalScope } from "@/lib/users/workspaceScope.js";
import { can } from "@/lib/users/principal.js";

const json = (error, status) => NextResponse.json({ error }, { status });

const INSTANCE_ADMIN = (ctx) => ctx.instanceRole === "owner" || ctx.instanceRole === "admin";
const MANAGER = (role) => role === "owner" || role === "manager";

/** Active, non-pending user with a live membership in the workspace. */
function liveMember(db, workspaceId, userId) {
  const u = db.get(`SELECT status, instanceRole FROM users WHERE id = ?`, [userId]);
  return (
    u?.status === "active" &&
    u.instanceRole !== "pending" &&
    membershipRole(db, workspaceId, userId) !== null
  );
}

/** Historical attribution survives pause, expiry and revocation. */
function historicalKey(db, workspaceId, id) {
  return db.get(`SELECT userId FROM apiKeys WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
}

/**
 * Resolve the caller's usage scope.
 * @returns {Promise<null|Response|{ ctx: object, workspaceId: string, userId: string|null, apiKeyId: string|null, bodies: boolean }>}
 * - null: switch off / ≤1 active user — pass straight to readers (unscoped).
 * - Response: 400 (`view` not me|workspace), 401 (no principal), 403 (member
 *   asking for the workspace-wide view), or 404 (`?workspaceId=` outside the
 *   caller's reach, unknown/foreign user or key — no existence leak, matching
 *   workspaceScope conventions).
 * - object: `userId` narrows the reader to one user's rows; `apiKeyId` to one
 *   gateway key's rows; both null means the whole workspace (its
 *   owner/manager, or an instance owner/admin exercising oversight). `bodies`
 *   mirrors D10.
 */
export async function usageScope(request) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  const { ctx } = scope;
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  const wantedUser = params.get("userId");
  const wantedKey = params.get("apiKeyId");
  if (view !== null && view !== "me" && view !== "workspace") {
    return json("Invalid view", 400);
  }
  const workspaceId =
    params.get("workspaceId") || ctx.activeWorkspaceId || ctx.workspaceIds[0] || null;
  // can() covers instance owner/admin oversight (ADMIN_ANY_WORKSPACE) and
  // every workspace role — including viewer — holds workspace.usage.read.
  if (!workspaceId || !can(ctx, "workspace.usage.read", { workspaceId })) {
    return json("Workspace not found", 404);
  }
  const role = ctx.workspaceRoles?.[workspaceId];
  const manager = MANAGER(role);
  const canFilterOthers = manager || INSTANCE_ADMIN(ctx);
  // Workspace-wide stays a manager (or instance-admin oversight) view.
  if (view === "workspace" && !manager && !INSTANCE_ADMIN(ctx)) {
    return json("Forbidden", 403);
  }

  const db = await getAdapter();

  // Target user: explicit `userId` beats `view`; member/viewer defaults to self.
  let userId = null;
  if (wantedUser) {
    // Another user's rows are a manager view; everyone may name themselves.
    if (wantedUser !== ctx.userId && (view === "me" || !canFilterOthers))
      return json("User not found", 404);
    if (!liveMember(db, workspaceId, wantedUser)) return json("User not found", 404);
    userId = wantedUser;
  } else if (view === "me" || (!manager && !INSTANCE_ADMIN(ctx))) {
    userId = ctx.userId;
  }

  // Target key: live key of this workspace; member restricted to own user key.
  let apiKeyId = null;
  if (wantedKey) {
    const key = historicalKey(db, workspaceId, wantedKey);
    const ownUserKey = key?.userId != null && key.userId === ctx.userId;
    if (!key || (!canFilterOthers && !ownUserKey)) return json("API key not found", 404);
    apiKeyId = wantedKey;
  }

  if (manager) return { ctx, workspaceId, userId, apiKeyId, bodies: true };
  // Instance owner/admin oversight outside their own management: the whole
  // workspace's usage metadata, never other people's request bodies
  // (ADR-0002: admin powers are management, not reading others' content).
  return { ctx, workspaceId, userId, apiKeyId, bodies: false };
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
