// Live model catalogs for Google: the Gemini API (AI Studio key) and the two Cloud
// Code OAuth providers, Gemini CLI and Antigravity, which share fetchAvailableModels.

import { ANTIGRAVITY_CONFIG, GEMINI_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken } from "@/sse/services/tokenRefresh";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";
import {
  proxyOptionsFromConfig,
  resolveConnectionProxyConfig,
} from "@/lib/network/connectionProxy";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  ANTIGRAVITY_IDE_BASE_URL,
  ANTIGRAVITY_HUB_USER_AGENT,
  ANTIGRAVITY_HUB_VERSION,
} from "open-sse/providers/shared.js";

const kindOf = (model) => model?.kind || model?.type || "llm";
const positive = (value) => (Number(value) > 0 ? Number(value) : undefined);
const projectIdOf = (conn) => conn.projectId || conn.providerSpecificData?.projectId || null;

// Strict/pool/relay proxy policy for the connection; null when it cannot be resolved,
// in which case the caller fails closed rather than going direct.
async function connectionProxyOptions(connection) {
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  return proxy.source === "error" ? null : proxyOptionsFromConfig(proxy);
}
const proxyFailure = (label) => ({
  models: [],
  warning: `Failed to fetch ${label} models: proxy resolution failed`,
});

// ── Gemini API (AI Studio key) ────────────────────────────────────────────
export const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_PAGE_SIZE = 1000;
const GEMINI_MAX_PAGES = 10;

// The list carries no kind field: infer it from the supported methods and the id.
// Models that support none of the methods we route (bidi-only live models) are dropped.
function geminiKind(id, methods) {
  if (methods.includes("embedContent")) return "embedding";
  if (/^veo-/.test(id)) return "video";
  if (/^imagen-|-image(-|$)/.test(id)) return "image";
  if (/-tts(-|$)/.test(id)) return "tts";
  if (methods.includes("generateContent")) return "llm";
  return null;
}

