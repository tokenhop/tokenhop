// Settings PATCH password branch for an established (security-enforced) install:
// only the live owner browser session may change the owner password, and only
// through the change-password route (verifies current pw, atomic hash + sv bump,
// fresh cookie). Pristine installs keep the legacy settings semantics.
import { NextRequest, NextResponse } from "next/server";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { getPrincipal } from "@/lib/users/session";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { POST as changePassword } from "@/app/api/auth/change-password/route.js";

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (error, status) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * @param {Request} request Settings PATCH request (body already parsed).
 * @param {object} body Parsed plain-object body.
 * @returns {Promise<Response|null>} Response when handled/rejected, null when
 * the body is not a password change or security is not enforced (legacy path).
 */
export async function handleEstablishedOwnerPassword(request, body) {
  if (!Object.hasOwn(body, "newPassword") && !Object.hasOwn(body, "currentPassword")) return null;
  try {
    if (!(await isUserSecurityEnforced())) return null;

    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes("newPassword") || !keys.includes("currentPassword")) {
      return reply("Password change must contain only currentPassword and newPassword", 400);
    }
    if (isCrossSite(request)) return reply("Forbidden", 403);

    const principal = await getPrincipal();
    if (!principal) return reply("Unauthorized", 401);
    if (principal.via !== "session" || principal.instanceRole !== "owner") {
      return reply("Forbidden", 403);
    }

    const forward = new Headers(request.headers);
    forward.set("content-type", "application/json");
    forward.delete("content-length");
    return await changePassword(
      new NextRequest(request.url, {
        method: "POST",
        headers: forward,
        body: JSON.stringify({
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
        }),
      }),
    );
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") return reply("Service unavailable", 503);
    throw err;
  }
}
