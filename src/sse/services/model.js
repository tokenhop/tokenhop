// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodesUnscoped } from "@/lib/localDb";
import { getGatewayNodes, requireGatewayWorkspace } from "@/lib/auth/gatewayResources.js";
import {
  parseModel as parseModelCore,
  resolveModelAliasFromMap,
  getModelInfoCore,
} from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve).
 * With options.principal (hashed gateway auth), provider-node prefix matches
 * come from the principal's workspace only; combos/aliases stay instance
 * config (they carry no credentials).
 */
export async function getModelInfo(modelStr, options = {}) {
  const principal = options.principal || null;
  await requireGatewayWorkspace(principal);
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const nodeTypes = ["openai-compatible", "anthropic-compatible", "custom-embedding"];
      let nodes;
      if (principal) {
        nodes = await getGatewayNodes(principal, {});
        nodes = nodes.filter((node) => nodeTypes.includes(node.type));
      } else {
        const byType = await Promise.all(
          nodeTypes.map((type) => getProviderNodesUnscoped({ type })),
        );
        nodes = byType.flat();
      }
      const matchedNode = nodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedNode) {
        return { provider: matchedNode.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  if (principal) {
    const resolved = await resolveModelAlias(modelStr);
    if (resolved) return getModelInfo(`${resolved.provider}/${resolved.model}`, options);
  }
  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (typeof modelStr !== "string" || modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
