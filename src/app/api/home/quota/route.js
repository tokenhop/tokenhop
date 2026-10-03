import { NextResponse } from "next/server";
import { scopedConnections } from "@/lib/users/workspaceScope.js";
import { buildQuotaSnapshotView } from "@/sse/services/quotaSnapshotSync.js";
import { getQuotaForecasts } from "@/lib/quota/forecastStore.js";
import { deriveQuotaAccounts } from "@/lib/home/quota.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/home/quota — quota snapshot accounts for the Home quota watch.
 * Server-side snapshots only (no upstream probes, no rate limits), same view
 * the providers page uses; missing/stale snapshots degrade to
 * `remaining: null` per account.
 * Auth via the existing dashboardGuard deny-by-default for /api/*.
 */
export async function GET(request) {
  try {
    // YAN-361: switch on, only the selected workspace's accounts.
    const scoped = await scopedConnections(request, "workspace.usage.read");
    if (scoped instanceof Response) return scoped;
    const { connections } = scoped;
    const active = (connections || []).filter((c) => c?.isActive !== false);
    return NextResponse.json({
      accounts: deriveQuotaAccounts(
        active,
        (id) => buildQuotaSnapshotView(id),
        (id) => getQuotaForecasts(id),
      ),
    });
  } catch (error) {
    console.error("[API] Failed to get home quota:", error);
    return NextResponse.json({ error: "Failed to fetch home quota" }, { status: 500 });
  }
}
