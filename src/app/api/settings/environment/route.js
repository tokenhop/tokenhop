import { NextResponse } from "next/server";
import { buildEnvironmentReadout } from "@/lib/settingsFlags";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/settings/environment — auth-protected (dashboardGuard gates
 * /api/settings*), read-only allowlisted non-secret env readout plus the
 * effective secure-cookie state. Secrets are never returned: the allowlist in
 * `@/lib/settingsFlags` excludes them and the denylist wins on misconfig.
 */
export async function GET(request) {
  try {
    return NextResponse.json(
      {
        values: buildEnvironmentReadout(),
        cookieSecure: shouldUseSecureCookie(request),
        cookieSecureSource:
          process.env.AUTH_COOKIE_SECURE === "true"
            ? "env"
            : request?.headers?.get?.("x-forwarded-proto") === "https"
              ? "proxy"
              : "off",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Failed to load environment" }, { status: 500 });
  }
}
