// Shared API-key probes driven by the provider registry. Used by both the
// add-time validator (/api/providers/validate) and the saved-connection
// re-test (/api/providers/[id]/test) so a key that passed validation also
// passes a re-test instead of "Provider test not supported" (YAN-674).
//
// Each probe returns true (key accepted), false (key rejected), or null
// (probe not applicable to this provider — caller should fall through).
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getDefaultModel } from "open-sse/config/providerModels.js";
import { PROVIDERS } from "open-sse/config/providers.js";

const PROBE_TIMEOUT_MS = 8000;
const CHAT_PROBE_TIMEOUT_MS = 10000;

// Parses a Vertex service-account JSON key. Duplicated from
// open-sse/services/tokenRefresh.js (parseVertexSaJson) on purpose: importing
// that module here would pull its global fetch patch into every caller,
// including the connection test route.
function parseVertexSaJson(apiKey) {
  if (typeof apiKey !== "string") return null;
  try {
    const parsed = JSON.parse(apiKey);
    return parsed.type === "service_account" &&
      parsed.client_email &&
      parsed.private_key &&
      parsed.project_id
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// Vertex Partner's transport root is a bare host, not an OpenAI endpoint —
// the generic /models + chat probe would 404 into a false "valid". It has its
// own probe (probeVertexKey) below.
const GENERIC_PROBE_EXCLUDE = new Set(["vertex-partner"]);

// Probe a webSearch/webFetch provider using its searchConfig/fetchConfig.
export async function probeWebProvider(provider, apiKey, fetchImpl = fetch) {
  const p = AI_PROVIDERS[provider];
  if (!p) return null;
  // Skip if provider has dual-purpose (LLM + search), let LLM validate handle it
  const kinds = p.serviceKinds || ["llm"];
  const isWebOnly = kinds.every((k) => k === "webSearch" || k === "webFetch");
  if (!isWebOnly) return null;
  const cfg = p.searchConfig || p.fetchConfig;
  if (!cfg) return null;
  if (cfg.authType === "none") return true; // no-auth (e.g. searxng)

  let url = cfg.validateUrl || cfg.baseUrl;
  const headers = { "Content-Type": "application/json" };
  let body;

  // Apply auth based on authHeader
  switch (cfg.authHeader) {
    case "bearer":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "x-api-key":
      headers["x-api-key"] = apiKey;
      break;
    case "x-subscription-token":
      headers["x-subscription-token"] = apiKey;
      break;
    case "key":
      url += `?key=${encodeURIComponent(apiKey)}&q=ping&cx=test`;
      break; // google-pse
    case "api_key":
      url += `?api_key=${encodeURIComponent(apiKey)}&q=ping&engine=google`;
      break; // searchapi
  }

  // Minimal body for POST endpoints; GET sends nothing
  if (cfg.method === "POST") {
    body = JSON.stringify({ query: "ping", q: "ping", url: "https://example.com" });
  }

  const res = await fetchImpl(url, {
    method: cfg.method,
    headers,
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.status !== 401 && res.status !== 403;
}

const MEDIA_KINDS = new Set(["tts", "embedding", "stt", "image", "video", "music", "imageToText"]);

// Probe a media provider (tts/embedding/stt/image/video) using *Config.
export async function probeMediaProvider(provider, apiKey, fetchImpl = fetch) {
  const p = AI_PROVIDERS[provider];
  if (!p) return null;
  const kinds = p.serviceKinds || ["llm"];
  const isMediaOnly = kinds.every((k) => MEDIA_KINDS.has(k));
  if (!isMediaOnly) return null;
  const cfg =
    p.ttsConfig ||
    p.sttConfig ||
    p.embeddingConfig ||
    p.imageConfig ||
    p.videoConfig ||
    p.musicConfig;
  // No probe config → best-effort accept (validate at usage time)
  if (!cfg) return true;
  if (p.noAuth || cfg.authType === "none") return true;
  // Skip auth schemes that need provider-specific data
  if (cfg.authHeader === "playht" || cfg.authHeader === "aws-sigv4") return true;

  const headers = { "Content-Type": "application/json", ...(cfg.extraHeaders || {}) };

  switch (cfg.authHeader) {
    case "bearer":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "key":
      headers["Authorization"] = `Key ${apiKey}`;
      break;
    case "x-api-key":
      headers["x-api-key"] = apiKey;
      break;
    case "x-key":
      headers["x-key"] = apiKey;
      break;
    case "xi-api-key":
      headers["xi-api-key"] = apiKey;
      break;
    case "token":
      headers["Authorization"] = `Token ${apiKey}`;
      break;
    case "basic":
      headers["Authorization"] = `Basic ${apiKey}`;
      break;
    default:
      return null;
  }

  const method = cfg.method || "POST";
  const res = await fetchImpl(cfg.baseUrl, {
    method,
    headers,
    body:
      method === "GET"
        ? undefined
        : JSON.stringify({
            input: "ping",
            text: "ping",
            prompt: "ping",
            model: getDefaultModel(provider) || "test",
          }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.status !== 401 && res.status !== 403;
}

// Generic probe for transport-backed providers (config-driven from PROVIDERS):
// registry validateUrl, else derived <baseUrl>/models, else a minimal chat
// probe. 401/403 means the key was rejected; anything else means accepted.
export async function probeRegistryProvider(provider, apiKey, fetchImpl = fetch) {
  const cfg = PROVIDERS[provider];
  if (!cfg || GENERIC_PROBE_EXCLUDE.has(provider)) return null;
  if (!cfg.validateUrl && (cfg.format !== "openai" || !cfg.baseUrl)) return null;
  if (cfg.noAuth) return true;
  // Build auth headers based on cfg.authHeader (default: bearer)
  const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
  if (cfg.authHeader === "x-api-key") headers["X-API-Key"] = apiKey;
  else headers["Authorization"] = `Bearer ${apiKey}`;
  // Try /models first (fast GET), fallback to chat probe on ambiguous response
  const modelsUrl =
    cfg.validateUrl ||
    cfg.baseUrl.replace(/\/chat\/completions$/, "/models").replace(/\/chatbot$/, "/models");
  try {
    const probeRes = await fetchImpl(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (probeRes.status === 401 || probeRes.status === 403) return false;
    if (probeRes.ok) return true;
  } catch {
    /* fallback to chat */
  }
  // Fallback: minimal chat probe
  const defaultModel = getDefaultModel(provider) || "test";
  const chatRes = await fetchImpl(cfg.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: defaultModel,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(CHAT_PROBE_TIMEOUT_MS),
  });
  return chatRes.status !== 401 && chatRes.status !== 403;
}

// Vertex raw key / service-account JSON probe (Vertex + Vertex Partner).
export async function probeVertexKey(apiKey, fetchImpl = fetch) {
  const saJson = parseVertexSaJson(apiKey);
  if (saJson) return true; // parseVertexSaJson already requires the SA fields
  // SA-looking JSON missing required fields is invalid — don't probe it as a raw key
  try {
    if (JSON.parse(apiKey)?.type === "service_account") return false;
  } catch {
    /* raw key — probe below */
  }
  // Raw key: probe a nonexistent model — 404 means the key was accepted
  // (never 401 for an unknown model), 401/403 means the key is bad.
  const probeRes = await fetchImpl(
    `https://aiplatform.googleapis.com/v1/publishers/google/models/__probe__:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  return probeRes.status !== 401 && probeRes.status !== 403;
}

// Fallback chain for an API-key provider with no bespoke tester: registry
// transport probe, web-only probe, media-only probe, Vertex key probe.
// Returns null when nothing applies (caller keeps "not supported").
export async function probeApiKeyProvider(provider, apiKey, fetchImpl = fetch) {
  const registry = await probeRegistryProvider(provider, apiKey, fetchImpl);
  if (registry !== null) return registry;
  const web = await probeWebProvider(provider, apiKey, fetchImpl);
  if (web !== null) return web;
  const media = await probeMediaProvider(provider, apiKey, fetchImpl);
  if (media !== null) return media;
  if (provider === "vertex" || provider === "vertex-partner") {
    return await probeVertexKey(apiKey, fetchImpl);
  }
  return null;
}
