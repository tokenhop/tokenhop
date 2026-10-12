// YAN-373: admin "sign out everywhere" for another user. Guarded exactly like
// PATCH/DELETE /api/users/[id] (switch, origin, full session,
// instance.users.manage); the repo re-checks the hierarchy live in one
// transaction and bumps only the target's sessionVersion. Never echoes repo
// error text beyond the fixed map.
import { requireMultiUser } from "@/lib/users/featureSwitch";
import { authorize, getPrincipal } from "@/lib/users/session";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { audit } from "@/lib/users/audit.js";
import { json } from "@/lib/users/userManagement.js";
import { revokeUserSessionsUnscoped } from "@/lib/db/repos/usersRepo.js";

const ERRORS = {
  NOT_FOUND: [404, "Not found", "not_found"],
  FORBIDDEN: [403, "You can't change this user.", "forbidden_target"],
  INVALID: [400, "Invalid request", "invalid_request"],
};

function fail(err) {
  const known = ERRORS[err?.code];
  if (known) return json({ error: known[1], code: known[2] }, known[0]);
  return json({ error: "Internal error" }, 500);
}

export async function POST(request, { params }) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.users.manage");
    if (denied) return denied;

    const { id } = await params;
    await revokeUserSessionsUnscoped(id, { actorUserId: principal.userId });
    audit({ principal, request }, "instance.users.logoutAll", { type: "user", id });
    return json({ success: true });
  } catch (err) {
    return fail(err);
  }
}
