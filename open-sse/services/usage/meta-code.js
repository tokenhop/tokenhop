/**
 * Meta Code (Muse Spark) subscription usage — read from the key-mint response,
 * which is the only Meta endpoint exposing 5h/weekly usage. Needs the `dca:`
 * device token (stored as refreshToken); plain API keys are rejected by mint.
 */

import { mintMetaCodeKey } from "../metaCode.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

// Dashboard polls every 60s; cache so each poll doesn't hit Meta. `force` bypasses.
const CACHE_TTL_MS = 60000;
const cache = new Map(); // dcaToken → { at, value }

function percentQuota(win) {
  const used = Math.min(100, Math.max(0, toFiniteNumber(win?.used_percent, 0)));
  return {
    used,
    total: 100,
    remainingPercentage: 100 - used,
    resetAt: parseResetTime(win?.resets_at),
    unlimited: false,
  };
}

/** Map Meta `subs_usage` ({window, weekly}) to dashboard percent quotas. */
export function parseMetaSubsUsage(subs) {
  const quotas = {};
  if (subs?.window) quotas["Session (5h)"] = percentQuota(subs.window);
  if (subs?.weekly) quotas.Weekly = percentQuota(subs.weekly);
  return quotas;
}

// Meta omits `subs_usage` until a request opens a usage window (idle subscription).
const IDLE_MESSAGE = "No active usage window yet. Quota appears after the next Meta Code request.";

async function fetchMetaCodeUsage(dcaToken, proxyOptions) {
  try {
    const data = await mintMetaCodeKey(dcaToken, proxyOptions);
    if (!data.is_subs_active) {
      return { plan: "Pay-as-you-go", message: "No active Muse Code subscription." };
    }
    const plan = data.subs_tier_name || "Muse Code";
    const quotas = parseMetaSubsUsage(data.subs_usage);
    return Object.keys(quotas).length ? { plan, quotas } : { plan, message: IDLE_MESSAGE };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return { message: "Meta Code sign-in expired. Please re-authorize." };
    }
    return { message: `Meta Code connected. Unable to fetch usage: ${error.message}` };
  }
}

export async function getMetaCodeUsage(dcaToken, proxyOptions = null, { force = false } = {}) {
  if (!dcaToken) {
    return { message: "Quota is only available for Meta Code accounts connected via sign-in." };
  }
  const hit = cache.get(dcaToken);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fetchMetaCodeUsage(dcaToken, proxyOptions);
  cache.set(dcaToken, { at: Date.now(), value });
  return value;
}
