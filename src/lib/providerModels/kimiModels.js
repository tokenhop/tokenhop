// Live model catalog for Kimi Coding (api.kimi.com/coding/v1/models), API key
// or OAuth (Kimi Code subscription). Same credential precedence as chat
// requests: apiKey wins; an API-key rejection never triggers OAuth refresh.

import { buildKimiHeaders } from "open-sse/config/appConstants.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { refreshTokenByProvider } from "open-sse/services/tokenRefresh.js";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const KIMI_MODELS_URL = "https://api.kimi.com/coding/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const NO_MODELS = "Kimi returned no live models.";
// Fixed transport-failure message: never interpolate upstream bodies, tokens,
// proxy URLs or raw exception text into warnings or helper logs.
const REQUEST_FAILED = "Kimi catalog request failed";

export function parseKimiModels(body) {
  if (!Array.isArray(body?.data)) return [];
  const seen = new Set();
  const models = [];
  for (const row of body.data) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue; // first valid id wins
    seen.add(id);

    const name =
      typeof row.display_name === "string" && row.display_name.trim()
        ? row.display_name.trim()
        : id;

    // Positive integer context only; no string/NaN/fractional coercion.
    const contextLength =
      typeof row.context_length === "number" &&
      Number.isInteger(row.context_length) &&
      row.context_length > 0
        ? row.context_length
        : undefined;

    // Declared booleans only (explicit false survives); absent keys omitted.
    const capabilities = {};
    if (typeof row.supports_reasoning === "boolean")
      capabilities.reasoning = row.supports_reasoning;
    if (typeof row.supports_image_in === "boolean") capabilities.vision = row.supports_image_in;
    if (typeof row.supports_video_in === "boolean") capabilities.videoInput = row.supports_video_in;
    if (contextLength !== undefined) capabilities.contextWindow = contextLength;

    const inputModalities = ["text"];
    if (row.supports_image_in === true) inputModalities.push("image");
    if (row.supports_video_in === true) inputModalities.push("video");

    models.push({
      id,
      name,
      kind: "llm", // explicit: chat catalog, never video-generation
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      inputModalities,
    });
  }
  return models;
}

/**
 * Sanitized catalog transport. Fetches via the connection's resolved proxy,
 * with executor Kimi headers, a 10s timeout and redirect rejection. Non-OK
 * responses are returned bodyless (status retained) so the shared OAuth
 * helper never sees or logs upstream bodies; OK bodies are parsed here and
 * re-serialized, so malformed JSON cannot leak raw contents through helper
 * logs. Transport/JSON failures throw a fixed safe message.
 */
const makeCatalogFetch = (connection, proxyOptions) => async (token) => {
  let response;
  try {
    response = await proxyAwareFetch(
      KIMI_MODELS_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...buildKimiHeaders(connection.providerSpecificData?.deviceId),
        },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      proxyOptions,
    );
  } catch {
    throw new Error(REQUEST_FAILED);
  }
  if (!response.ok) {
    try {
      await response.text(); // drain, then discard
    } catch {
      /* body already unavailable */
    }
    return new Response(null, { status: response.status });
  }
  try {
    return Response.json(await response.json(), { status: 200 });
  } catch {
    throw new Error(REQUEST_FAILED);
  }
};

export async function resolveKimi(connection) {
  try {
    const apiKey = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
    const accessToken = typeof connection.accessToken === "string" ? connection.accessToken : "";
    if (!apiKey && !accessToken) {
      return { models: [], warning: "No valid token found" };
    }

    // Strict/pool/relay proxy policy resolved once, shared by the catalog GET,
    // the engine refresh dispatcher and the retry.
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    if (proxy.source === "error") {
      return { models: [], warning: `Failed to fetch Kimi models: proxy resolution failed` };
    }
    const proxyOptions = {
      connectionProxyEnabled: proxy.connectionProxyEnabled === true,
      connectionProxyUrl: proxy.connectionProxyUrl || "",
      connectionNoProxy: proxy.connectionNoProxy || "",
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: proxy.strictProxy === true,
      connectionProxyPoolId: proxy.proxyPoolId || "",
    };
    const fetchCatalog = makeCatalogFetch(connection, proxyOptions);

    if (apiKey) {
      const response = await fetchCatalog(apiKey);
      if (!response.ok)
        return { models: [], warning: `Failed to fetch Kimi models: ${response.status}` };
      const models = parseKimiModels(await response.json());
      return models.length ? { models } : { models: [], warning: NO_MODELS };
    }

    const result = await buildOAuthResolver({
      // Engine dispatcher (accepts proxy options); null logger keeps refresh
      // responses out of shared logs. Refresh failures degrade to null so raw
      // transport errors never reach the helper's warning/log path.
      refreshFn: async (conn) => {
        try {
          return await refreshTokenByProvider("kimi", conn, null, proxyOptions);
        } catch {
          return null;
        }
      },
      fetchFn: fetchCatalog,
      parseFn: parseKimiModels,
      errorLabel: "Failed to fetch Kimi models",
    })(connection);
    if (result.error) return { models: [], warning: result.error };
    if (!result.models?.length) return { models: [], warning: result.warning || NO_MODELS };
    return { models: result.models };
  } catch {
    return { models: [], warning: "Failed to fetch Kimi models." };
  }
}
