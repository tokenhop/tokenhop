// YAN-373: admin workspace detail (GET) and guarded deletion (DELETE).
// Browser session only, instance.users.manage, hidden (404) while the
// users & teams switch is off. GET answers shared workspaces only —
// personal and unknown ids share one 404, no existence leak. DELETE is a
// typed confirmation plus a FRESH authentication proof (current password or
// a just-completed SSO re-auth bound to this exact workspace), re-checked
// live (role + sessionVersion) inside the deletion transaction. The Default
// workspace is protected (409). Audit stays in the repo (workspace.delete).
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import {
  json,
  payloadTooLarge,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";
import { reauthPrincipal } from "@/lib/users/databaseTransfer.js";
import {
  getWorkspaceDetailUnscoped,
  deleteWorkspaceGuardedUnscoped,
} from "@/lib/db/repos/workspacesRepo.js";
import { consumeWorkspaceDeleteProof } from "@/lib/users/ssoPreview.js";
import { TenancyError } from "@/lib/users/errors.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ERRORS = {
  NOT_FOUND: [404, "Workspace not found", "not_found"],
  FORBIDDEN: [403, "Forbidden", "forbidden"],
  STALE: [409, "Session is out of date", "stale_session"],
  DEFAULT_WORKSPACE_PROTECTED: [
    409,
    "The Default workspace cannot be deleted",
    "default_workspace",
  ],
  REAUTH_REQUIRED: [401, "Fresh authentication required", "reauth_required"],
  REAUTH_UNSUPPORTED: [
    403,
    "This account signs in with single sign-on and has no password",
    "reauth_unsupported",
  ],
  INVALID: [400, "Invalid request", "invalid_request"],
};

function fail(err) {
  if (err instanceof PayloadTooLarge) return payloadTooLarge();
  const hit = ERRORS[err?.code];
  return hit
    ? json({ error: hit[1], code: hit[2] }, hit[0])
    : json({ error: "Internal error" }, 500);
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const gate = await requireManagedSession(request, { capability: "instance.users.manage" });
    if (gate.res) return gate.res;
    const detail = await getWorkspaceDetailUnscoped(id);
    if (!detail) return json({ error: "Workspace not found", code: "not_found" }, 404);
    return json(detail);
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.warn("[workspaces] detail failed:", err?.code || "error");
    return fail(err);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const gate = await requireManagedSession(request, {
      capability: "instance.users.manage",
      body: true,
    });
    if (gate.res) return gate.res;
    const { principal } = gate;

    let body;
    try {
      body = await readJsonBody(request, { max: MAX_BODY });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return payloadTooLarge();
      throw err;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    const base =
      keys.length === 3 &&
      body.confirmWorkspaceId === id &&
      body.acknowledgeDekDestruction === true;
    if (!base || !UUID_RE.test(id)) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    const passwordProof =
      keys.includes("currentPassword") &&
      keys.every((k) =>
        ["confirmWorkspaceId", "acknowledgeDekDestruction", "currentPassword"].includes(k),
      ) &&
      typeof body.currentPassword === "string";
    const ssoProof =
      keys.includes("ssoProof") &&
      keys.every((k) =>
        ["confirmWorkspaceId", "acknowledgeDekDestruction", "ssoProof"].includes(k),
      ) &&
      typeof body.ssoProof === "string";
    if (!passwordProof && !ssoProof) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }

    // The proof binds to this session's sv; the deletion transaction re-checks
    // the live role AND sv, so a demotion during any hash window voids it.
    const cookieStore = await cookies();
    const claims = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (claims?.sub !== principal.userId || !Number.isInteger(claims.sv)) {
      throw new TenancyError("STALE", "Session is out of date");
    }
    if (passwordProof) {
      const denied = await reauthPrincipal(request, principal, body.currentPassword, {
        instanceAdmin: true,
      });
      if (denied) return denied;
    } else {
      // One-time, purpose-bound, workspace-bound SSO proof (no weaker fallback
      // for SSO-only admins; a missing/mismatched proof fails closed).
      consumeWorkspaceDeleteProof(body.ssoProof, principal.userId, id, claims.sv);
    }

    const summary = await deleteWorkspaceGuardedUnscoped(id, {
      actorId: principal.userId,
      sessionVersion: claims.sv,
      ip: getClientIp(request),
    });
    return json({ deleted: true, ...summary });
  } catch (err) {
    return fail(err);
  }
}
