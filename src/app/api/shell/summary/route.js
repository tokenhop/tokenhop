import { NextResponse } from "next/server";
import { getCombos, getProviderConnections, getSettings } from "@/lib/localDb";
import { resolveFlagSetting } from "@/lib/settingsFlags";
import { resolveListenPort, shapeGatewayStatus } from "@/lib/gatewayStatus";
import { buildQuotaSnapshotView } from "@/sse/services/quotaSnapshotSync.js";
import { buildShellSummary } from "@/lib/shellSummary";

export const dynamic = "force-dynamic";

/**
 * GET /api/shell/summary — sidebar badges, gateway status and the translator
 * gate in one request. Not on the public allowlist, so dashboardGuard applies
 * the same auth as /api/settings. Counts only, no connection or secret data.
 */
export async function GET() {
  try {
    const [connections, combos, settings] = await Promise.all([
      getProviderConnections(),
      getCombos(),
      getSettings(),
    ]);
    const body = buildShellSummary({
      connections,
      combos,
      translatorEnabled: resolveFlagSetting("ENABLE_TRANSLATOR", settings?.translatorEnabled, false)
        .value,
      gateway: shapeGatewayStatus({
        uptimeSeconds: process.uptime(),
        nowMs: Date.now(),
        port: resolveListenPort(process.env, process.argv),
      }),
      getSnapshotView: (id) => buildQuotaSnapshotView(id),
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to build shell summary:", error);
    return NextResponse.json({ error: "Failed to load shell summary" }, { status: 500 });
  }
}
