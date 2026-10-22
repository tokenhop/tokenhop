import { NextResponse } from "next/server";
import { exportConfig } from "@/lib/db/configExport.js";
import { hasValidCliToken } from "@/lib/auth/cliToken";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { readPasswordHeader } from "@/lib/auth/passwordHeader.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/settings/config/export — password-confirmed download of the
 * versioned config document (settings minus secrets and machine-local state,
 * portable combos, user pricing overrides). Distinct from the full DB backup
 * at /api/settings/database, which includes accounts and keys.
 */
export async function GET(request) {
  try {
    // A valid CLI token authenticates on its own; otherwise the password comes
    // from x-tokenhop-password-b64 (lossless UTF-8) or legacy x-9r-password (YAN-1248).
    if (!(await hasValidCliToken(request))) {
      const headerPassword = readPasswordHeader(request.headers);
      if (headerPassword.invalid) {
        return NextResponse.json(
          { error: "Invalid request", code: "invalid_request" },
          { status: 400 },
        );
      }
      if (!(await verifyDashboardPassword(headerPassword.value))) {
        return NextResponse.json({ error: "Invalid password" }, { status: 401 });
      }
    }
    const doc = await exportConfig();
    // YAN-367: password/CLI auth pre-dates principals — actor stays null.
    await audit({ ip: getClientIp(request) }, "config.export", { type: "config" }, {});
    return NextResponse.json(doc, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error exporting config:", error);
    return NextResponse.json({ error: "Failed to export config" }, { status: 500 });
  }
}
