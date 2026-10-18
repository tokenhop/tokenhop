// YAN-751: DELETE /api/me/sessions/:id — revoke one of the caller's device
// sessions. One 404 body covers foreign/unknown/expired/revoked/malformed ids.
// Revoking the session this browser is using also clears its cookie.
// Switch off: 404. Browser session only; CSRF via isCrossSite.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { clearDashboardAuthCookie, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { revokeSession } from "@/lib/db/index.js";
import { audit } from "@/lib/users/audit.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const json = (body, status = 200, headers) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const ERRORS = { NOT_FOUND: [404, { error: "Session not found" }] };

export async function DELETE(request, { params }) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);

    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (typeof session?.sub !== "string" || session.sub !== principal.userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { id } = await params;
    try {
      await revokeSession(principal, id);
    } catch (err) {
      const mapped = ERRORS[err?.code];
      if (mapped) return json(mapped[1], mapped[0]);
      throw err;
    }

    const current = id === session.sid;
    if (current) clearDashboardAuthCookie(cookieStore);
    await audit({ principal, request }, "session.revoke", { type: "session", id });
    return json({ success: true, current });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.error("[Sessions] revoke failed:", error?.message);
    return json({ error: "Internal server error" }, 500);
  }
}
