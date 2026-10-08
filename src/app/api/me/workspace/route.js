// YAN-371 (ADR-0004): switch the caller's active workspace. Membership is
// re-verified from the live DB and auth_token is re-minted with the new wid
// and the ORIGINAL exp — a switch never extends the session. The choice is
// persisted as the lastWorkspaceId user preference (restored at next login).
// Switch off: 404. Browser session only (the policy row: self.session,
// alwaysProtected, no CLI token); CSRF via isCrossSite/isJson (D16).
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal, remintClaims } from "@/lib/users/session.js";
import { getDashboardAuthSession, setDashboardAuthCookie } from "@/lib/auth/dashboardSession.js";
import { listWorkspaces, updateUserPreferences } from "@/lib/db/index.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { isPlainObject } from "@/app/api/settings/validateSettings.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request))
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);

    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);

    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    // The principal came from this cookie: a sub mismatch means the cookie is
    // not the session we resolved — refuse, never re-mint for someone else.
    if (typeof session?.sub !== "string" || session.sub !== principal.userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await request.json().catch(() => null);
    if (
      !isPlainObject(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.workspaceId !== "string" ||
      !body.workspaceId
    ) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    const { workspaceId } = body;
    // Non-member → 404 (no existence leak). Live membership, never old claims.
    if (!principal.workspaceIds.includes(workspaceId)) {
      return json({ error: "Workspace not found" }, 404);
    }

    // Fresh claims from the live user row (fresh sv/status checks), display
    // claims copied from the allow-list; exp is never copied or extended.
    const claims = await remintClaims(session, workspaceId);
    if (!claims?.sub) return json({ error: "Unauthorized" }, 401);
    await setDashboardAuthCookie(cookieStore, request, claims, { exp: session.exp });
    await updateUserPreferences(principal, { lastWorkspaceId: workspaceId });

    const workspace = (await listWorkspaces(principal)).find((w) => w.id === workspaceId);
    return json({
      activeWorkspaceId: workspaceId,
      workspace: workspace
        ? { id: workspace.id, name: workspace.name, kind: workspace.kind, role: workspace.role }
        : null,
    });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    return json({ error: error.message }, 500);
  }
}
