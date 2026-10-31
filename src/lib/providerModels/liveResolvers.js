// Per-provider live model catalogs, shared by GET /api/providers/[id]/models
// (dashboard, "Fetch Models") and GET /v1/models. A resolver takes a
// connection record and { forceRefresh } and resolves to { models, warning? }.
// An empty or failed catalog yields { models: [], warning } — callers keep
// their static list and surface the warning; nothing falls back silently.

import { ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshClaudeOAuthToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { connectionProxyOptions } from "@/lib/network/connectionProxy";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { resolveCodex } from "@/lib/providerModels/codexModels.js";
import {
  resolveAntigravity,
  resolveGemini,
  resolveGeminiCli,
} from "@/lib/providerModels/googleModels.js";
import { resolveVertex, resolveVertexPartner } from "@/lib/providerModels/vertexModels.js";
import { resolveXai } from "@/lib/providerModels/xaiModels.js";
import { resolveKimi } from "@/lib/providerModels/kimiModels.js";
import { resolveOpenAI } from "@/lib/providerModels/openaiModels.js";
import { resolveOpenRouter } from "@/lib/providerModels/openrouterModels.js";
import {
  resolveAlicode,
  resolveAlicodeIntl,
  resolveBazaarlink,
  resolveCerebras,
  resolveChutes,
  resolveDeepSeek,
  resolveFireworks,
  resolveGlm,
  resolveGlmCn,
  resolveGroq,
  resolveHyperbolic,
  resolveLlm7,
  resolveMinimax,
  resolveMinimaxCn,
  resolveMistral,
  resolveNebius,
  resolveNvidia,
  resolveOpencode,
  resolveOpencodeGo,
  resolvePerplexityAgent,
  resolveSambanova,
  resolveCohere,
  resolveTokenrouter,
  resolveKiloGateway,
  resolveAirforce,
  resolveSiliconFlow,
  resolveTogether,
  resolveVenice,
  resolveVercel,
} from "@/lib/providerModels/apiKeyModels.js";
import { resolveOllama, resolveOllamaLocal } from "@/lib/providerModels/ollamaModels.js";
import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";
import { normalizeLiveModelId } from "@/shared/utils/liveModels.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { ANTHROPIC_API_VERSION } from "open-sse/providers/shared.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { explainEmptyZedCatalog } from "open-sse/shared/zedModelDiagnostics.js";

// Short per-connection cache so page loads and /v1/models don't hit upstream on
// every call. forceRefresh (the Fetch Models button) bypasses and refills it.
export const LIVE_MODELS_TTL_MS = 60 * 1000;

const noModels = (label) => ({ models: [], warning: `${label} returned no live models.` });
const proxyFailure = (label) => ({
  models: [],
  warning: `Failed to fetch ${label} models: proxy resolution failed`,
});
const persistRefreshed = (connection) => async (refreshed) => {
  await updateProviderCredentials(connection.id, {
    ...refreshed,
    existingProviderSpecificData: connection.providerSpecificData || {},
  });
};

// ── Claude (Anthropic /v1/models) ─────────────────────────────────────────
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
// limit=1000 is Anthropic's maximum, so one page covers the catalog; the page
// cap only bounds a misbehaving has_more loop.
const ANTHROPIC_PAGE_LIMIT = 1000;
const ANTHROPIC_MAX_PAGES = 10;

// Fetches every page and returns a Response over { data: [...all] }, so the
// OAuth resolver can treat it like a single upstream response (refresh on 401).
async function fetchAllAnthropicModels(authHeaders, proxyOptions) {
  const headers = {
    "Anthropic-Version": ANTHROPIC_API_VERSION,
    "Content-Type": "application/json",
    ...authHeaders,
  };
  const data = [];
  let afterId = null;
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const url = `${ANTHROPIC_MODELS_URL}?limit=${ANTHROPIC_PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
    const response = await proxyAwareFetch(url, { method: "GET", headers }, proxyOptions);
    if (!response.ok) return response;
    const body = await response.json();
    data.push(...(body?.data || []));
    if (!body?.has_more || !body?.last_id) break;
    afterId = body.last_id;
  }
  return Response.json({ data });
}

const parseAnthropicModels = (body) =>
  (body?.data || [])
    .filter((m) => m?.id)
    .map((m) => ({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at }));

// Subscription (OAuth) tokens are rejected as `x-api-key`; Anthropic accepts them
// only as a Bearer token with the OAuth beta.
const resolveClaudeOAuthModels = (connection, proxyOptions) =>
  buildOAuthResolver({
    refreshFn: (conn) => refreshClaudeOAuthToken(conn.refreshToken, proxyOptions),
    fetchFn: (token) =>
      fetchAllAnthropicModels(
        {
          Authorization: `Bearer ${token}`,
          "Anthropic-Beta": ANTHROPIC_OAUTH_BETA,
        },
        proxyOptions,
      ),
    parseFn: parseAnthropicModels,
    errorLabel: "Failed to fetch Claude models",
  })(connection);

async function resolveAnthropicApiKey(connection, label) {
  if (!connection.apiKey) return { models: [], warning: "No valid token found" };
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure(label);
  const response = await fetchAllAnthropicModels({ "x-api-key": connection.apiKey }, proxyOptions);
  if (!response.ok) {
    return {
      models: [],
      warning: `Failed to fetch ${label} models: ${response.status} ${await response.text()}`,
    };
  }
  const models = parseAnthropicModels(await response.json());
  return models.length ? { models } : noModels(label);
}

async function resolveClaude(connection) {
  if (connection.accessToken) {
    const proxyOptions = await connectionProxyOptions(connection);
    if (!proxyOptions) return proxyFailure("Claude");
    const result = await resolveClaudeOAuthModels(connection, proxyOptions);
    if (result.error) return { models: [], warning: result.error };
    return result.models.length
      ? result
      : { models: [], warning: result.warning || noModels("Claude").warning };
  }
  return resolveAnthropicApiKey(connection, "Claude");
}

// ── Zed ───────────────────────────────────────────────────────────────────
// No static catalog by design. Credentials never reach the browser; disabled
// entries are dropped and an empty catalog is explained, never a silent zero.
async function resolveZed(connection, { forceRefresh }) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure("Zed");
  const credentials = {
    accessToken: connection.accessToken,
    providerSpecificData: connection.providerSpecificData || {},
  };
  const result = await resolveZedModels(credentials, {
    config: ZED_HOSTED_CONFIG,
    forceRefresh,
    proxyOptions,
  });
  const models = (result?.models || [])
    .filter((m) => m && !m.isDisabled)
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider,
      contextLength: m.contextLength,
      contextLengthInMaxMode: m.contextLengthInMaxMode,
      maxOutputTokens: m.maxOutputTokens,
      supportsTools: m.supportsTools,
      supportsImages: m.supportsImages,
      supportsThinking: m.supportsThinking,
      supportsDisablingThinking: m.supportsDisablingThinking,
      supportsFastMode: m.supportsFastMode,
      supportsServerSideCompaction: m.supportsServerSideCompaction,
      supportedEffortLevels: m.supportedEffortLevels || [],
      supportsStreamingTools: m.supportsStreamingTools,
      supportsParallelToolCalls: m.supportsParallelToolCalls,
    }));
  if (models.length > 0) return { models };
  return {
    models: [],
    warning: await explainEmptyZedCatalog(credentials, result, {
      config: ZED_HOSTED_CONFIG,
      proxyOptions,
    }),
  };
}

// ── Kiro ──────────────────────────────────────────────────────────────────
async function resolveKiro(connection, { forceRefresh }) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure("Kiro");
  const result = await resolveKiroModels(
    {
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      providerSpecificData: connection.providerSpecificData || {},
    },
    {
      proxyOptions,
      forceRefresh,
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        if (!refreshed?.accessToken) return;
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || connection.refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
      },
    },
  );
  if (!result?.models?.length) return noModels("Kiro");
  return {
    models: result.models.map((m) => ({
      id: m.id,
      name: m.name,
      upstreamModelId: m.upstreamModelId,
      contextLength: m.contextLength,
      rateMultiplier: m.rateMultiplier,
      capabilities: m.capabilities,
      description: m.description,
    })),
  };
}

// ── Qoder ─────────────────────────────────────────────────────────────────
// Ids use the canonical "qoder/<key>" form the chat router expects. Hidden
// (enable:false) catalog keys are routable too, so they are included flagged
// `hidden` — /v1/models lists them, the dashboard does not.
async function resolveQoder(connection, { forceRefresh }) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure("Qoder");
  const result = await resolveQoderModels(
    {
      accessToken: connection.accessToken,
      // PAT (pt-...) connections keep the token in apiKey.
      apiKey: connection.apiKey,
      refreshToken: connection.refreshToken,
      email: connection.email,
      displayName: connection.displayName,
      providerSpecificData: connection.providerSpecificData || {},
    },
    { forceRefresh, proxyOptions },
  );
  const details = new Map((result?.models || []).map((m) => [m.id, m]));
  const models = routableQoderModels(result).map((m) => {
    const detail = details.get(m.id);
    return {
      id: `qoder/${m.id}`,
      name: m.name,
      ...(m.hidden ? { hidden: true } : {}),
      ...(detail
        ? {
            contextLength: detail.contextLength,
            isVL: detail.isVL,
            isReasoning: detail.isReasoning,
            maxOutputTokens: detail.maxOutputTokens,
            description: detail.description,
          }
        : {}),
    };
  });
  return models.length ? { models } : noModels("Qoder");
}

// ── Grok CLI ──────────────────────────────────────────────────────────────
async function resolveGrokCli(connection) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure("Grok CLI");
  const result = await resolveGrokCliModels(
    { ...connection, connectionId: connection.id },
    {
      log: console,
      proxyOptions,
      onCredentialsRefreshed: persistRefreshed(connection),
    },
  );
  if (result?.models?.length) return { models: result.models };
  return { models: [], warning: result?.warning || noModels("Grok CLI").warning };
}

// Resolvers whose service already returns { models } | null and need no mapping.
const passthrough = (label, resolve) => async (connection, options) => {
  const result = await resolve(connection, options);
  if (result?.models?.length) return { models: result.models };
  return { models: [], warning: result?.warning || noModels(label).warning };
};

export const LIVE_MODEL_RESOLVERS = {
  claude: resolveClaude,
  anthropic: (conn) => resolveAnthropicApiKey(conn, "Anthropic"),
  gemini: resolveGemini,
  "gemini-cli": resolveGeminiCli,
  antigravity: resolveAntigravity,
  vertex: resolveVertex,
  "vertex-partner": resolveVertexPartner,
  xai: resolveXai,
  openai: resolveOpenAI,
  openrouter: resolveOpenRouter,
  deepseek: resolveDeepSeek,
  mistral: resolveMistral,
  groq: resolveGroq,
  together: resolveTogether,
  fireworks: resolveFireworks,
  cerebras: resolveCerebras,
  "perplexity-agent": resolvePerplexityAgent,
  "vercel-ai-gateway": resolveVercel,
  chutes: resolveChutes,
  nvidia: resolveNvidia,
  nebius: resolveNebius,
  siliconflow: resolveSiliconFlow,
  hyperbolic: resolveHyperbolic,
  "opencode-go": resolveOpencodeGo,
  opencode: resolveOpencode,
  venice: resolveVenice,
  bazaarlink: resolveBazaarlink,
  llm7: resolveLlm7,
  sambanova: resolveSambanova,
  cohere: resolveCohere,
  tokenrouter: resolveTokenrouter,
  "kilo-gateway": resolveKiloGateway,
  "api-airforce": resolveAirforce,
  alicode: resolveAlicode,
  "alicode-intl": resolveAlicodeIntl,
  glm: resolveGlm,
  "glm-cn": resolveGlmCn,
  minimax: resolveMinimax,
  "minimax-cn": resolveMinimaxCn,
  ollama: resolveOllama,
  "ollama-local": resolveOllamaLocal,
  codex: resolveCodex,
  zed: resolveZed,
  kiro: resolveKiro,
  kimi: resolveKimi,
  qoder: resolveQoder,
  "grok-cli": resolveGrokCli,
  // Cursor's catalog rides a raw HTTP/2 CONNECT stream (cursorModels.js), which
  // cannot be routed through an HTTP(S) proxy. Same policy as the Cursor executor:
  // block when Strict Proxy is on or a relay is configured (a direct call would
  // leak the account); a non-strict pool goes direct, as chat does.
  cursor: passthrough("Cursor", async (conn, { forceRefresh }) => {
    const proxyOptions = await connectionProxyOptions(conn);
    if (!proxyOptions) return proxyFailure("Cursor");
    if (proxyOptions.strictProxy || proxyOptions.vercelRelayUrl) {
      return {
        models: [],
        warning:
          "Failed to fetch Cursor models: connection requires a proxy, which the Cursor HTTP/2 transport does not support",
      };
    }
    return resolveCursorModels(
      {
        accessToken: conn.accessToken,
        providerSpecificData: conn.providerSpecificData || {},
      },
      { forceRefresh, log: console },
    );
  }),
  kimchi: passthrough("Kimchi", async (conn, { forceRefresh }) => {
    const proxyOptions = await connectionProxyOptions(conn);
    if (!proxyOptions) return proxyFailure("Kimchi");
    return resolveKimchiModels(
      {
        accessToken: conn.accessToken,
        apiKey: conn.apiKey,
        providerSpecificData: conn.providerSpecificData || {},
      },
      { forceRefresh, log: console, proxyOptions },
    );
  }),
  // Copilot's catalog is chat-only; embeddings (models.github.ai) stay static.
  github: passthrough("GitHub Copilot", async (conn, { forceRefresh }) => {
    const proxyOptions = await connectionProxyOptions(conn);
    if (!proxyOptions) return proxyFailure("GitHub Copilot");
    const result = await resolveCopilotModels(
      {
        accessToken: conn.accessToken,
        refreshToken: conn.refreshToken,
        providerSpecificData: conn.providerSpecificData || {},
      },
      {
        forceRefresh,
        log: console,
        proxyOptions,
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(conn.id, {
            copilotToken: refreshed.copilotToken,
            copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
            existingProviderSpecificData: conn.providerSpecificData || {},
          });
        },
      },
    );
    return result?.models?.length
      ? { models: withStaticNonChatModels("github", result.models) }
      : null;
  }),
  // Cline and ClinePass share api.cline.bot/api/v1/models; the service handles
  // Bearer-vs-`workos:` auth and swallows failures into null.
  cline: passthrough("Cline", async (conn) => {
    const proxyOptions = await connectionProxyOptions(conn);
    if (!proxyOptions) return proxyFailure("Cline");
    return resolveClineModels(
      { accessToken: conn.accessToken, apiKey: conn.apiKey },
      { proxyOptions },
    );
  }),
  clinepass: passthrough("ClinePass", async (conn) => {
    const proxyOptions = await connectionProxyOptions(conn);
    if (!proxyOptions) return proxyFailure("ClinePass");
    return resolveClinepassModels(
      { accessToken: conn.accessToken, apiKey: conn.apiKey },
      { proxyOptions },
    );
  }),
};

export function hasLiveModelResolver(providerId) {
  return Object.hasOwn(LIVE_MODEL_RESOLVERS, providerId);
}

// Synthetic connection standing in for keyless noAuth providers (same "noauth"
// id auth.js injects for them), so live plumbing keyed on connections reaches
// them. Cache sharing follows the resolver key `<provider>:noauth`.
const NO_AUTH_CONNECTION_ID = "noauth";
const NO_AUTH_FAILURE_TTL_MS = 15_000;
export const noAuthConnection = (provider) => ({
  id: NO_AUTH_CONNECTION_ID,
  provider,
  isActive: true,
});

const cache = new Map();

// Registry models flagged `liveUnlisted` are served by chat but omitted from the
// upstream list, so they are appended (full registry entry, once) after a
// non-empty live catalog. Other static-only models still drop out.
export function withLiveUnlistedModels(
  providerId,
  liveModels,
  statics = getModelsByProviderId(providerId),
) {
  if (!liveModels.length) return liveModels;
  // Compare normalized ids so a prefixed live id (Qoder's "qoder/<key>")
  // matches its bare registry id.
  const live = new Set(liveModels.map((m) => normalizeLiveModelId(providerId, m?.id)));
  const unlisted = statics
    .filter((m) => m?.liveUnlisted && m.id && !live.has(normalizeLiveModelId(providerId, m.id)))
    .map((m) => ({ ...m }));
  return unlisted.length ? [...liveModels, ...unlisted] : liveModels;
}

export function clearLiveModelsCache() {
  cache.clear();
}

/**
 * Resolve a connection's live model catalog. Never throws: a failure becomes
 * { models: [], warning }. Only non-empty results are cached, so a failed
 * fetch is retried on the next call (keyless connections: after 15s).
 */
export async function resolveLiveModels(connection, { forceRefresh = false } = {}) {
  const resolver = LIVE_MODEL_RESOLVERS[connection?.provider];
  if (!resolver)
    return { models: [], warning: `No live model catalog for ${connection?.provider}` };

  const key = `${connection.provider}:${connection.id}`;
  const cached = cache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.result;

  let result;
  try {
    const resolved = await resolver(connection, { forceRefresh });
    result = {
      models: withLiveUnlistedModels(
        connection.provider,
        Array.isArray(resolved?.models) ? resolved.models : [],
      ),
      ...(resolved?.warning ? { warning: resolved.warning } : {}),
    };
  } catch (error) {
    console.log(`Live model fetch failed for ${connection.provider}:`, error?.message || error);
    result = {
      models: [],
      warning: `Failed to fetch ${connection.provider} models: ${error?.message || error}`,
    };
  }
  if (result.models.length > 0)
    cache.set(key, { result, expiresAt: Date.now() + LIVE_MODELS_TTL_MS });
  // Keyless catalogs are fetched on every /v1/models call, so an outage is held
  // briefly instead of stalling each call on the timeout; ?refresh=1 still retries.
  else if (connection.id === NO_AUTH_CONNECTION_ID)
    cache.set(key, { result, expiresAt: Date.now() + NO_AUTH_FAILURE_TTL_MS });
  else cache.delete(key);
  return result;
}
