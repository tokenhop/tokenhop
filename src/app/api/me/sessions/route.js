// YAN-751: GET /api/me/sessions — the caller's live device sessions. Never
// returns the cookie, the user id or session version. Pure read: no mint, no
// Set-Cookie, no legacy-session adoption. Switch off: 404. Browser session only.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { listSessions } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const json = (body, status = 200, headers) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function GET() {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);

    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (typeof session?.sub !== "string" || session.sub !== principal.userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const currentSid = typeof session.sid === "string" ? session.sid : null;
    const rows = await listSessions(principal);
    const mapped = rows.map((r) => ({
      id: r.id,
      current: r.id === currentSid,
      device: r.userAgent,
      loginMethod: r.amr,
      ...(r.ip ? { network: r.ip } : {}),
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
    }));
    // Current first; the rest keep the repo's order (most recently seen first).
    const sessions = [...mapped.filter((s) => s.current), ...mapped.filter((s) => !s.current)];
    return json({
      sessions,
      currentSessionId: sessions.some((s) => s.current) ? currentSid : null,
    });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.error("[Sessions] list failed:", error?.message);
    return json({ error: "Internal server error" }, 500);
  }
}
