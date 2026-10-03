// Workspace scope for connection and node routes (YAN-361, ADR-0001/0002).
// Switch off (or before any user exists): null, and the route keeps today's
// unscoped path. Switch on: the principal plus, for collection routes, the
// selected workspace. `?workspaceId=` is only a selector: it must be one of
// the principal's workspaces, and the repos re-verify membership in SQL.
import { NextResponse } from "next/server";
import { countActiveUsersUnscoped, getMeta, listConnections } from "@/lib/db/index.js";
import { getProviderConnectionsUnscoped } from "@/lib/localDb";
import { isMultiUserEnabled } from "./featureSwitch.js";
import { can } from "./principal.js";
import { getPrincipal } from "./session.js";

const json = (error, status) => NextResponse.json({ error }, { status });

/** @returns {Promise<null|Response|{ ctx: import("./principal.js").Principal }>} */
export async function principalScope() {
  if (!(await isMultiUserEnabled())) return null;
  // The guard authenticated the request. With at most one active user the
  // caller can only be the owner, whose view is today's unscoped one.
  // ponytail: single-user keeps the unscoped view even after bootstrap; the
  // scoped view starts at the second user (handbook: UI unchanged until then).
  if ((await countActiveUsersUnscoped()) <= 1) return null;
  const ctx = await getPrincipal();
  return ctx ? { ctx } : json("Unauthorized", 401);
}

/**
 * Collection routes: the workspace to list or create in, with `capability`
 * held there. Default: the shared Default workspace when the principal is a
 * member (today's data), else their active workspace.
 * @returns {Promise<null|Response|{ ctx: object, workspaceId: string }>}
 */
export async function workspaceScope(request, capability) {
  const scope = await principalScope();
  if (!scope || scope instanceof Response) return scope;
  const { ctx } = scope;
  const wanted = new URL(request.url).searchParams.get("workspaceId");
  const fallback = await getMeta("defaultWorkspaceId");
  const workspaceId =
    wanted || (ctx.workspaceIds.includes(fallback) ? fallback : ctx.activeWorkspaceId);
  if (!workspaceId || !ctx.workspaceIds.includes(workspaceId)) {
    return json("Workspace not found", 404);
  }
  if (!can(ctx, capability, { workspaceId })) return json("Forbidden", 403);
  return { ctx, workspaceId };
}

/** Item routes: null when the principal holds `capability` in the row's workspace. */
export function denyRow(scope, capability, row) {
  if (!scope || can(scope.ctx, capability, { workspaceId: row.workspaceId })) return null;
  return json("Forbidden", 403);
}

/**
 * Item routes: load a row through `getScoped(ctx, id)` (switch on) or
 * `getUnscoped(id)` (off), then require `capability` in its workspace.
 * Another workspace's row is a 404, a member without the role a 403.
 * @returns {Promise<Response|{ scope: object|null, row: object }>}
 */
export async function loadScoped(capability, id, getScoped, getUnscoped, notFound) {
  const scope = await principalScope();
  if (scope instanceof Response) return scope;
  const row = scope ? await getScoped(scope.ctx, id) : await getUnscoped(id);
  if (!row) return json(notFound, 404);
  return denyRow(scope, capability, row) ?? { scope, row };
}

/**
 * Collection routes that only read or touch connections: the selected
 * workspace's rows (switch on, 2+ users), else today's unscoped list.
 * @returns {Promise<Response|{ scope: object|null, connections: object[] }>}
 */
export async function scopedConnections(request, capability, filter = {}) {
  const scope = await workspaceScope(request, capability);
  if (scope instanceof Response) return scope;
  const connections = scope
    ? await listConnections(scope.ctx, scope.workspaceId, filter)
    : await getProviderConnectionsUnscoped(filter);
  return { scope, connections };
}

// providerSpecificData keys that carry credentials (ADR-0002: metadata.read
// never returns secrets). Switch on only; off keeps today's response shape.
const PSD_SECRETS = ["apiKey", "copilotToken", "mimoPassToken", "clientSecret", "secretAccessKey"];

/** A connection for a scoped response: provider-specific secrets removed. */
export function redactConnection(scope, connection) {
  const psd = connection?.providerSpecificData;
  if (!scope || !psd || !PSD_SECRETS.some((k) => k in psd)) return connection;
  const clean = { ...psd };
  for (const k of PSD_SECRETS) delete clean[k];
  return { ...connection, providerSpecificData: clean };
}
