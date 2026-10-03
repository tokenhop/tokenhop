// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionByIdUnscoped, updateProviderConnectionUnscoped } from "@/lib/localDb";
import { getConnection } from "@/lib/db/index.js";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import {
  buildQuotaSnapshotView,
  fetchAndPersistClaudePlanTier,
  getSnapshot,
  recordUsageSnapshot,
} from "@/sse/services/quotaSnapshotSync";
import { effectiveWeightFor } from "@/sse/services/accountSelection";
import { isWeightedProvider } from "@/shared/services/weightedTargets";
import { getQuotaForecasts } from "@/lib/quota/forecastStore.js";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt
      ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt }
      : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnectionUnscoped(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const force = new URL(request.url).searchParams.get("force") === "1";

    // YAN-361: switch on, only a connection in the principal's workspaces.
    // OAuth reads refresh (rotate) the row's tokens, so they need `use`.
    const loaded = await loadScoped(
      "workspace.connections.use",
      connectionId,
      getConnection,
      getProviderConnectionByIdUnscoped,
      "Connection not found",
    );
    if (loaded instanceof Response) return loaded;
    connection = loaded.row;

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth = connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible = isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    // Resolve connection proxy config; strictProxy comes from the pool so a down
    // proxy surfaces as an error instead of silently going direct from the host IP.
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: proxyConfig.strictProxy === true,
      connectionProxyPoolId: proxyConfig.proxyPoolId || null,
    };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json(
          {
            error: `Credential refresh failed: ${refreshError.message}`,
          },
          { status: 401 },
        );
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    // Additive snapshot: record this probe, then attach the view. Never fail the usage response.
    try {
      await recordUsageSnapshot({
        connectionId: connection.id,
        provider: connection.provider,
        usage,
        fallbackTier:
          connection.providerSpecificData?.planTierManual === true
            ? connection.providerSpecificData?.chatgptPlanType
            : (connection.providerSpecificData?.planTier ??
              connection.providerSpecificData?.chatgptPlanType),
      });
      // Weighted Claude only (extra upstream call); throttled 24h, never throws.
      if (connection.provider === "claude" && isOAuth && (await isWeightedProvider("claude"))) {
        await fetchAndPersistClaudePlanTier(connection, proxyOptions);
      }
    } catch {
      /* recordUsageSnapshot already swallows; belt for the response path */
    }

    const snapshot = getSnapshot(connection.id);
    const quotaSnapshot = buildQuotaSnapshotView(connection.id, {
      manualWeight: connection.providerSpecificData?.weight,
    }) ?? {
      planTier: connection.providerSpecificData?.planTier ?? null,
      windows: [],
      stale: true,
      updatedAt: null,
    };
    // Same tier rule as routing (manual psd.planTier wins over detected snapshot tier).
    quotaSnapshot.effectiveWeight = effectiveWeightFor(connection, { snapshot });
    // Forecast keys mirror `usage.quotas` keys (additive; never fails the response).
    let forecasts = {};
    try {
      forecasts = getQuotaForecasts(connection.id);
    } catch {
      /* in-memory store read must not break the usage response */
    }
    return Response.json({ ...usage, quotaSnapshot, forecasts });
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
