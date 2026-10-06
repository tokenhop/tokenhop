// YAN-360: revoke a workspace invitation. DELETE only; hidden (404) while
// the multi-user switch is off. Full browser session only. The workspace
// URL id is authoritative and enforced inside the repo transaction via
// `expectedWorkspaceId`: a mismatched invite is NOT_FOUND before any write,
// so a cross-workspace manager can never touch another workspace's rows.
// The response is metadata only — no token or hash ever exists here.
import { json } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session";
import { can } from "@/lib/users/principal.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { revokeInvitation } from "@/lib/db/repos/invitationsRepo.js";
import { audit } from "@/lib/users/audit.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Invitation-route session gate: multi-user switch, same-origin, full
 * browser session, then YAN-360 admin override — an active instance
 * admin/owner (`instance.users.manage`) may manage invitations in any
 * shared workspace without being a member; everyone else needs
 * `workspace.members.manage` on the exact URL workspace. Admin authority
 * never reaches another user's personal resources: the repo still rejects
 * personal workspaces. Returns `{ res }` when denied, else `{ principal }`.
 */
async function requireInvitationSession(request, { workspaceId }) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
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
  const code = err?.code;
  if (code === "NOT_FOUND") return json({ error: "Invitation not found", code: "not_found" }, 404);
  if (code === "FORBIDDEN")
    return json({ error: "Only owners and managers may manage invitations" }, 403);
  if (code === "PERSONAL_WORKSPACE")
    return json({ error: "Personal workspaces can't have invitations" }, 400);
  // Fixed safe copy: never echo repo/supplier text back to the client.
  if (code === "INVALID") return json({ error: "Invalid request", code: "invalid_request" }, 400);
  return json({ error: "Internal error" }, 500);
}

export async function DELETE(request, { params }) {
  try {
    const { id, inviteId } = await params;
    const { res, principal } = await requireInvitationSession(request, { workspaceId: id });
    if (res) return res;
    const invitation = await revokeInvitation({ userId: principal.userId }, inviteId, {
      expectedWorkspaceId: id,
    });
    audit(
      { principal, request, workspaceId: id },
      "invitation.revoke",
      { type: "invitation", id: inviteId },
      { after: { inviteId, workspaceId: id } },
    );
    return json({ invitation });
  } catch (err) {
    return fail(err);
  }
}
