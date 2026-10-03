// Live catalogs for OpenAI-style API-key providers (GET …/models, Bearer key):
// DeepSeek, Mistral, Groq, Together AI, Fireworks AI, Cerebras, Perplexity
// Agent, Vercel AI Gateway, Chutes, NVIDIA NIM, Nebius, SiliconFlow,
// Hyperbolic and OpenCode Go. Each list carries every kind the provider serves, so it is
// authoritative: no static extras are added back (except NIM's speech models).
// OpenCode Free is the keyless exception: its Zen catalog is public.

import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { OPENCODE_PUBLIC_HEADERS } from "open-sse/executors/opencode.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";

const FETCH_TIMEOUT_MS = 10_000;
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
// Together (and some Fireworks responses) return a bare array, not { data }.
const entries = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
const idOf = (entry) => (typeof entry?.id === "string" ? entry.id.trim() : "");

// ── DeepSeek ──────────────────────────────────────────────────────────────
// The list is ids only, all chat. Static virtual variants (thinking on/off)
// point at an upstream id and stay listed while that id is live.
export function parseDeepSeekModels(body, statics = getModelsByProviderId("deepseek")) {
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  const live = new Set(ids);
  const variants = statics
    .filter((m) => m.upstreamModelId && live.has(m.upstreamModelId) && !live.has(m.id))
    .map(({ id, name, upstreamModelId }) => ({ id, name, upstreamModelId }));
  return [...ids.map((id) => ({ id, name: id })), ...variants];
}

// ── Mistral ───────────────────────────────────────────────────────────────
// Models past their deprecation date are dropped (an announced date still
// serves). An alias group (dated id + `-latest`) is listed once, under the
// `-latest` id the registry uses; undated ids keep their own name. OCR,
// moderation and classifier models have no route here.
export function parseMistralModels(body, now = Date.now()) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || Date.parse(entry.deprecation) <= now) continue;
    const kind = /embed/i.test(id)
      ? "embedding"
      : entry.capabilities?.completion_chat
        ? "llm"
        : null;
    if (!kind) continue;
    const names = [id, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    if (names.some((n) => seen.has(n))) continue;
    for (const n of names) seen.add(n);
    const latest = names.find((n) => n.endsWith("-latest"));
    const primary = /-\d{4,}$/.test(id) && latest ? latest : id;
    models.push({
      id: primary,
      name: entry.name || primary,
      contextLength: positive(entry.max_context_length),
      description: entry.description || undefined,
      ...(kind !== "llm" ? { kind } : {}),
    });
  }
  return models;
}

// ── Groq ──────────────────────────────────────────────────────────────────
// Inactive models are dropped. Whisper is STT; TTS has no Groq route here.
export function parseGroqModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id) || entry.active === false) continue;
    seen.add(id);
    if (/(^|[-/])tts\b|orpheus/i.test(id)) continue;
    if (/whisper/i.test(id)) {
      models.push({ id, name: id, kind: "stt" });
      continue;
    }
    models.push({
      id,
      name: id,
      contextLength: positive(entry.context_window),
      maxOutputTokens: positive(entry.max_completion_tokens),
    });
  }
  return models;
}

// ── Together AI ───────────────────────────────────────────────────────────
// Only chat and embeddings are routed here; image, rerank and moderation are
// dropped. Rows priced 0/0 are dedicated-endpoint models a serverless key
// can't call, except the explicit "-Free" serverless ids.
const TOGETHER_KINDS = { chat: "llm", language: "llm", code: "llm", embedding: "embedding" };
export function parseTogetherModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    const kind = Object.hasOwn(TOGETHER_KINDS, entry?.type) && TOGETHER_KINDS[entry.type];
    if (!id || !kind || seen.has(id)) continue;
    const { input, output } = entry.pricing || {};
    if (input === 0 && output === 0 && !/-free$/i.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: entry.display_name || id,
      contextLength: positive(entry.context_length),
      ...(kind !== "llm" ? { kind } : {}),
    });
  }
  return models;
}

