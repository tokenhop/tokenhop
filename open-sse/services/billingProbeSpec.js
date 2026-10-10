// YAN-1041 probe target resolution. Research-derived allowlist: max_tokens:1 is
// DOCUMENTED-safe only for anthropic / openai / deepseek / openrouter. Every
// other apikey-capable provider needs a verified safe minimum first and is
// excluded explicitly. A minimum is NEVER inferred from the transport format.
//
// Selection is registry-driven: cheapest PRICED non-reasoning chat model of the
// provider (reasoning models burn hidden tokens and reject tiny max_tokens).
// No model list in the registry (live-catalog providers) and no pricing entry
// are explicit exclusions — never "first model" fallbacks.
import { PROVIDER_MODELS } from "../providers/index.js";
import { getPricingForModel } from "../providers/pricing.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { BILLING_PROBE_CONFIG } from "../config/errorConfig.js";

/** Registry entries that support an apikey connection. */
export function apikeyRegistryEntries(registry) {
  return registry.filter(
    (r) =>
      r &&
      (r.category === "apikey" ||
        r.authType === "apikey" ||
        (Array.isArray(r.authModes) && r.authModes.includes("apikey"))),
  );
}

function pricedNonReasoningLlmModels(provider, models) {
  return (models || []).filter(
    (m) =>
      m &&
      (!m.kind || m.kind === "llm") &&
      getCapabilitiesForModel(provider, m.id).reasoning === false &&
      !!getPricingForModel(provider, m.id),
  );
}

function cheapest(provider, models) {
  let best = null;
  for (const m of models) {
    const p = getPricingForModel(provider, m.id);
    const key = (p.input || 0) + (p.output || 0);
    if (!best || key < best.key) best = { id: m.id, upstream: m.upstreamModelId, key };
  }
  return best;
}

// Explicit exclusion reasons (stable strings; coverage tests assert them).
export const PROBE_EXCLUDED = {
  notAllowlisted: "no verified safe minimum: only anthropic/openai/deepseek/openrouter",
  notApikey: "not an apikey provider in the registry",
  unsupportedFormat: "unsupported wire format (only openai/claude chat)",
  noRegistryModels: "no registry chat models (live-catalog provider)",
  noPricedModel: "no priced non-reasoning chat model",
};

/**
 * Resolve the probe target or an explicit exclusion reason.
 * @param {string} provider
 * @param {Array} registry - provider registry entries (callers inject the real
 *   REGISTRY; tests inject minimal entries)
 * @returns {{ spec: object|null, reason: string|null }}
 */
export function explainBillingProbe(provider, registry) {
  // hasOwn: "constructor"/"toString"/"__proto__" must never resolve to an
  // inherited Object.prototype member and be treated as a pinned override.
  if (Object.hasOwn(BILLING_PROBE_CONFIG.providers, provider)) {
    return {
      spec: { ...BILLING_PROBE_CONFIG.providers[provider], source: "override" },
      reason: null,
    };
  }
  if (!BILLING_PROBE_CONFIG.allowlist.includes(provider)) {
    return { spec: null, reason: PROBE_EXCLUDED.notAllowlisted };
  }
  const entry = apikeyRegistryEntries(registry).find((r) => r.id === provider);
  if (!entry) return { spec: null, reason: PROBE_EXCLUDED.notApikey };
  // The registry leaves `format` off for the default OpenAI chat transport
  // (same default getTargetFormat applies); this is only a format read, the
  // allowlist above is what establishes the max_tokens:1 guarantee.
  const format = entry.transport?.format ?? "openai";
  if (format !== "openai" && format !== "claude") {
    return { spec: null, reason: PROBE_EXCLUDED.unsupportedFormat };
  }
  const models = entry.models || [];
  if (!models.some((m) => !m.kind || m.kind === "llm")) {
    return { spec: null, reason: PROBE_EXCLUDED.noRegistryModels };
  }
  const priced = pricedNonReasoningLlmModels(provider, models);
  const best = priced.length ? cheapest(provider, priced) : null;
  if (!best) return { spec: null, reason: PROBE_EXCLUDED.noPricedModel };
  return {
    spec: {
      format,
      model: best.id,
      upstreamModelId: best.upstream || undefined,
      maxTokens: 1,
      maxTokensField: "max_tokens",
      disableThinking: false,
      source: "registry",
    },
    reason: null,
  };
}

/** Spec only (null when excluded). */
export function resolveBillingProbeSpec(provider, registry) {
  return explainBillingProbe(provider, registry).spec;
}
