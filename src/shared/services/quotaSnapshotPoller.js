// Quota snapshot poller (YAN-259): backfills the snapshot store from USAGE_HANDLERS
// probes for connections of weighted providers/combos. Never sends chat pings.
// DI shape mirrors quotaAutoPing: runQuotaSnapshotTick(deps, state).
import "open-sse/index.js";

import {
  getSettings,
  getProviderConnectionsUnscoped,
  getCombosUnscoped,
  getModelAliasesUnscoped,
  updateProviderConnectionUnscoped,
} from "@/lib/localDb";
import { listEffectivePreferencesUnscoped } from "@/lib/db/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getSnapshot } from "open-sse/services/quotaSnapshot.js";
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { comboMemberProviders, weightedProviders } from "./weightedTargets.js";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import {
  fetchAndPersistClaudePlanTier,
  recordUsageSnapshot,
} from "@/sse/services/quotaSnapshotSync";

const C = QUOTA_SNAPSHOT.poller;

// Survive Next.js hot reload; one scheduler per server process.
if (!global.__quotaSnapshotPoller) {
  global.__quotaSnapshotPoller = {
    timer: null,
    running: false,
    failureCache: {},
  };
}
const g = global.__quotaSnapshotPoller;

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    strictProxy: cfg?.strictProxy === true,
    connectionProxyPoolId: cfg?.proxyPoolId || null,
  };
}

// Same eligibility as GET /api/usage/[connectionId].
function isEligible(connection) {
  if (connection?.authType === "oauth") return true;
  const isApikey = connection?.authType === "apikey" || connection?.authType === "api_key";
  return isApikey && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
}

export function createDefaultDeps() {
  return {
    getSettings,
    listPreferencesUnscoped: listEffectivePreferencesUnscoped,
    getProviderConnectionsUnscoped,
    getCombos: getCombosUnscoped,
    getModelAliases: getModelAliasesUnscoped,
    updateProviderConnectionUnscoped,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getUsageForProvider,
  };
}

const FAILURE_CACHE_CAP = 1000;

function pruneFailureCache(failureCache) {
  const cutoff = Date.now() - C.failureCooldownMs;
  for (const [key, at] of Object.entries(failureCache)) {
    if (at <= cutoff) delete failureCache[key];
  }
  const keys = Object.keys(failureCache);
  if (keys.length > FAILURE_CACHE_CAP) {
    for (const key of keys
      .sort((a, b) => failureCache[a] - failureCache[b])
      .slice(0, keys.length - FAILURE_CACHE_CAP)) {
      delete failureCache[key];
    }
  }
}

function fresh(connectionId) {
  const snapshot = getSnapshot(connectionId);
  return snapshot && Date.now() - snapshot.updatedAt < C.staleMs;
}

async function pollConnection(connection, deps, state) {
  const key = `${connection.provider}:${connection.id}`;
  if (state.failureCache[key] && Date.now() - state.failureCache[key] < C.failureCooldownMs) {
    return;
  }
  try {
    const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = buildProxyOptions(proxyConfig);
    // Reuse route refresh for OAuth only; API keys have no refresh flow.
    const freshConnection =
      connection.authType === "oauth"
        ? (await deps.refreshAndUpdateCredentials(connection, false, proxyOptions)).connection
        : connection;
    const usage = await deps.getUsageForProvider(freshConnection, proxyOptions, { force: false });
    if (!usage || typeof usage.message === "string") {
      state.failureCache[key] = Date.now();
      return;
    }
    await recordUsageSnapshot({
      connectionId: freshConnection.id,
      provider: freshConnection.provider,
      usage,
      fallbackTier:
        freshConnection.providerSpecificData?.planTierManual === true
          ? freshConnection.providerSpecificData?.chatgptPlanType
          : (freshConnection.providerSpecificData?.planTier ??
            freshConnection.providerSpecificData?.chatgptPlanType),
    });
    if (freshConnection.provider === "claude") {
      await fetchAndPersistClaudePlanTier(freshConnection, proxyOptions);
    }
    delete state.failureCache[key];
  } catch (error) {
    state.failureCache[key] = Date.now();
    console.warn(`[QuotaSnapshotPoller] ${key}: ${error?.message}`);
  }
}