// ── Fireworks AI ──────────────────────────────────────────────────────────
// `kind` decides: embedding models also report supports_chat. Rerankers share
// EMBEDDING_MODEL and have no route here; FLUMINA (image) models neither.
export function parseFireworksModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    const embedding = entry.kind === "EMBEDDING_MODEL";
    if (embedding ? /rerank/i.test(id) : !entry.supports_chat) continue;
    if (/^FLUMINA/.test(entry.kind || "")) continue;
    seen.add(id);
    models.push({
      id,
      name: id.split("/").pop(),
      contextLength: positive(entry.context_length),
      ...(embedding ? { kind: "embedding" } : {}),
    });
  }
  return models;
}

// ── Cerebras ──────────────────────────────────────────────────────────────
// Ids only, all chat; the registry's display name is kept when known.
export function parseCerebrasModels(body, statics = getModelsByProviderId("cerebras")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── Perplexity Agent ──────────────────────────────────────────────────────
// Agent API ids (`provider/model`), all chat, no metadata beyond owned_by. The
// Sonar chat API has no list of its own, so `perplexity` stays static.
export function parsePerplexityAgentModels(
  body,
  statics = getModelsByProviderId("perplexity-agent"),
) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── Vercel AI Gateway ─────────────────────────────────────────────────────
// Only chat, embeddings and images are routed here; video, speech,
// transcription, realtime, reranking and evaluation are dropped.
const VERCEL_KINDS = { language: "llm", embedding: "embedding", image: "image" };
export function parseVercelModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    const kind = Object.hasOwn(VERCEL_KINDS, entry?.type) && VERCEL_KINDS[entry.type];
    if (!id || !kind || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: entry.name || id,
      contextLength: positive(entry.context_window),
      maxOutputTokens: positive(entry.max_tokens),
      description: entry.description || undefined,
      ...(Array.isArray(entry.modalities?.input)
        ? { inputModalities: entry.modalities.input }
        : {}),
      ...(kind !== "llm" ? { kind } : {}),
    });
  }
  return models;
}

// ── Chutes ────────────────────────────────────────────────────────────────
// Every text-output chute is chat; anything else has no route here.
export function parseChutesModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    const outputs = entry.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.max_output_length),
      ...(Array.isArray(entry.input_modalities) ? { inputModalities: entry.input_modalities } : {}),
    });
  }
  return models;
}

// ── NVIDIA NIM ────────────────────────────────────────────────────────────
// Ids only, no kind field: classified by id. Embedders keep their kind; safety,
// reward, parsing, detection and CLIP models have no route here. Static TTS/STT
// rows aren't listed upstream and are added back.
const NIM_UNROUTED =
  /(^|[-/])(nemo|nv)?(guard|safety|topic-control|reward|parse|detector|clip|deplot)(\b|$)/i;
export function parseNvidiaModels(body, statics = getModelsByProviderId("nvidia")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  const models = ids
    .filter((id) => !NIM_UNROUTED.test(id))
    .map((id) => ({
      id,
      name: names.get(id) || id,
      ...(/embed/i.test(id) ? { kind: "embedding" } : {}),
    }));
  return models.length ? withStaticNonChatModels("nvidia", models) : models;
}

// ── Nebius ────────────────────────────────────────────────────────────────
// Ids only. Embedders keep their kind; image and guard models have no route.
export function parseNebiusModels(body) {
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids
    .filter((id) => !/flux|sdxl|stable-diffusion|kandinsky|video|guard/i.test(id))
    .map((id) => ({ id, name: id, ...(/embed/i.test(id) ? { kind: "embedding" } : {}) }));
}

// ── SiliconFlow ───────────────────────────────────────────────────────────
// Fetched with sub_type=chat, so every row is chat; registry names kept.
export function parseSiliconFlowModels(body, statics = getModelsByProviderId("siliconflow")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── Hyperbolic ────────────────────────────────────────────────────────────
// Image and audio rows report supports_chat: false and have no route here.
export function parseHyperbolicModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id) || entry.supports_chat === false) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextLength: positive(entry.context_length),
      ...(entry.supports_image_input ? { inputModalities: ["text", "image"] } : {}),
    });
  }
  return models;
}

