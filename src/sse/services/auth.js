import {
  getProviderConnectionsUnscoped,
  validateApiKey,
  updateProviderConnectionUnscoped,
  getProxyPools,
} from "@/lib/localDb";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import {
  formatRetryAfter,
  checkFallbackError,
  isModelLockActive,
  buildModelLockUpdate,
  getModelLockUntil,
} from "open-sse/services/accountFallback.js";
import { getActiveReliabilityPolicy } from "open-sse/config/reliabilityPolicy.js";
import { getExhaustedUntil, getSnapshot } from "open-sse/services/quotaSnapshot.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { extractClientApiKey } from "@/lib/auth/clientApiKey.js";
import { getGatewayConnections, requireGatewayWorkspace } from "@/lib/auth/gatewayResources.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { resolveWeightedStickyLimit, selectWeightedConnection } from "./accountSelection.js";
import { boundedMap } from "open-sse/utils/boundedMap.js";
import {
  checkAndReserveGrant,
  grantAllowsModel,
  grantEstimator,
  grantLimitedResult,
  grantLimitHit,
  releaseGrantReservation,
} from "./grantRateLimiter.js";
import {
  budgetLimitedResult,
  grantBudgetContext,
  grantBudgetLimit,
  reserveGrantBudget,
} from "./budgetGuard.js";
import { resolveOpenAICompatibleConnectionApiType } from "./model.js";
import * as log from "../utils/logger.js";

// Per-key mutex chain tails to prevent race conditions during account selection.
// Key: `${workspaceId}:${providerId}` under a gateway principal, null (one global
// slot, the legacy behavior) otherwise. Entries drain when their chain ends.
const selectionMutexes = new Map();

// SWRR cursor, keyed by provider. Threshold/sticky counts live in the DB.
const weightedStates = boundedMap(1000);

