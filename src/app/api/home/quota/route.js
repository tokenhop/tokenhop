import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/index.js";
import { buildQuotaSnapshotView } from "@/sse/services/quotaSnapshotSync.js";
import { deriveQuotaAccounts } from "@/lib/home/quota.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/home/quota — quota snapshot accounts for the Home quota watch.
 * Server-side snapshots only (no upstream probes, no rate limits), same view
 * the providers page uses; missing/stale snapshots degrade to
 * `remaining: null` per account.
 * Auth via the existing dashboardGuard deny-by-default for /api/*.
 */
export async function GET() {
  try {
    const connections = await getProviderConnections();
    const active = (connections || []).filter((c) => c?.isActive !== false);
    return NextResponse.json({
      accounts: deriveQuotaAccounts(active, (id) => buildQuotaSnapshotView(id)),
    });
  } catch (error) {
    console.error("[API] Failed to get home quota:", error);
    return NextResponse.json({ error: "Failed to fetch home quota" }, { status: 500 });
  }
}
