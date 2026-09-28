import { NextResponse } from "next/server";
import { exportConfig } from "@/lib/db/configExport.js";
import { hasValidCliToken } from "@/lib/auth/cliToken";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PASSWORD_HEADER = "x-9r-password";

/**
 * GET /api/settings/config/export — password-confirmed download of the
 * versioned config document (settings minus secrets and machine-local state,
 * portable combos, user pricing overrides). Distinct from the full DB backup
 * at /api/settings/database, which includes accounts and keys.
 */
export async function GET(request) {
  try {
    if (
      !(await hasValidCliToken(request)) &&
      !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))
    ) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const doc = await exportConfig();
    return NextResponse.json(doc, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error exporting config:", error);
    return NextResponse.json({ error: "Failed to export config" }, { status: 500 });
  }
}