export function resetAccountSelection(providerId) {
  if (providerId) {
    const id = resolveProviderId(providerId) ?? providerId;
    weightedStates.delete(id);
    // Partitioned keys carry the principal workspace prefix (YAN-363).
    for (const key of weightedStates.keys()) {
      if (key.endsWith(`:${id}`)) weightedStates.delete(key);
    }
  } else {
    weightedStates.clear();
  }
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (
    !String(errorText || "")
      .toLowerCase()
      .includes(GITHUB_MONTHLY_USAGE_LIMIT)
  )
    return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

// Granted connections are shared state: never persist per-use rotation counters
// on them (in-memory SWRR cursor stays per workspace).
const persistUse = (connection, patch) =>
  connection.grantId ? undefined : updateProviderConnectionUnscoped(connection.id, patch);

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(
  provider,
  excludeConnectionIds = null,
  model = null,
  options = {},
) {
  // Normalize to Set for consistent handling
  const excludeSet =
    excludeConnectionIds instanceof Set
      ? excludeConnectionIds
      : excludeConnectionIds
        ? new Set([excludeConnectionIds])
        : new Set();
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const mutexKey = options?.principal
    ? `${options.principal.workspaceId}:${resolveProviderId(provider) ?? provider}`
    : null;
  const currentMutex = selectionMutexes.get(mutexKey) ?? Promise.resolve();
  let resolveMutex;
  const tail = new Promise((resolve) => {
    resolveMutex = resolve;
  });
  selectionMutexes.set(mutexKey, tail);

  try {
    await currentMutex;

    await requireGatewayWorkspace(options?.principal);

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getEffectivePreferences(options?.principal ?? null);
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter((p) => p.proxyUrl).map((p) => p.id);
        const poolKey = options?.principal
          ? `${options.principal.workspaceId}:${providerId}`
          : providerId;
        pickedId = pickProxyPoolId(poolIds, strategy, poolKey);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await (options?.principal
      ? getGatewayConnections(options.principal, { provider: providerId, isActive: true })
      : getProviderConnectionsUnscoped({ provider: providerId, isActive: true }));
    log.debug(
      "AUTH",
      `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`,
    );

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, quota-snapshot-exhausted (YAN-384), and
    // Antigravity quota-exhausted connections. Unknown quota stays eligible.
    const quotaExpiries = [];
    const grantLimits = [];
    const budgetLimits = [];
    const estimateTokens = grantEstimator(options?.estimateTokens);
    // YAN-372: grant budgets apply only when routed through that grant; null
    // (zero cost) outside a budgeted request or when no grant budget exists.
    const budgetCtx = grantBudgetContext();
    const availableConnections = connections.filter((c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (c.grantId) {
        if (!grantAllowsModel(c, providerId, model, c.id === preferredConnectionId)) return false;
        const hit = grantLimitHit(c, c.grantTpm != null ? estimateTokens() : 0);
        if (hit) {
          grantLimits.push(hit);
          return false;
        }
        const budgetHit = grantBudgetLimit(c.grantId, budgetCtx);
        if (budgetHit) {
          budgetLimits.push(budgetHit);
          return false;
        }
      }
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (
          quota &&
          quota.remainingPercentage <= 0 &&
          quota.resetAt &&
          new Date(quota.resetAt).getTime() > Date.now()
        ) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info(
            "AG_QUOTA",
            `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`,
          );
          return false;
        }
      }
      // After the Antigravity block so its exact resetAt wins for retry timing.
      // An explicit x-connection-id pin (e.g. video job polling) is account-bound:
      // skipping it would silently swap accounts, so the pin wins over quota.
      if (c.id === preferredConnectionId) return true;
      const snapshot = getSnapshot(c.id);
      const quotaUntil =
        snapshot && resolveProviderId(snapshot.provider) === providerId
          ? getExhaustedUntil(snapshot, model)
          : 0;
      if (quotaUntil) {
        const until = new Date(quotaUntil).toISOString();
        quotaExpiries.push(until);
        log.info("AUTH", `${c.id?.slice(0, 8)} | QUOTA_SKIP ${model || "all"} until ${until}`);
        return false;
      }
      return true;
    });

    log.debug(
      "AUTH",
      `${provider} | available: ${availableConnections.length}/${connections.length}`,
    );
    connections.forEach((c) => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getModelLockUntil(c, model);
        log.debug(
          "AUTH",
          `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`,
        );
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      // Each blocker carries its owner so lastError/lastErrorCode describe the account that
      // actually unblocks first. Quota-snapshot/Antigravity-cache entries own no connection.
      const blockers = [
        ...connections
          .filter((c) => isModelLockActive(c, model))
          .map((c) => ({ until: getModelLockUntil(c, model), conn: c })),
        ...quotaExpiries.map((until) => ({ until })),
      ];
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now())
            blockers.push({ until: resetAt });
        });
      }
      // Compare by parsed time: lock ISO and Antigravity resetAt formats may differ.
      let earliestBlocker = null;
      for (const b of blockers) {
        if (!b.until) continue;
        if (!earliestBlocker || Date.parse(b.until) < Date.parse(earliestBlocker.until)) {
          earliestBlocker = b;
        }
      }
      if (earliestBlocker) {
        const earliest = earliestBlocker.until;
        const lastError = earliestBlocker.conn
          ? earliestBlocker.conn.lastError || null
          : "Quota exhausted";
        log.warn(
          "AUTH",
          `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${lastError?.slice(0, 50) ?? "none"}`,
        );
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          // Deliberately not "rate limit"/"quota exceeded": those text rules
          // back off, which would delay combo fallthrough to the next member.
          lastError,
          lastErrorCode: earliestBlocker.conn?.errorCode || null,
        };
      }
      if (grantLimits.length) {
        log.warn("AUTH", `${provider} | all candidates skipped by grant ${grantLimits[0]} limit`);
        return grantLimitedResult(grantLimits[0]);
      }
      if (budgetLimits.length) {
        log.warn("AUTH", `${provider} | all candidates skipped by grant budget`);
        return budgetLimitedResult(budgetLimits[0]);
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getEffectivePreferences(options?.principal ?? null);
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    if (
      options?.principal &&
      preferredConnectionId &&
      !availableConnections.some((c) => c.id === preferredConnectionId)
    )
      return null;

    // Pin to preferred connection if specified and available. With a gateway
    // principal the pin must be a connection in that workspace: a foreign id
    // simply doesn't resolve, so no cross-workspace credential is ever used.
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info(
          "AUTH",
          `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`,
        );
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "weighted") {
      // Partition sticky state by workspace under gateway principals so two
      // workspaces never share rotation cursors on the same provider.
      const weightedKey = options?.principal
        ? `${options.principal.workspaceId}:${providerId}`
        : providerId;
      const stickyLimit = resolveWeightedStickyLimit(providerId, providerOverride, settings);
      const result = selectWeightedConnection({
        connections: availableConnections,
        provider: providerId,
        model,
        stickyLimit,
        state: weightedStates.get(weightedKey),
      });
      connection = result.connection ?? availableConnections[0];
      weightedStates.set(weightedKey, result.nextState);
      // Persist sticky window exactly as round-robin does.
      await persistUse(connection, {
        lastUsedAt: new Date().toISOString(),
        consecutiveUseCount: result.continued ? (connection.consecutiveUseCount || 0) + 1 : 1,
      });
    } else if (strategy === "round-robin") {
      const stickyLimit =
        providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await persistUse(connection, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1,
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await persistUse(connection, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1,
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnectionsUnscoped)
      connection = availableConnections[0];
    }

    // Resolve before reserving grants so a failed node lookup never leaks a reservation.
    const apiTypePatch = String(connection.provider || providerId).startsWith("openai-compatible-")
      ? { apiType: await resolveOpenAICompatibleConnectionApiType(connection) }
      : {};

    // Reserve rpm/tpm on the chosen grant (sync check+reserve, atomic). A lost
    // race against another workspace using the same grant reads as rate-limited.
    let grantReservation = null;
    if (connection.grantId) {
      grantReservation = checkAndReserveGrant(
        connection,
        connection.grantTpm != null ? estimateTokens() : 0,
      );
      if (grantReservation === false) {
        return grantLimitedResult(grantLimitHit(connection, estimateTokens()) ?? "rpm");
      }
      // YAN-372: reserve the chosen grant's budgets (sync, atomic). The
      // request wrapper releases it when the response ends; fallback leaves it
      // held until then (bounded over-reservation, never under-counting).
      const budget = reserveGrantBudget(connection.grantId, budgetCtx);
      if (budget?.hit) {
        releaseGrantReservation(grantReservation);
        return budgetLimitedResult(budget.hit);
      }
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      grantId: connection.grantId ?? null,
      grantReservation,
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName:
        connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
        ...apiTypePatch,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
    };
  } finally {
    resolveMutex();
    if (selectionMutexes.get(mutexKey) === tail) selectionMutexes.delete(mutexKey);
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(
  connectionId,
  status,
  errorText,
  provider = null,
  model = null,
  resetsAtMs = null,
  { grantId = null } = {},
) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  // YAN-369 (ADR-0006): a grantee's failure falls back for this request only;
  // it never locks or cools down the owner's connection row.
  if (grantId) {
    const { shouldFallback } = checkFallbackError(status, errorText, 0);
    return { shouldFallback: !!shouldFallback, cooldownMs: 0 };
  }
  const connections = await getProviderConnectionsUnscoped({ provider });
  const conn = connections.find((c) => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    const capMs = getActiveReliabilityPolicy().cooldowns.rateLimitCapMs;
    cooldownMs =
      resolveProviderId(provider) === "antigravity"
        ? resetsAtMs - Date.now()
        : Math.min(resetsAtMs - Date.now(), capMs);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(
      status,
      errorText,
      backoffLevel,
    ));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnectionUnscoped(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn(
    "AUTH",
    `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`,
  );

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  // YAN-369: a grantee's success never rewrites the owner's health state.
  if (currentConnection?.grantId) return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter((k) => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter((k) => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true; // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now; // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter((k) => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map((k) => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  }

  await updateProviderConnectionUnscoped(connectionId, clearObj);
}

/**
 * Extract client API key (Bearer -> x-api-key -> x-goog-api-key -> ?key=).
 */
export function extractApiKey(request) {
  return extractClientApiKey(request);
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
