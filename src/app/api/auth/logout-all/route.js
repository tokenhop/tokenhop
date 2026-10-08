import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { bumpSessionVersion } from "@/lib/db/index.js";
import { requireMultiUser } from "@/lib/users/featureSwitch";
import { getPrincipal } from "@/lib/users/session";

// Sign out everywhere (ADR-0004): bump the user's sessionVersion so every
// token they hold fails on its next request, then clear this browser's cookie.
export async function POST(request) {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  // YAN-371 (D16): a browser mutation — same cross-site guard as logout.
  if (request && isCrossSite(request))
    return NextResponse.json({ error: "Forbidden", code: "forbidden_origin" }, { status: 403 });
  const principal = await getPrincipal();
  // Only a signed-in session has sessions to revoke; single-user mode (via
  // "local") would let any peer sign the owner out.
  if (principal?.via !== "session") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await bumpSessionVersion(principal.userId);
  clearDashboardAuthCookie(await cookies());
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