export async function runQuotaSnapshotTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    if (!state.failureCache) state.failureCache = {};
    pruneFailureCache(state.failureCache);
    const settings = await deps.getSettings();
    const combos = deps.getCombos ? await deps.getCombos().catch(() => []) : [];
    const aliases = deps.getModelAliases ? await deps.getModelAliases().catch(() => ({})) : {};
    // Unscoped scheduler: union the weighted providers of EVERY effective
    // preference entry (instance + workspace overrides) — a provider weighted
    // for any workspace must have snapshot data.
    const settingsList = deps.listPreferencesUnscoped
      ? await deps.listPreferencesUnscoped().catch(() => null)
      : null;
    const prefs =
      Array.isArray(settingsList) && settingsList.length > 0 ? settingsList : [settings];
    const providers = new Set(comboMemberProviders(combos, aliases));
    for (const p of prefs) {
      for (const id of weightedProviders(p, combos, [], aliases)) providers.add(id);
    }
    if (
      prefs.some((p) => p?.fallbackStrategy === "weighted") &&
      deps.getProviderConnectionsUnscoped
    ) {
      try {
        const all = await deps.getProviderConnectionsUnscoped({ isActive: true });
        const allProviderIds = all.map((connection) => connection.provider);
        for (const p of prefs) {
          for (const id of weightedProviders(p, combos, allProviderIds, aliases)) {
            providers.add(id);
          }
        }
      } catch {
        // Keep the original provider set when the connection read fails.
      }
    }
    if (providers.size === 0) return;

    for (const provider of providers) {
      let connections = [];
      try {
        connections = await deps.getProviderConnectionsUnscoped({ provider, isActive: true });
      } catch {
        continue;
      }
      for (const connection of connections) {
        if (!isEligible(connection) || fresh(connection.id)) continue;
        await pollConnection(connection, deps, state);
      }
    }
  } catch (error) {
    console.warn(`[QuotaSnapshotPoller] tick: ${error?.message}`);
  } finally {
    state.running = false;
  }
}

export function startQuotaSnapshotPoller() {
  if (g.timer) return;
  console.log("[QuotaSnapshotPoller] scheduler started");
  runQuotaSnapshotTick().catch(() => {});
  g.timer = setInterval(() => {
    runQuotaSnapshotTick().catch(() => {});
  }, C.tickMs);
  if (g.timer.unref) g.timer.unref();
}

export function stopQuotaSnapshotPoller() {
  if (!g.timer) return;
  clearInterval(g.timer);
  g.timer = null;
  console.log("[QuotaSnapshotPoller] scheduler stopped");
}

// Weighted targets plus any combo member (YAN-384): start when some provider
// strategy, combo strategy, the global comboStrategy, or the global
// fallbackStrategy is weighted, or when any combo names a provider member so
// routing has quota data to skip 0%-quota providers.
function hasWeightedSettings(settings) {
  return (
    settings?.fallbackStrategy === "weighted" ||
    Object.values(settings?.providerStrategies || {}).some(
      (strategy) => strategy?.fallbackStrategy === "weighted",
    ) ||
    (settings?.comboStrategy || "fallback") === "weighted" ||
    Object.values(settings?.comboStrategies || {}).some(
      (strategy) => strategy?.fallbackStrategy === "weighted",
    )
  );
}

// `settings` may be one effective view or an array of them (instance +
// workspaces). The shared poller keeps running while ANY entry needs it, so
// one workspace going non-weighted never stops another's polling.
export function configureQuotaSnapshotPoller(settings, combos = [], aliases = {}) {
  const views = Array.isArray(settings) ? settings : [settings];
  if (views.some(hasWeightedSettings) || comboMemberProviders(combos, aliases).size > 0) {
    startQuotaSnapshotPoller();
  } else stopQuotaSnapshotPoller();
}

// Read settings + combos + model aliases from the DB and (re)configure the
// scheduler. Never throws. A combos or aliases read failure keeps a running
// scheduler (a DB blip must not stop polling); a stopped one starts only for
// weighted settings.
export async function syncQuotaSnapshotPoller({
  getSettings: readSettings = getSettings,
  getCombos: readCombos = getCombosUnscoped,
  getModelAliases: readAliases = getModelAliasesUnscoped,
  // Default reads the instance + every workspace view. An injected readSettings
  // without an injected list stays single-view (test seam).
  listPreferencesUnscoped: readPrefs = readSettings === getSettings
    ? listEffectivePreferencesUnscoped
    : null,
} = {}) {
  try {
    const instance = await readSettings();
    let settings = instance;
    if (readPrefs) {
      const list = await readPrefs().catch(() => null);
      if (Array.isArray(list) && list.length > 0) settings = [instance, ...list];
    }
    let combos;
    let aliases;
    try {
      combos = readCombos ? await readCombos() : [];
      aliases = readAliases ? await readAliases() : {};
    } catch (error) {
      console.warn(`[QuotaSnapshotPoller] sync: combos/aliases read failed: ${error?.message}`);
      if (!g.timer) configureQuotaSnapshotPoller(settings);
      return;
    }
    configureQuotaSnapshotPoller(settings, combos, aliases);
  } catch (error) {
    console.warn(`[QuotaSnapshotPoller] sync: ${error?.message}`);
  }
}
