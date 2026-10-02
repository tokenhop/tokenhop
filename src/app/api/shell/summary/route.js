import { NextResponse } from "next/server";
import { getCombos, getProviderConnections, getSettings } from "@/lib/localDb";
import { getRequestRateSeries, getSavingsLifetime } from "@/lib/db/index.js";
import { resolveFlagSetting } from "@/lib/settingsFlags";
import { resolveListenPort, shapeGatewayStatus } from "@/lib/gatewayStatus";
import { buildQuotaSnapshotView } from "@/sse/services/quotaSnapshotSync.js";
import { buildShellSummary } from "@/lib/shellSummary";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { normalizeAckedMilestone, pendingSavingsMilestone } from "@/lib/savingsMilestones.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/shell/summary — sidebar badges, gateway status and the translator
 * gate in one request. Not on the public allowlist, so dashboardGuard applies
 * the same auth as /api/settings. Counts only, no connection or secret data.
 * Also carries the 15-minute req/min heartbeat series (YAN-408) and the
 * pending savings milestone, so neither needs an extra poll. A usage-DB hiccup
 * degrades only those two blocks; the gateway card still renders.
 */
export async function GET() {
  try {
    const [connections, combos, settings, traffic, savingsLifetime, multiUser] = await Promise.all([
      getProviderConnections(),
      getCombos(),
      getSettings(),
      getRequestRateSeries().catch(() => null),
      getSavingsLifetime().catch(() => null),
      isMultiUserEnabled(),
    ]);
    const body = buildShellSummary({
      connections,
      combos,
      translatorEnabled: resolveFlagSetting("ENABLE_TRANSLATOR", settings?.translatorEnabled, false)
        .value,
      multiUser,
      gateway: shapeGatewayStatus({
        uptimeSeconds: process.uptime(),
        nowMs: Date.now(),
        port: resolveListenPort(process.env, process.argv),
      }),
      getSnapshotView: (id) => buildQuotaSnapshotView(id),
      traffic,
      savingsMilestone:
        savingsLifetime === null
          ? undefined
          : pendingSavingsMilestone(
              savingsLifetime,
              normalizeAckedMilestone(settings?.savingsMilestoneAck),
            ),
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to build shell summary:", error);
    return NextResponse.json({ error: "Failed to load shell summary" }, { status: 500 });
  }
}
