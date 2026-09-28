import {
  AI_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  LIVE_MODEL_PROVIDERS,
  OAUTH_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderBrand } from "@/shared/constants/providerBrands";

/** OAuth plus compatible dual-auth connection labels preserved from the page. */
export function connectionLabels(providerId) {
  return {
    oauth:
      providerId === "xai"
        ? "Grok Build OAuth"
        : providerId === "grok-cli"
          ? "Grok CLI Device Login"
          : providerId === "kimi"
            ? "Kimi Coding OAuth"
            : "OAuth",
    apiKey:
      providerId === "xai"
        ? "xAI API Key"
        : providerId === "kimi"
          ? "Kimi API Key"
          : providerId === "qoder"
            ? "PAT"
            : "API Key",
  };
}

/** Provider info resolution preserved from the detail page. */
export function resolveProviderInfo(providerId, providerNode) {
  if (providerNode) {
    return {
      id: providerNode.id,
      name:
        providerNode.name ||
        (providerNode.type === "anthropic-compatible"
          ? "Anthropic Compatible"
          : "OpenAI Compatible"),
      color: getProviderBrand(providerNode.type).color,
      textIcon: providerNode.type === "anthropic-compatible" ? "AC" : "OC",
      apiType: providerNode.apiType,
      baseUrl: providerNode.baseUrl,
      type: providerNode.type,
    };
  }
  return (
    OAUTH_PROVIDERS[providerId] ||
    APIKEY_PROVIDERS[providerId] ||
    FREE_PROVIDERS[providerId] ||
    FREE_TIER_PROVIDERS[providerId] ||
    WEB_COOKIE_PROVIDERS[providerId] ||
    null
  );
}

/** Auth-mode flags preserved from the detail page. */
export function providerAuthFlags(providerId, providerInfo) {
  const authModes = providerInfo?.authModes || [];
  const isOAuth =
    !!OAUTH_PROVIDERS[providerId] || !!FREE_PROVIDERS[providerId] || authModes.includes("oauth");
  const supportsApiKey = !!APIKEY_PROVIDERS[providerId] || authModes.includes("apikey");
  return {
    authModes,
    isOAuth,
    supportsApiKey,
    isFreeNoAuth: !!FREE_PROVIDERS[providerId]?.noAuth,
    isOpenAICompatible: isOpenAICompatibleProvider(providerId),
    isAnthropicCompatible: isAnthropicCompatibleProvider(providerId),
  };
}

/** Static model catalog and live-catalog flag for a provider. */
export function providerCatalog(providerId) {
  return {
    staticModels: getModelsByProviderId(providerId),
    isLiveCatalog: LIVE_MODEL_PROVIDERS.includes(providerId),
  };
}

/** Public live-model fetcher config for a provider id, if configured. */
export function getModelsFetcher(providerId) {
  return (
    OAUTH_PROVIDERS[providerId] ||
    APIKEY_PROVIDERS[providerId] ||
    FREE_PROVIDERS[providerId] ||
    FREE_TIER_PROVIDERS[providerId]
  )?.modelsFetcher;
}

/** Storage/display aliases preserved from the detail page. */
export function providerAliases(providerId, providerNode, isCompatible) {
  const storageAlias = isCompatible ? providerId : getProviderAlias(providerId);
  return {
    storageAlias,
    displayAlias: isCompatible ? providerNode?.prefix || providerId : getProviderAlias(providerId),
  };
}

/** Region-aware provider config for credential modals. */
export function providerRegionConfig(providerId) {
  return AI_PROVIDERS?.[providerId] || null;
}
