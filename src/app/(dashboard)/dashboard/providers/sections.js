import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  AI_PROVIDERS,
} from "@/shared/constants/providers";
import { getProviderStats } from "./utils";

// The API returns all credential shapes for a provider under the same provider id.
// Keep every shape in its catalog card: OAuth, imported tokens, API keys and cookies.
const CONNECTION_AUTH_TYPES = ["oauth", "apikey", "api_key", "cookie", "access_token"];

function dualAuthTypes() {
  return CONNECTION_AUTH_TYPES;
}

function sortOAuth(entries, connections) {
  return [...entries].sort((ea, eb) => {
    const pa = ea.info.priority ?? 999;
    const pb = eb.info.priority ?? 999;
    if (pa !== pb) return pa - pb;
    const sa = getProviderStats(connections, ea.id, CONNECTION_AUTH_TYPES);
    const sb = getProviderStats(connections, eb.id, CONNECTION_AUTH_TYPES);
    const ca = sa.connected > 0 ? 1 : 0;
    const cb = sb.connected > 0 ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return (ea.info.name || "").localeCompare(eb.info.name || "");
  });
}

export function PROVIDER_SECTIONS({ connections, providerNodes, statsFor }) {
  const compatibleEntries = (providerNodes || [])
    .filter((node) => node.type === "openai-compatible")
    .map((node) => ({
      id: node.id,
      info: {
        id: node.id,
        name: node.name || "OpenAI Compatible",
        apiType: node.apiType,
      },
      stats: statsFor(node.id, CONNECTION_AUTH_TYPES),
      authGroup: "compatible",
      authTypes: CONNECTION_AUTH_TYPES,
      isNoAuth: false,
      compatibleType: "openai",
      compatibleLabel: node.apiType === "responses" ? "Responses" : "Chat",
    }));

  const anthropicEntries = (providerNodes || [])
    .filter((node) => node.type === "anthropic-compatible")
    .map((node) => ({
      id: node.id,
      info: { id: node.id, name: node.name || "Anthropic Compatible" },
      stats: statsFor(node.id, CONNECTION_AUTH_TYPES),
      authGroup: "compatible",
      authTypes: CONNECTION_AUTH_TYPES,
      isNoAuth: false,
      compatibleType: "anthropic",
      compatibleLabel: "Messages",
    }));

  const oauthEntries = sortOAuth(
    Object.entries(OAUTH_PROVIDERS)
      .filter(([, info]) => !info.hidden)
      .map(([key, info]) => {
        const authTypes = dualAuthTypes(info, key);
        return {
          id: key,
          info,
          stats: statsFor(key, authTypes),
          authGroup: "oauth",
          authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
          isNoAuth: !!info.noAuth,
        };
      }),
    connections,
  );

  const freeEntries = Object.entries(FREE_PROVIDERS)
    .filter(([, info]) => !info.hidden)
    .map(([key, info]) => {
      const authTypes = dualAuthTypes(info, key);
      return {
        id: key,
        info,
        stats: statsFor(key, authTypes),
        authGroup: "free",
        authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
        isNoAuth: !!info.noAuth,
      };
    })
    .sort((ea, eb) => (eb.info.noAuth ? 1 : 0) - (ea.info.noAuth ? 1 : 0));

  const freeTierEntries = Object.entries(FREE_TIER_PROVIDERS)
    .filter(([, info]) => !info.hidden && (info.serviceKinds ?? ["llm"]).includes("llm"))
    .map(([key, info]) => {
      const authTypes = dualAuthTypes(info, key);
      return {
        id: key,
        info,
        stats: statsFor(key, authTypes),
        authGroup: "free",
        authTypes: Array.isArray(authTypes) ? authTypes : [authTypes],
        isNoAuth: !!info.noAuth,
      };
    })
    .sort((ea, eb) => {
      const pa = ea.info.priority ?? 999;
      const pb = eb.info.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const noAuthDiff = (eb.info.noAuth ? 1 : 0) - (ea.info.noAuth ? 1 : 0);
      if (noAuthDiff !== 0) return noAuthDiff;
      const ca = ea.stats.connected > 0 ? 0 : 1;
      const cb = eb.stats.connected > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (ea.info.name || "").localeCompare(eb.info.name || "");
    });

  const apikeyEntries = Object.entries(APIKEY_PROVIDERS)
    .filter(([, info]) => !info.hidden && (info.serviceKinds ?? ["llm"]).includes("llm"))
    .map(([key, info]) => ({
      id: key,
      info,
      stats: statsFor(key, CONNECTION_AUTH_TYPES),
      authGroup: "apikey",
      authTypes: CONNECTION_AUTH_TYPES,
      isNoAuth: !!info.noAuth,
    }))
    .sort((ea, eb) => {
      const ca = ea.stats.total > 0 ? 0 : 1;
      const cb = eb.stats.total > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (ea.info.name || "").localeCompare(eb.info.name || "");
    });

  // Hidden registry providers can still have live imported connections.
  // Surface those real accounts instead of dropping them from Providers totals.
  const listed = new Set(
    [
      ...oauthEntries,
      ...freeEntries,
      ...freeTierEntries,
      ...apikeyEntries,
      ...compatibleEntries,
      ...anthropicEntries,
    ].map((entry) => entry.id),
  );
  const connectedHiddenEntries = [...new Set(connections.map((c) => c.provider))]
    .filter((id) => id && !listed.has(id))
    .map((id) => ({
      id,
      info: AI_PROVIDERS[id] || { id, name: id },
      stats: statsFor(id, CONNECTION_AUTH_TYPES),
      // Web cookies are entered as a key; iFlow's cookie uses its own exchange.
      authGroup: AI_PROVIDERS[id]?.authType === "cookie" ? "apikey" : "oauth",
      authTypes: CONNECTION_AUTH_TYPES,
      isNoAuth: false,
    }));

  return [
    {
      id: "oauth",
      title: "Subscriptions & OAuth",
      subtitle: "Sign in once. 9router refreshes tokens for you.",
      entries: [...oauthEntries, ...connectedHiddenEntries],
      totalCount: oauthEntries.length + connectedHiddenEntries.length,
    },
    {
      id: "free",
      title: "Free tier providers",
      subtitle: "Free quotas and no-key proxies.",
      entries: [...freeEntries, ...freeTierEntries],
      totalCount: freeEntries.length + freeTierEntries.length,
    },
    {
      id: "apikey",
      title: "API keys & free tiers",
      subtitle: "Paste a key, pick models, done.",
      entries: apikeyEntries,
      totalCount: apikeyEntries.length,
    },
    {
      id: "custom",
      title: "Custom providers",
      subtitle: "OpenAI- or Anthropic-compatible endpoints.",
      entries: [...compatibleEntries, ...anthropicEntries],
      totalCount: compatibleEntries.length + anthropicEntries.length,
    },
  ];
}
