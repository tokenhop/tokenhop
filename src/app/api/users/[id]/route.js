// YAN-360: admin user lifecycle. PATCH changes instanceRole/status (approve,
// role change, disable/enable); DELETE removes the user. Hidden (404) while the
// multi-user switch is off. Full browser session only. The repo re-reads actor
// and target inside its transaction and enforces the hierarchy and invariants.
import { requireMultiUser } from "@/lib/users/featureSwitch";
import { authorize, getPrincipal } from "@/lib/users/session";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { audit } from "@/lib/users/audit.js";
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import {
  deleteUserUnscoped,
  getUserUnscoped,
  updateUserUnscoped,
} from "@/lib/db/repos/usersRepo.js";

const FIELDS = ["instanceRole", "status"];
const MAX_BODY = 1024;

const ERRORS = {
  NOT_FOUND: [404, "Not found", "not_found"],
  FORBIDDEN: [403, "You can't change this user.", "forbidden_target"],
  OWNER_IMMUTABLE: [403, "You can't change this user.", "forbidden_target"],
  LAST_MANAGER: [409, "A shared workspace would be left without a manager.", "last_manager"],
  SINGLE_USER_MODE: [409, "Turn on login before adding users.", "single_user_mode"],
  INVALID: [400, "Invalid request", "invalid_request"],
};

function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const known = ERRORS[err?.code];
  if (known) return json({ error: known[1], code: known[2] }, known[0]);
  if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
  return json({ error: "Internal error" }, 500);
}

// Shared prelude: switch, origin, full session, capability. Null when allowed.
async function guard(request, { body = false } = {}) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request))
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const principal = await getPrincipal();
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  const denied = await authorize("instance.users.manage");
  if (denied) return { res: denied };
  return { principal };
}

const snapshot = (u) => u && { role: u.instanceRole, status: u.status };
function publicUser(u) {
  const { sessionVersion: _sv, ...rest } = u;
  return rest;
}

export async function PATCH(request, { params }) {
  try {
    const { res, principal } = await guard(request, { body: true });
    if (res) return res;
    let body;
    try {
      body = await readJsonBody(request, { max: MAX_BODY });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return fail(err);
      throw err;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (!keys.length || keys.some((k) => !FIELDS.includes(k) || typeof body[k] !== "string")) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    const { id } = await params;
    const before = await getUserUnscoped(id);
    const user = await updateUserUnscoped(id, body, { actorUserId: principal.userId });
    audit(
      { principal, request },
      "instance.users.update",
      { type: "user", id },
      {
        before: snapshot(before),
        after: snapshot(user),
      },
    );
    return json({ user: publicUser(user) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { res, principal } = await guard(request);
    if (res) return res;
    const { id } = await params;
    if (!(await deleteUserUnscoped(id, { actorUserId: principal.userId }))) {
      return json({ error: "Not found", code: "not_found" }, 404);
    }
    audit({ principal, request }, "instance.users.delete", { type: "user", id });
    return json({ success: true });
  } catch (err) {
    return fail(err);
  }
}
