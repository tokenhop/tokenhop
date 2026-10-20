import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;
// Keys include the client-supplied model id, so the memo is bounded: expired
// entries are swept on every insert and the oldest are evicted past the cap.
export const MODEL_CACHE_MAX = 512;

let cache = { value: null, expiresAt: 0 };

// Resolved (provider, model) pricing for the gateway hot path (budget estimate,
// usage settle). Every writer in this module and the import/restore paths call
// invalidate(); the generation guard drops a read that raced a write, and the
// TTL bounds anything that edits the kv rows behind our back.
const modelCache = new Map(); // `${provider}\0${model}` → { value, expiresAt }
let generation = 0;
let pricingModule = null;

function rememberModel(key, value, now) {
  for (const [k, entry] of modelCache) {
    if (entry.expiresAt <= now) modelCache.delete(k);
  }
  modelCache.delete(key); // re-insert so Map order stays oldest-first
  while (modelCache.size >= MODEL_CACHE_MAX) {
    modelCache.delete(modelCache.keys().next().value);
  }
  modelCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

function invalidate() {
  cache = { value: null, expiresAt: 0 };
  modelCache.clear();
  generation++;
}

export async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const key = `${provider ?? ""}\0${model}`;
  const hit = modelCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const startedAt = generation;
  // Targeted read of the one provider row; never scan the whole pricing scope.
  const providerRow = provider ? await pricingKv.get(String(provider)) : null;
  const user = providerRow?.[model];
  pricingModule ??= await import("open-sse/providers/pricing.js");
  const defaults = pricingModule.getPricingForModel(provider, model);
  const resolved = user && defaults ? { ...defaults, ...user } : user || defaults;
  // Shared across requests: frozen so no caller can corrupt later reads. Callers
  // only read rates (calculateCostFromTokens, billing probe); defaults stay unfrozen.
  const value =
    resolved && typeof resolved === "object" ? Object.freeze({ ...resolved }) : resolved;
  if (startedAt === generation) rememberModel(key, value, Date.now());
  return value;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? parseJson(row.value, {}) || {} : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)],
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? parseJson(row.value, {}) || {} : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)],
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}

export function invalidatePricingCache() {
  invalidate();
}
