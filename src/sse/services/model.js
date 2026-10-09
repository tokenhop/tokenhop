// Re-export from open-sse with localDb integration
import {
  getModelAliases,
  getComboByName as getComboByNameUnscoped,
  getProviderNodesUnscoped,
} from "@/lib/localDb";
import {
  getGatewayNodes,
  getGatewayCombos,
  getGatewayAliases,
  requireGatewayWorkspace,
} from "@/lib/auth/gatewayResources.js";
import {
  parseModel as parseModelCore,
  resolveModelAliasFromMap,
  getModelInfoCore,
} from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import {
  OPENAI_COMPATIBLE_API_TYPES,
  resolveOpenAICompatibleApiType,
} from "open-sse/services/provider.js";
import { getProviderNodeMetadataByIdUnscoped } from "@/lib/db/repos/nodesRepo.js";
import * as log from "../utils/logger.js";

// ponytail: one process-wide warning per minute; add per-connection tracking if logs prove too coarse.
const MISSING_API_TYPE_WARN_MS = 60_000;
let lastMissingApiTypeWarn = 0;

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
 * API type for an openai-compatible connection. A valid stored
 * providerSpecificData.apiType wins (no lookup). Otherwise the current node's
 * apiType (same workspace, type openai-compatible) beats the legacy node-id
 * substring fallback. Lookup errors propagate; nothing is cached or written.
 */
export async function resolveOpenAICompatibleConnectionApiType(connection) {
  const stored = connection?.providerSpecificData?.apiType;
  if (OPENAI_COMPATIBLE_API_TYPES.includes(stored)) return stored;
  const now = Date.now();
  if (now - lastMissingApiTypeWarn >= MISSING_API_TYPE_WARN_MS) {
    lastMissingApiTypeWarn = now;
    log.warn(
      "MODEL",
      `openai-compatible connection ${String(connection?.id || "unknown").slice(0, 8)} has no valid stored apiType; resolving from node`,
    );
  }
  if (typeof connection?.provider === "string") {
    const node = await getProviderNodeMetadataByIdUnscoped(connection.provider);
    if (
      node?.type === "openai-compatible" &&
      OPENAI_COMPATIBLE_API_TYPES.includes(node.apiType) &&
      (node.workspaceId ?? null) === (connection.workspaceId ?? null)
    ) {
      return node.apiType;
    }
  }
  return resolveOpenAICompatibleApiType(connection?.provider, connection);
}

/**
 * Resolve model alias. With options.principal, only that workspace's aliases
 * are read (no global fallback); otherwise the legacy global map.
 */
export async function resolveModelAlias(alias, options = {}) {
  const aliases = options.principal
    ? await getGatewayAliases(options.principal)
    : await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Combo lookup by name. With options.principal, only that workspace's combos
 * are searched (no global fallback); otherwise the legacy global lookup.
 */
export async function getComboByName(modelStr, options = {}) {
  if (options.principal) {
    const combos = await getGatewayCombos(options.principal);
    return combos.find((c) => c.name === modelStr) || null;
  }
  return getComboByNameUnscoped(modelStr);
}

/**
 * Get full model info (parse or resolve).
 * With options.principal (hashed gateway auth), provider-node prefix matches,
 * combos and aliases come from the principal's workspace only; a scoped miss
 * falls through to built-ins, never to global config.
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
  const combo = await getComboByName(parsed.model, { principal });
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  if (principal) {
    const resolved = await resolveModelAlias(modelStr, { principal });
    if (resolved) return getModelInfo(`${resolved.provider}/${resolved.model}`, options);
    // Scoped miss: built-ins only (never the global alias map).
    return getModelInfoCore(modelStr, {});
  }
  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr, options = {}) {
  // Only check if it's not in provider/model format
  if (typeof modelStr !== "string" || modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr, options);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
