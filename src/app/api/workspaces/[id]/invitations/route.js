// YAN-360: workspace invitation management. GET lists scoped metadata
// (no token or hash); POST mints one invitation and returns the raw token
// exactly once. Hidden (404) while the multi-user switch is off. Full
// browser session only; the workspace URL id is authoritative and the
// repo enforces live in-transaction manager authority (admin override,
// non-members get NOT_FOUND, cross-workspace managers are treated as
// non-members here — exact-URL check only).
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session";
import { can } from "@/lib/users/principal.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { createInvitation, listInvitations } from "@/lib/db/repos/invitationsRepo.js";
import { audit } from "@/lib/users/audit.js";
import { TenancyError } from "@/lib/users/errors.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 1024;
const ROLES = ["manager", "member", "viewer"];
// Raw token leaves exactly once on the 201: never let a browser leak the
// URL (or referrer) it was fetched from alongside it.
const RAW_TOKEN_HEADERS = { "Referrer-Policy": "no-referrer" };

/**
 * Invitation-route session gate: multi-user switch, same-origin, JSON for
 * mutators, full browser session, then YAN-360 admin override — an active
 * instance admin/owner (`instance.users.manage`) may manage invitations in
 * any shared workspace without being a member; everyone else needs
 * `workspace.members.manage` on the exact URL workspace. Admin authority
 * never reaches another user's personal resources: the repo still rejects
 * personal workspaces. Returns `{ res }` when denied, else `{ principal }`.
 */
async function requireInvitationSession(request, { workspaceId, body = false } = {}) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const principal = await getPrincipal();
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  const allowed =
    can(principal, "instance.users.manage") ||
    can(principal, "workspace.members.manage", { workspaceId });
  if (!allowed) return { res: json({ error: "Forbidden" }, 403) };
  return { principal };
}

function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const code = err?.code;
  if (code === "NOT_FOUND") return json({ error: "Workspace not found", code: "not_found" }, 404);
  if (code === "FORBIDDEN")
    return json({ error: "Only owners and managers may manage invitations" }, 403);
  if (code === "PERSONAL_WORKSPACE")
    return json({ error: "Personal workspaces can't have invitations" }, 400);
  // Fixed safe copy: never echo repo/supplier text back to the client.
  if (code === "INVALID") return json({ error: "Invalid request", code: "invalid_request" }, 400);
  return json({ error: "Internal error" }, 500);
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const { res, principal } = await requireInvitationSession(request, { workspaceId: id });
    if (res) return res;
    const invitations = await listInvitations({ userId: principal.userId }, id);
    return json({ invitations });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const { res, principal } = await requireInvitationSession(request, {
      workspaceId: id,
      body: true,
    });
    if (res) return res;
    let parsed;
    try {
      parsed = await readJsonBody(request, { max: MAX_BODY });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return fail(err);
      throw err;
    }
    // Strict allow-list: role and optional email only. Anything else —
    // workspaceId, source, actor hints — is rejected, not ignored.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TenancyError("INVALID");
    }
    if (Object.keys(parsed).some((key) => key !== "role" && key !== "email")) {
      throw new TenancyError("INVALID");
    }
    const { role, email } = parsed;
    if (!ROLES.includes(role)) throw new TenancyError("INVALID");
    if (email !== undefined && email !== null && (typeof email !== "string" || !email.trim())) {
      throw new TenancyError("INVALID");
    }
    const { invitation, token } = await createInvitation(
      { userId: principal.userId },
      { workspaceId: id, role, email: email ?? null },
    );
    audit(
      { principal, request, workspaceId: id },
      "invitation.create",
      { type: "invitation", id: invitation.id },
      { after: { inviteId: invitation.id, workspaceId: id, role: invitation.role } },
    );
    const response = json({ invitation, token }, 201);
    for (const [k, v] of Object.entries(RAW_TOKEN_HEADERS)) response.headers.set(k, v);
    return response;
  } catch (err) {
    return fail(err);
  }
}