export function parseGeminiModels(data) {
  return (data?.models || []).flatMap((m) => {
    const id = typeof m?.name === "string" ? m.name.replace(/^models\//, "") : "";
    const kind = id ? geminiKind(id, m.supportedGenerationMethods || []) : null;
    if (!kind) return [];
    const contextLength = positive(m.inputTokenLimit);
    const maxOutputTokens = positive(m.outputTokenLimit);
    return [
      {
        id,
        name: m.displayName || id,
        ...(kind !== "llm" ? { kind } : {}),
        ...(contextLength ? { contextLength } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    ];
  });
}

export async function resolveGemini(connection) {
  if (!connection.apiKey) return { models: [], warning: "No valid token found" };
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure("Gemini");
  const data = { models: [] };
  let pageToken = null;
  for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
    const url = `${GEMINI_MODELS_URL}?pageSize=${GEMINI_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    // Header auth keeps the key out of URLs and request logs.
    const response = await proxyAwareFetch(
      url,
      { headers: { "x-goog-api-key": connection.apiKey } },
      proxyOptions,
    );
    if (!response.ok) {
      return {
        models: [],
        warning: `Failed to fetch Gemini models: ${response.status} ${await response.text()}`,
      };
    }
    const body = await response.json();
    data.models.push(...(body?.models || []));
    pageToken = body?.nextPageToken;
    if (!pageToken) break;
  }
  const models = parseGeminiModels(data);
  if (!models.length) return { models: [], warning: "Gemini returned no live models." };
  // STT twins of chat models and legacy embeddings stay listed under their kind.
  return { models: withStaticNonChatModels("gemini", models) };
}

// ── Cloud Code (Gemini CLI, Antigravity) ──────────────────────────────────
const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_MODELS_URL = `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`;

/**
 * fetchAvailableModels answers with a `models` map keyed by the callable id (older
 * backends: an array). Internal models are dropped; maxTokens is the context window.
 */
export function parseCloudCodeModels(data) {
  const entries = Array.isArray(data?.models)
    ? data.models.map((m) => [m?.id || m?.model || m?.name, m])
    : Object.entries(data?.models && typeof data.models === "object" ? data.models : {});
  return entries.flatMap(([id, info]) => {
    if (typeof id !== "string" || !id.trim() || info?.isInternal) return [];
    const contextLength = positive(info?.maxTokens);
    const maxOutputTokens = positive(info?.maxOutputTokens);
    return [
      {
        id,
        name: info?.displayName || id,
        ...(contextLength ? { contextLength } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    ];
  });
}

const cloudCodeFetch = (url, extraHeaders, proxyOptions) => (token, conn) => {
  const projectId = projectIdOf(conn);
  return proxyAwareFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    },
    proxyOptions,
  );
};

// Run the shared OAuth resolver with the connection's proxy on both the catalog fetch
// and the 401 refresh, then wrap the result into { models, warning }; a missing
// project id is the usual cause of a failure, so say so.
async function resolveCloudCode(connection, { label, url, headers, oauthClient }) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) return proxyFailure(label);
  const result = await buildOAuthResolver({
    refreshFn: (conn) =>
      refreshGoogleToken(
        conn.refreshToken,
        oauthClient.clientId,
        oauthClient.clientSecret,
        proxyOptions,
      ),
    fetchFn: cloudCodeFetch(url, headers, proxyOptions),
    parseFn: parseCloudCodeModels,
    errorLabel: `Failed to fetch ${label} models`,
  })(connection);
  const warning = result.error || result.warning;
  if (result.models?.length) return { models: result.models };
  const hint = projectIdOf(connection)
    ? ""
    : ` No Google Cloud project is stored for this connection; reconnect ${label}.`;
  return { models: [], warning: `${warning || `${label} returned no live models.`}${hint}` };
}

export const resolveGeminiCli = (connection) =>
  resolveCloudCode(connection, {
    label: "Gemini CLI",
    url: GEMINI_CLI_MODELS_URL,
    headers: {
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    },
    oauthClient: GEMINI_CONFIG,
  });

// The Antigravity map also carries internal completion models (chat_*, tab_*).
const ANTIGRAVITY_LISTED = /^(gemini-|claude-|gpt-|image)/;
// "gemini-3.8-flash-medium(medium)" → "gemini-3.8-flash-medium"
const wireIdOf = (model) => (model.upstreamModelId || model.id).replace(/\(.*\)$/, "");

/**
 * Reconcile the live wire ids with the static catalog, whose friendly ids route to
 * wire ids through upstreamModelId. A static entry stays when its wire id is live;
 * a live id already reachable through a static alias is not listed twice; unknown
 * live ids pass through. Live limits are copied onto the static entries.
 */
export function reconcileAntigravityModels(liveModels, staticModels) {
  const live = new Map(
    liveModels.filter((m) => ANTIGRAVITY_LISTED.test(m.id)).map((m) => [m.id, m]),
  );
  const kept = staticModels.flatMap((m) => {
    const wire = live.get(wireIdOf(m));
    if (!wire) return [];
    const { contextLength, maxOutputTokens } = wire;
    return [
      {
        id: m.id,
        name: m.name,
        ...(kindOf(m) !== "llm" ? { kind: kindOf(m) } : {}),
        ...(contextLength ? { contextLength } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    ];
  });
  const covered = new Set(staticModels.filter((m) => live.has(wireIdOf(m))).map(wireIdOf));
  const unknown = [...live.values()]
    .filter((m) => !covered.has(m.id))
    .map((m) => (/image/.test(m.id) ? { ...m, kind: "image" } : m));
  return [...kept, ...unknown];
}

export async function resolveAntigravity(connection) {
  const result = await resolveCloudCode(connection, {
    label: "Antigravity",
    url: ANTIGRAVITY_MODELS_URL,
    headers: {
      "User-Agent": ANTIGRAVITY_HUB_USER_AGENT,
      "X-Client-Name": "antigravity",
      "X-Client-Version": ANTIGRAVITY_HUB_VERSION,
    },
    oauthClient: ANTIGRAVITY_CONFIG,
  });
  if (!result.models.length) return result;
  const staticModels = getModelsByProviderId("antigravity");
  const models = reconcileAntigravityModels(result.models, staticModels);
  // The account's catalog is the truth (tiers differ); log what it hides for operators.
  const listed = new Set(models.map((m) => m.id));
  const dropped = staticModels.filter((m) => !listed.has(m.id)).map((m) => m.id);
  if (dropped.length) console.log(`Antigravity live catalog omits ${dropped.join(", ")}`);
  return models.length
    ? { models }
    : { models: [], warning: "Antigravity returned no live models." };
}
