import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { clearPasswordChangeCookie } from "@/lib/auth/passwordChangeSession";

export async function POST() {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  // Same /api/auth path the challenge cookie was set with, or it survives.
  clearPasswordChangeCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
