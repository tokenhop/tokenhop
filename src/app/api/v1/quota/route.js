import { resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { getGatewayConnectionsMetadata } from "@/lib/auth/gatewayResources.js";
import { getSnapshot } from "open-sse/services/quotaSnapshot.js";
import {
  deriveRemoteQuotaAccounts,
  filterConnectionsByGatewayScope,
  normalizeProviderFilter,
} from "@/lib/quota/remoteQuota.js";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

const unavailable = (message) =>
  Response.json(
    { error: { message, type: "server_error" } },
    { status: 503, headers: RESPONSE_HEADERS },
  );

/**
 * Handle CORS preflight.
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, x-goog-api-key",
    },
  });
}

/**
 * GET /v1/quota — read-only per-account quota snapshots for remote/gateway clients.
 * Authorized by gateway API key (same resolver as /v1/models and /v1/models/info).
 * Reads only cached in-memory quota snapshots and secret-free connection metadata:
 * never refreshes or rotates OAuth tokens, never makes upstream calls, and never
 * decrypts or returns credentials.
 */
export async function GET(request) {
  let auth;
  try {
    auth = await resolveGatewayAuth(request);
  } catch (error) {
    console.warn("[API] Failed to authenticate remote quota request:", error?.message);
    return unavailable("Gateway authentication unavailable");
  }
  if (auth instanceof Response) return auth;
  // Fail closed on unexpected auth shapes: never fall back to unscoped reads.
  if (
    !(auth?.legacy === true && auth.principal === null) &&
    !(auth?.legacy === false && auth.principal)
  ) {
    return unavailable("Gateway authentication unavailable");
  }

  const { principal } = auth;
  const provider = normalizeProviderFilter(new URL(request.url).searchParams.get("provider"));

  try {
    const connections = await getGatewayConnectionsMetadata(principal, {
      isActive: true,
      ...(provider ? { provider } : {}),
    });
    const visible = filterConnectionsByGatewayScope(connections, principal);
    const accounts = deriveRemoteQuotaAccounts(visible, (id) => getSnapshot(id));

    return Response.json({ object: "list", accounts }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.warn("[API] Failed to fetch remote quota:", error?.message);
    return unavailable("Quota snapshots unavailable");
  }
}
