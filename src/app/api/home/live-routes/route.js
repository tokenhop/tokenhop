import { NextResponse } from "next/server";
import { getLiveRoutesFeed, getProviderConnections, getProviderNodes } from "@/lib/db/index.js";
import { buildLiveRoutes, WINDOW_MS } from "@/lib/home/liveRoutes.js";

// /api/* is deny-by-default protected by src/dashboardGuard.js (proxy middleware).
export const dynamic = "force-dynamic";

/**
 * GET /api/home/live-routes
 * Live client → 9router → provider flows over the rolling 5-minute window,
 * derived from recorded usage history plus provider model-lock state.
 */
export async function GET() {
  try {
    const [feed, connections, nodes] = await Promise.all([
      getLiveRoutesFeed({ windowMs: WINDOW_MS }),
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);
    const providerNames = {};
    for (const node of nodes || []) {
      if (node?.id && node?.name) providerNames[node.id] = node.name;
    }
    return NextResponse.json(
      buildLiveRoutes({
        usageRows: feed.usageRows,
        errorRows: feed.errorRows,
        connections,
        fallbackHops: feed.fallbackHops,
        providerNames,
      }),
    );
  } catch (error) {
    console.error("[API] Failed to get live routes:", error);
    return NextResponse.json({ error: "Failed to fetch live routes" }, { status: 500 });
  }
}