// ── OpenCode Go ───────────────────────────────────────────────────────────
// Ids only, all chat, one shared catalog for every subscriber. Registry names
// kept; the transport for ids the registry lacks is inferred at request time
// (inferOpencodeGoModel).
export function parseOpencodeGoModels(body, statics = getModelsByProviderId("opencode-go")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── OpenCode Free ─────────────────────────────────────────────────────────
// The Zen catalog lists every model, paid and free; the shared "opencode-free"
// filter keeps the free ones. Ids the registry lacks default to chat/completions.
export const parseOpencodeFreeModels = (body) => FILTERS["opencode-free"](entries(body));

// No key: the endpoint answers "Bearer public", so this isn't built by resolver().
// ponytail: skips the noAuth proxy pool chat uses; resolve via resolveConnectionProxyConfig if blocked.
export async function resolveOpencode() {
  const response = await fetch("https://opencode.ai/zen/v1/models", {
    headers: { ...OPENCODE_PUBLIC_HEADERS, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    return {
      models: [],
      warning: `Failed to fetch OpenCode Free models: ${response.status} ${text}`,
    };
  }
  const models = parseOpencodeFreeModels(await response.json());
  return models.length
    ? { models }
    : { models: [], warning: "OpenCode Free returned no live models." };
}

const resolver = (label, url, parse) => async (connection) => {
  if (!connection.apiKey) return { models: [], warning: "No valid token found" };
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
    // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // The warning reaches the dashboard: never echo the key back.
    const text = (await response.text()).replaceAll(connection.apiKey, "***").slice(0, 300);
    return { models: [], warning: `Failed to fetch ${label} models: ${response.status} ${text}` };
  }
  const models = parse(await response.json());
  return models.length ? { models } : { models: [], warning: `${label} returned no live models.` };
};

export const resolveDeepSeek = resolver(
  "DeepSeek",
  "https://api.deepseek.com/models",
  parseDeepSeekModels,
);
export const resolveMistral = resolver(
  "Mistral",
  "https://api.mistral.ai/v1/models",
  parseMistralModels,
);
export const resolveGroq = resolver(
  "Groq",
  "https://api.groq.com/openai/v1/models",
  parseGroqModels,
);
export const resolveTogether = resolver(
  "Together AI",
  "https://api.together.xyz/v1/models",
  parseTogetherModels,
);
export const resolveFireworks = resolver(
  "Fireworks AI",
  "https://api.fireworks.ai/inference/v1/models",
  parseFireworksModels,
);
export const resolveCerebras = resolver(
  "Cerebras",
  "https://api.cerebras.ai/v1/models",
  parseCerebrasModels,
);
export const resolvePerplexityAgent = resolver(
  "Perplexity Agent",
  "https://api.perplexity.ai/v1/models",
  parsePerplexityAgentModels,
);
export const resolveVercel = resolver(
  "Vercel AI Gateway",
  "https://ai-gateway.vercel.sh/v1/models",
  parseVercelModels,
);
export const resolveChutes = resolver(
  "Chutes",
  "https://llm.chutes.ai/v1/models",
  parseChutesModels,
);
export const resolveNvidia = resolver(
  "NVIDIA NIM",
  "https://integrate.api.nvidia.com/v1/models",
  parseNvidiaModels,
);
export const resolveNebius = resolver(
  "Nebius",
  "https://api.studio.nebius.ai/v1/models",
  parseNebiusModels,
);
export const resolveSiliconFlow = resolver(
  "SiliconFlow",
  "https://api.siliconflow.com/v1/models?sub_type=chat",
  parseSiliconFlowModels,
);
export const resolveHyperbolic = resolver(
  "Hyperbolic",
  "https://api.hyperbolic.xyz/v1/models",
  parseHyperbolicModels,
);
export const resolveOpencodeGo = resolver(
  "OpenCode Go",
  "https://opencode.ai/zen/go/v1/models",
  parseOpencodeGoModels,
);
