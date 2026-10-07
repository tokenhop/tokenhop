// OAuth route scoping (YAN-366, ADR-0001/0002). Every helper returns null
// when `principalScope()` is null (switch off, or at most one active user):
// the caller then keeps today's unscoped path. Default target workspace is the
// principal's personal one; `?workspaceId=` must be a workspace where they
// hold `workspace.connections.manage`.
import { NextResponse } from "next/server";
import { createConnection, listWorkspaces } from "@/lib/db/index.js";
import { createProviderConnectionUnscoped } from "@/models";
import { isLocalRequest } from "@/dashboardGuard.js";
import { can } from "@/lib/users/principal.js";
import { principalScope } from "@/lib/users/workspaceScope.js";
import { bindingFor, ownerMatches } from "./pendingBinding.js";

const CAP = "workspace.connections.manage";
const json = (body, status) => NextResponse.json(body, { status });

/** @returns {Promise<null|Response|{ ctx: object, workspaceId: string }>} */
export async function oauthScope(request) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  const { ctx } = scope;
  const wanted = new URL(request.url).searchParams.get("workspaceId");
  let workspaceId = wanted;
  if (!workspaceId) {
    const mine = await listWorkspaces(ctx);
    workspaceId = mine.find((w) => w.kind === "personal")?.id;
  }
  if (!workspaceId || !ctx.workspaceIds.includes(workspaceId)) {
    return json({ error: "Workspace not found" }, 404);
  }
  if (!can(ctx, CAP, { workspaceId })) return json({ error: "Forbidden" }, 403);
  return { ctx, workspaceId };
}

/**
 * Completion step of a flow bound at start: the caller must be the binding's
 * owner and the connection lands in the binding's workspace. No binding falls
 * back to `oauthScope`; required unbound flows are instance-owner-only.
 * @returns {Promise<null|Response|{ ctx: object, workspaceId: string, binding: object|null }>}
 */
export async function requireFlowOwner(request, key, { required = false } = {}) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  const binding = bindingFor(key);
  if (binding) {
    if (!ownerMatches(binding, scope.ctx.userId)) return json({ error: "Forbidden" }, 403);
    if (!can(scope.ctx, CAP, { workspaceId: binding.workspaceId })) {
      return json({ error: "Forbidden" }, 403);
    }
    return { ctx: scope.ctx, workspaceId: binding.workspaceId, binding };
  }
  if (required && scope.ctx.instanceRole !== "owner") {
    return json({ error: "OAuth session not found; restart the login flow" }, 400);
  }
  const fallback = await oauthScope(request);
  return fallback && !(fallback instanceof Response) ? { ...fallback, binding: null } : fallback;
}

/** Loopback-only actions: refuse remote callers once the scoped view is active. */
export async function hostOnlyRefusal(request) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  if (isLocalRequest(request)) return null;
  return json(
    { error: "This flow can only be started from the host dashboard", hostOnly: true },
    403,
  );
}

export function createIn(scope, data) {
  return scope
    ? createConnection(scope.ctx, scope.workspaceId, data)
    : createProviderConnectionUnscoped(data);
}
