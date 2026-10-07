import { NextResponse } from "next/server";
import {
  getLiveRoutesFeed,
  getProviderConnectionsUnscoped,
  getProviderNodesUnscoped,
} from "@/lib/db/index.js";
import { listConnectionsMetadata } from "@/lib/db/repos/connectionsRepo.js";
import { listNodesMetadata } from "@/lib/db/repos/nodesRepo.js";
import { buildLiveRoutes, WINDOW_MS } from "@/lib/home/liveRoutes.js";
import { usageScope } from "@/lib/usage/scope.js";

// /api/* is deny-by-default protected by src/dashboardGuard.js (proxy middleware).
export const dynamic = "force-dynamic";

/**
 * GET /api/home/live-routes
 * Live client → tokenhop → provider flows over the rolling 5-minute window,
 * derived from recorded usage history plus provider model-lock state.
 */
export async function GET(request) {
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;

    const [feed, connections, nodes] = await Promise.all([
      getLiveRoutesFeed(scope, { windowMs: WINDOW_MS }),
      // YAN-370: scoped callers only see their workspace's connection locks.
      (scope
        ? listConnectionsMetadata(scope.ctx, scope.workspaceId)
        : getProviderConnectionsUnscoped()
      ).catch(() => []),
      (scope ? listNodesMetadata(scope.ctx, scope.workspaceId) : getProviderNodesUnscoped()).catch(
        () => [],
      ),
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
