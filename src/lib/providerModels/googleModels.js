// Live model catalogs for Google: the Gemini API (AI Studio key) and the two Cloud
// Code OAuth providers, Gemini CLI and Antigravity, which share fetchAvailableModels.

import { ANTIGRAVITY_CONFIG, GEMINI_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken } from "@/sse/services/tokenRefresh";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import {
  ANTIGRAVITY_IDE_BASE_URL,
  ANTIGRAVITY_IDE_USER_AGENT,
  ANTIGRAVITY_IDE_VERSION,
} from "open-sse/providers/shared.js";

const kindOf = (model) => model?.kind || model?.type || "llm";
const positive = (value) => (Number(value) > 0 ? Number(value) : undefined);
const projectIdOf = (conn) => conn.projectId || conn.providerSpecificData?.projectId || null;

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
  const data = { models: [] };
  let pageToken = null;
  for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
    const url = `${GEMINI_MODELS_URL}?pageSize=${GEMINI_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    // Header auth keeps the key out of URLs and request logs.
    const response = await fetch(url, { headers: { "x-goog-api-key": connection.apiKey } });
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

const cloudCodeFetch = (url, extraHeaders) => (token, conn) => {
  const projectId = projectIdOf(conn);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
};

// Wrap the OAuth resolver result into { models, warning }; a missing project id is
// the usual cause of a failure, so say so.
async function resolveCloudCode(resolver, connection, label) {
  const result = await resolver(connection);
  const warning = result.error || result.warning;
  if (result.models?.length) return { models: result.models };
  const hint = projectIdOf(connection)
    ? ""
    : ` No Google Cloud project is stored for this connection; reconnect ${label}.`;
  return { models: [], warning: `${warning || `${label} returned no live models.`}${hint}` };
}

const resolveGeminiCliOAuth = buildOAuthResolver({
  refreshFn: (conn) =>
    refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
  fetchFn: cloudCodeFetch(GEMINI_CLI_MODELS_URL, {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  }),
  parseFn: parseCloudCodeModels,
  errorLabel: "Failed to fetch Gemini CLI models",
});

export const resolveGeminiCli = (connection) =>
  resolveCloudCode(resolveGeminiCliOAuth, connection, "Gemini CLI");

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

const resolveAntigravityOAuth = buildOAuthResolver({
  refreshFn: (conn) =>
    refreshGoogleToken(
      conn.refreshToken,
      ANTIGRAVITY_CONFIG.clientId,
      ANTIGRAVITY_CONFIG.clientSecret,
    ),
  fetchFn: cloudCodeFetch(ANTIGRAVITY_MODELS_URL, {
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    "X-Client-Name": "antigravity",
    "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
  }),
  parseFn: parseCloudCodeModels,
  errorLabel: "Failed to fetch Antigravity models",
});

export async function resolveAntigravity(connection) {
  const result = await resolveCloudCode(resolveAntigravityOAuth, connection, "Antigravity");
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
