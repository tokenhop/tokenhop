// YAN-360: per-member role change (PATCH) and removal (DELETE). Hidden (404)
// while the multi-user switch is off. Full browser session only; exact
// workspace URL id is authoritative and the repo re-checks live manager
// authority, provenance (IdP rows are read-only), and the last-manager guard
// in-transaction. The repo writes the membership.roleChange/membership.remove
// audit rows — none here.
import {
  json,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";
import { removeMembership, updateMembershipRole } from "@/lib/db/repos/membershipsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 1024;
const CAPABILITY = "workspace.members.manage";
const ROLES = ["manager", "member", "viewer"];
const KEYS = ["role"];

// Fixed messages only: repo error text is never echoed.
const ERRORS = {
  NOT_FOUND: [404, "Workspace not found"],
  FORBIDDEN: [403, "Forbidden"],
  IDP_MANAGED: [409, "Membership is managed by SSO sync"],
  LAST_MANAGER: [409, "Workspace needs at least one manager"],
  PERSONAL_WORKSPACE: [400, "Personal workspaces can't have members"],
  INVALID: [400, "Invalid request"],
};

function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: err.code.toLowerCase() }, hit[0]);
  return json({ error: "Internal error" }, 500);
}

export async function PATCH(request, { params }) {
  try {
    const { id, userId } = await params;
    const { res, principal } = await requireManagedSession(request, {
      capability: CAPABILITY,
      workspaceId: id,
      body: true,
      allowInstanceUsersManage: true,
    });
    if (res) return res;
    const body = await readJsonBody(request, { max: MAX_BODY });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !KEYS.includes(k))
    ) {
      return fail({ code: "INVALID" });
    }
    const { role } = body;
    if (typeof role !== "string" || !ROLES.includes(role)) {
      return fail({ code: "INVALID" });
    }
    const member = await updateMembershipRole(principal, id, userId, role);
    return json({ member });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id, userId } = await params;
    const { res, principal } = await requireManagedSession(request, {
      capability: CAPABILITY,
      workspaceId: id,
      allowInstanceUsersManage: true,
    });
    if (res) return res;
    const removed = await removeMembership(principal, id, userId);
    if (!removed) return fail({ code: "NOT_FOUND" });
    return json({ removed: true });
  } catch (err) {
    return fail(err);
  }
}
