// YAN-363: GET /api/keys/context — the key-management context envelope.
// Metadata capabilities only: never keys, counts or identity. Session or CLI
// principals only; a gateway bearer never authorizes dashboard context, not
// even alongside a session cookie (same posture as the collection route).
// Membership and roles are re-read live from the DB — the JWT is advisory.
import { NextResponse } from "next/server";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState";
import { membershipRole } from "@/lib/db/repos/membershipsRepo";
import { getAdapter } from "@/lib/db/driver";
import { can } from "@/lib/users/principal";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (error, status) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** A live personal-workspace membership id for `userId`, or null. */
function personalWorkspaceId(db, userId) {
  return db.get(
    `SELECT w.id AS id FROM workspaces w JOIN memberships m ON m.workspaceId = w.id
     WHERE m.userId = ? AND w.kind = 'personal'`,
    [userId],
  )?.id;
}

export async function GET(request) {
  try {
    if (request.headers.get("authorization")) return json("Forbidden", 403);
    const { resolvePrincipal } = await import("@/lib/users/session");
    const ctx = await resolvePrincipal(request);
    if (!ctx) return json("Unauthorized", 401);
    if (!["session", "cli"].includes(ctx.via) || ctx.apiKeyId != null) {
      return json("Forbidden", 403);
    }
    const db = await getAdapter();
    const { storage } = readApiKeyStorageState(db); // invalid state → 503 below
    // Live recheck: a disabled/deleted user is 401, a foreign workspace 404
    // (missing and non-member stay indistinguishable — no existence leak).
    const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [ctx.userId]);
    if (user?.status !== "active") return json("Unauthorized", 401);

    const wanted = new URL(request.url).searchParams.get("workspaceId")?.trim();
    let workspaceId = null;
    let role = null;
    if (wanted) {
      // An explicit selector is honored only with a live membership — never
      // silently redirected to some other workspace.
      role = membershipRole(db, wanted, ctx.userId);
      workspaceId = role ? wanted : null;
    } else {
      // CLI: the vetted Default workspace from _meta (server-side, never a
      // client guess). Session: the live session's active workspace, else the
      // personal one. Every candidate needs a live membership to be chosen.
      const candidates =
        ctx.via === "cli"
          ? [
              db.get(
                `SELECT w.id AS id FROM _meta m JOIN workspaces w ON w.id = m.value
                 WHERE m.key = 'defaultWorkspaceId'`,
              )?.id,
              ctx.activeWorkspaceId,
              personalWorkspaceId(db, ctx.userId),
            ]
          : [ctx.activeWorkspaceId, personalWorkspaceId(db, ctx.userId)];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const live = membershipRole(db, candidate, ctx.userId);
        if (live) {
          workspaceId = candidate;
          role = live;
          break;
        }
      }
    }
    if (!workspaceId) return json("Not found", 404);

    // Capabilities come from the shared role map on LIVE values only. Members
    // keep their context even though listing keys is manager-only (D1).
    const live = { instanceRole: user.instanceRole, workspaceRoles: { [workspaceId]: role } };
    const canCreate = can(live, "workspace.keys.create", { workspaceId });
    const canManage = can(live, "workspace.keys.manage", { workspaceId });
    // spec214: the durable per-workspace migration ack, exposed to any current
    // member reading their context. Hashed storage only — the pristine legacy
    // envelope keeps its exact five fields.
    const migrationAcknowledged =
      storage === "hashed" &&
      db.get(`SELECT value FROM _meta WHERE key = ?`, [
        `migrationAcknowledgedWorkspace:${workspaceId}`,
      ])?.value === "1";
    return NextResponse.json(
      {
        storage,
        workspaceId,
        canCreate,
        canManage,
        canCreateService: canCreate && canManage,
        ...(storage === "hashed" && { migrationAcknowledged }),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json("Key storage unavailable", 503);
    console.error("Failed to fetch key context:", error);
    return json("Failed to fetch key context", 500);
  }
}
