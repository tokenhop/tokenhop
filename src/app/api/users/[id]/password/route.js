// YAN-358: admin "set temporary password". The target must change it on next
// login (mustChangePassword = 1, sv bumped so their sessions end). Full
// browser session only; never returns the hash or the plaintext.
import { NextResponse } from "next/server";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { authorize, getPrincipal } from "@/lib/users/session";
import { hashPassword, validateNewPassword } from "@/lib/auth/userPassword.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { getUserUnscoped, setUserPasswordUnscoped } from "@/lib/db/index.js";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// Owner resets any non-owner; admin resets only ordinary or pending users.
function mayReset(actorRole, target) {
  if (target.instanceRole === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && ["user", "pending"].includes(target.instanceRole);
}

export async function POST(request, { params }) {
  try {
    if (!(await isUserSecurityEnforced())) return json({ error: "Not found" }, 404);
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request)) {
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
    }
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.users.manage");
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    if (keys.length !== 1 || typeof body.password !== "string" || body.password.length > 1024) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }

    const { id } = await params;
    const target = await getUserUnscoped(id);
    if (!target) return json({ error: "Not found" }, 404);
    if (target.id === principal.userId || !mayReset(principal.instanceRole, target)) {
      return json({ error: "You can't set this user's password.", code: "forbidden_target" }, 403);
    }

    const invalid = validateNewPassword(body.password);
    if (invalid) return json(invalid, 400);

    // Recheck sv in the write tx: a concurrent role/owner change fails closed.
    await setUserPasswordUnscoped(target.id, {
      passwordHash: await hashPassword(body.password),
      mustChangePassword: true,
      expectedSessionVersion: target.sessionVersion,
    });
    return json({ success: true });
  } catch (err) {
    if (err?.code === "STALE") return json({ error: "User changed, retry", code: "stale" }, 409);
    if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    return json({ error: "Internal error" }, 500);
  }
}
