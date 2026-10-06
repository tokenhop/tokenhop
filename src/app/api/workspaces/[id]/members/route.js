// YAN-360: workspace member management. GET lists members; POST adds a
// manual member. Hidden (404) while the multi-user switch is off. Full
// browser session only; exact workspace URL id is authoritative and the repo
// re-checks live manager authority in-transaction. The repo writes the
// membership.add audit row — none here. `source` is server-controlled
// (manual) and never read from the body.
import {
  json,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";
import { addMembership, listManagedMemberships } from "@/lib/db/repos/membershipsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 1024;
const CAPABILITY = "workspace.members.manage";
const ROLES = ["manager", "member", "viewer"];
const KEYS = ["userId", "role"];

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

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const { res, principal } = await requireManagedSession(request, {
      capability: CAPABILITY,
      workspaceId: id,
      allowInstanceUsersManage: true,
    });
    if (res) return res;
    return json({ members: await listManagedMemberships(principal, id) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
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
    const { userId, role } = body;
    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof role !== "string" ||
      !ROLES.includes(role)
    ) {
      return fail({ code: "INVALID" });
    }
    const member = await addMembership(principal, id, { userId, role, source: "manual" });
    return json({ member }, 201);
  } catch (err) {
    return fail(err);
  }
}
