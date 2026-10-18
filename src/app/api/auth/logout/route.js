import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie, readSignedAuthToken } from "@/lib/auth/dashboardSession";
import { clearPasswordChangeCookie } from "@/lib/auth/passwordChangeSession";
import { revokeSessionUnscoped } from "@/lib/db/index.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";

export async function POST() {
  const cookieStore = await cookies();
  // Best-effort: logout is unauthenticated and must never fail on a revoke error.
  try {
    const p = await readSignedAuthToken(cookieStore.get("auth_token")?.value);
    if (
      typeof p?.sub === "string" &&
      typeof p?.sid === "string" &&
      (await isUserSecurityEnforced())
    ) {
      await revokeSessionUnscoped(p.sid, p.sub);
    }
  } catch {}
  clearDashboardAuthCookie(cookieStore);
  // Same /api/auth path the challenge cookie was set with, or it survives.
  clearPasswordChangeCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
