// Live catalogs for OpenAI-style API-key providers (GET …/models, Bearer key):
// DeepSeek, Mistral, Groq, Together AI, Fireworks AI, Cerebras, Perplexity
// Agent, Vercel AI Gateway, Chutes, NVIDIA NIM, Nebius, SiliconFlow,
// Hyperbolic, OpenCode Go, Venice, Bazaarlink, LLM7, SambaNova, Alibaba Coding
// (CN), Alibaba Coding Intl, GLM Coding, GLM (China), MiniMax Coding and MiniMax
// (China), Cohere, TokenRouter, Kilo Gateway, Kilo Code, Featherless and
// API.airforce. Each list
// carries every kind the provider serves, so it is
// authoritative: no static extras are added back (except NIM's speech models
// and MiniMax's static TTS/image rows). Registry models flagged
// `liveUnlisted` are appended for every provider in resolveLiveModels.
// OpenCode Free is the keyless exception: its Zen catalog is public.

import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { OPENCODE_PUBLIC_HEADERS } from "open-sse/executors/opencode.js";
import { PROVIDER_MEDIA, PROVIDERS } from "open-sse/providers/index.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";
import { classifyOpenAIModel } from "@/lib/providerModels/openaiModels.js";
import { connectionProxyOptions } from "@/lib/network/connectionProxy";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

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

// ── Venice ────────────────────────────────────────────────────────────────
// Fetched with type=all. Only text, embedding and image have a route here;
// video, music, speech, upscale and inpaint rows are dropped, as are offline ones.
const VENICE_KINDS = { text: "llm", embedding: "embedding", image: "image" };
export function parseVeniceModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    const kind = Object.hasOwn(VENICE_KINDS, entry?.type) && VENICE_KINDS[entry.type];
    const spec = entry?.model_spec || {};
    if (!id || !kind || spec.offline || seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    models.push({
      id,
      name: spec.name || id,
      ...(kind === "llm"
        ? {
            contextLength: positive(spec.availableContextTokens),
            maxOutputTokens: positive(spec.maxCompletionTokens),
            ...(spec.capabilities?.supportsVision ? { inputModalities: ["text", "image"] } : {}),
          }
        : { kind }),
    });
  }
  return models;
}

// ── Bazaarlink ────────────────────────────────────────────────────────────
// Every text-output row is chat; anything else has no route here.
export function parseBazaarlinkModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    const outputs = entry?.architecture?.output_modalities;
    if (!id || seen.has(id) || (Array.isArray(outputs) && !outputs.includes("text"))) continue;
    seen.add(id);
    models.push({
      id,
      name: entry.name || id,
      contextLength: positive(entry.context_length),
      description: entry.description || undefined,
      ...(Array.isArray(entry.architecture?.input_modalities)
        ? { inputModalities: entry.architecture.input_modalities }
        : {}),
    });
  }
  return models;
}

// ── LLM7 ──────────────────────────────────────────────────────────────────
// Only chat rows; image, video, transcription and systemone have no route here.
// Always the official host: chat ignores providerSpecificData.baseUrl for llm7,
// so listing from it would disagree with routing and send the key elsewhere.
export function parseLlm7Models(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id) || entry.model_type !== "chat") continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextLength: positive(entry.context_window?.tokens),
      ...(Array.isArray(entry.modalities?.input)
        ? { inputModalities: entry.modalities.input }
        : {}),
    });
  }
  return models;
}

// ── SambaNova ─────────────────────────────────────────────────────────────
// All chat; registry names kept.
export function parseSambanovaModels(body, statics = getModelsByProviderId("sambanova")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: names.get(id) || id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.max_completion_tokens),
    });
  }
  return models;
}

// ── Alibaba Coding ────────────────────────────────────────────────────────
// Both regional catalogs are ids only, all chat; registry names kept (shared
// parser: it looks up names in both providers' statics).
export function parseAlicodeModels(body) {
  const statics = [...getModelsByProviderId("alicode"), ...getModelsByProviderId("alicode-intl")];
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── GLM (Z.AI / BigModel) ─────────────────────────────────────────────────
// Both coding catalogs are ids only, all chat. Names: the provider's own registry
// first, then the other GLM provider's, then the id. Registry models flagged
// `liveUnlisted` (served by chat, omitted by /models) are appended by the
// shared resolver path (resolveLiveModels), not here.
export function parseGlmModels(body, providerId = "glm") {
  const own = getModelsByProviderId(providerId);
  const other = getModelsByProviderId(providerId === "glm" ? "glm-cn" : "glm");
  const names = new Map([...other, ...own].map((m) => [m.id, m.name]));
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

// ── MiniMax Coding / MiniMax (China) ──────────────────────────────────────
// Ids only, no kind field. A static id keeps its registry kind (and name); the
// other MiniMax provider's registry supplies names too. Unknown ids: `speech-*`
// drops out (the TTS dispatcher can't route a bare unknown id, it reads it as a
// voice), image ids are listed only where the provider serves image, and video
// (`MiniMax-H3*` Hailuo-style ids, `*2v-*`), music, ASR (`asr-*`) and embedding
// ids have no route here and drop out. Anything else is chat (M-series). Static TTS/image rows the live list lacks are added back.
const MINIMAX_IMAGE = /image/i;
const MINIMAX_UNROUTED =
  /video|music|hailuo|embo|embed|^asr-|(^|[-_])h\d+([-_]|$)|(^|[-_])[a-z]2v([-_]|$)/i;
export function parseMinimaxModels(body, providerId = "minimax") {
  const own = getModelsByProviderId(providerId);
  const other = getModelsByProviderId(providerId === "minimax" ? "minimax-cn" : "minimax");
  const names = new Map([...other, ...own].map((m) => [m.id, m.name]));
  const staticKinds = new Map(own.map((m) => [m.id, m.kind || m.type || "llm"]));
  const servesImage = PROVIDER_MEDIA[providerId]?.serviceKinds?.includes("image") === true;
  const ids = [...new Set(entries(body).map(idOf).filter(Boolean))];
  const models = [];
  for (const id of ids) {
    const known = staticKinds.get(id);
    let kind;
    if (known) kind = known === "llm" ? undefined : known;
    else if (/^speech-/i.test(id)) continue;
    else if (MINIMAX_IMAGE.test(id)) {
      if (!servesImage) continue;
      kind = "image";
    } else if (MINIMAX_UNROUTED.test(id)) continue;
    models.push({ id, name: names.get(id) || id, ...(kind ? { kind } : {}) });
  }
  return models.length ? withStaticNonChatModels(providerId, models) : models;
}

// ── Cohere ────────────────────────────────────────────────────────────────
// Native list: `name` is the id and there is no `id`. Fetched with
// endpoint=chat, so embed/rerank-only models never reach the chat list; rows
// whose endpoints still lack chat, and deprecated ones, are dropped too.
export function parseCohereModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(body?.models) ? body.models : []) {
    const id = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!id || seen.has(id) || entry.is_deprecated === true) continue;
    if (Array.isArray(entry.endpoints) && !entry.endpoints.includes("chat")) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextLength: positive(entry.context_length),
      ...(Array.isArray(entry.features) && entry.features.includes("vision")
        ? { inputModalities: ["text", "image"] }
        : {}),
    });
  }
  return models;
}

// ── TokenRouter ───────────────────────────────────────────────────────────
// OpenAI-style list of vendor-prefixed ids (`openai/gpt-5.5`). A registry id
// keeps its kind; otherwise an output-modality field decides when present,
// else the bare id goes through the OpenAI classifier. Only the kinds the
// registry routes (chat, embedding, image) are kept.
const TOKENROUTER_KINDS = new Set(["llm", "embedding", "image"]);
const TOKENROUTER_OUTPUT_KINDS = { text: "llm", embeddings: "embedding", image: "image" };
const isFreeId = (id) => /[-:]free$/i.test(id);
function tokenrouterKind(entry, id) {
  if (/embed/i.test(id)) return "embedding";
  const outputs = entry?.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length) {
    if (outputs.includes("text")) return "llm";
    for (const out of outputs)
      if (TOKENROUTER_OUTPUT_KINDS[out]) return TOKENROUTER_OUTPUT_KINDS[out];
    return null;
  }
  const bare = id.split("/").pop();
  if (/(^|[-_])(flux|imagen|seedream|dall-e)|image-gen|(^|-)image$/i.test(bare)) return "image";
  return classifyOpenAIModel(bare);
}
export function parseTokenrouterModels(body, statics = getModelsByProviderId("tokenrouter")) {
  const staticById = new Map(statics.map((m) => [m.id, m]));
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = staticById.get(id);
    const kind = known ? known.kind || known.type || "llm" : tokenrouterKind(entry, id);
    if (!TOKENROUTER_KINDS.has(kind)) continue;
    models.push({
      id,
      name: known?.name || entry.name || id,
      contextLength: positive(entry.context_length),
      isFree: isFreeId(id),
      ...(kind !== "llm" ? { kind } : {}),
    });
  }
  return models;
}

// ── Kilo Gateway ──────────────────────────────────────────────────────────
// OpenRouter-shaped. Kilo flags free rows itself (`isFree`); its auto routers
// price at "-1", so pricing alone can't tell. Only text-output rows are
// routed (the registry serves chat only); expired rows are dropped.
export function parseKiloModels(body, now = Date.now()) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    if (Date.parse(entry.expiration_date) <= now) continue;
    const outputs = entry.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes("text")) continue;
    seen.add(id);
    const { prompt, completion } = entry.pricing || {};
    const inputs = entry.architecture?.input_modalities;
    models.push({
      id,
      name: entry.name || id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.top_provider?.max_completion_tokens),
      isFree:
        typeof entry.isFree === "boolean"
          ? entry.isFree
          : Number(prompt) === 0 && Number(completion) === 0 && prompt != null,
      ...(Array.isArray(inputs) ? { inputModalities: inputs } : {}),
    });
  }
  return models;
}

// ── Featherless ───────────────────────────────────────────────────────────
// Thousands of Hugging Face text models, all chat; registry names kept.
// Gated rows stay listed: a key whose account has the Hugging Face access can
// call them, and the list can't tell which keys do.
export function parseFeatherlessModels(body, statics = getModelsByProviderId("featherless")) {
  const names = new Map(statics.map((m) => [m.id, m.name]));
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: names.get(id) || id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.max_completion_tokens),
    });
  }
  return models;
}

// ── API.airforce ──────────────────────────────────────────────────────────
// Chat rows only (image, audio and rerank have no route here). `isFree` uses
// the same rule as the "airforce-free" suggested-models filter.
export function parseAirforceModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || seen.has(id) || entry.supports_chat !== true) continue;
    if (entry.media_type && entry.media_type !== "chat" && entry.media_type !== "text") continue;
    seen.add(id);
    models.push({
      id,
      name: entry.name || id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.max_output_tokens),
      isFree: entry.tier === "free" || id.endsWith(":free"),
      ...(entry.supports_images === true ? { inputModalities: ["text", "image"] } : {}),
    });
  }
  return models;
}

// The models endpoint sits beside the registry's OpenAI chat transport.
const modelsUrlBeside = (label, chatUrl) => {
  if (typeof chatUrl !== "string" || !chatUrl.endsWith("/chat/completions")) {
    throw new Error(`${label} registry chat URL must end in /chat/completions, got: ${chatUrl}`);
  }
  return chatUrl.replace(/\/chat\/completions$/, "/models");
};

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

// One authenticated GET. Returns { body } or { warning }; the warning reaches
// the dashboard, so the key is never echoed back.
async function fetchList(label, url, token, extraHeaders, proxyOptions) {
  const response = await proxyAwareFetch(
    url,
    {
      headers: { ...extraHeaders, Authorization: `Bearer ${token}`, Accept: "application/json" },
      // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    proxyOptions,
  );
  if (!response.ok) {
    const text = (await response.text()).replaceAll(token, "***").slice(0, 300);
    return { warning: `Failed to fetch ${label} models: ${response.status} ${text}` };
  }
  return { body: await response.json() };
}

// `nextUrl(body, url)` follows a paginated list; it returns a URL or nothing.
// `token` picks the credential (default: the API key); `headers` adds any
// provider headers the list needs.
const MAX_PAGES = 10;
const resolver =
  (label, url, parse, { nextUrl, token: pickToken = (c) => c.apiKey, headers } = {}) =>
  async (connection) => {
    const token = pickToken(connection);
    if (!token) return { models: [], warning: "No valid token found" };
    const proxyOptions = await connectionProxyOptions(connection);
    if (!proxyOptions) {
      return { models: [], warning: `Failed to fetch ${label} models: proxy resolution failed` };
    }
    const models = [];
    let pageUrl = url;
    for (let page = 0; pageUrl && page < MAX_PAGES; page++) {
      const { body, warning } = await fetchList(
        label,
        pageUrl,
        token,
        headers?.(connection) || {},
        proxyOptions,
      );
      if (warning) return { models: [], warning };
      models.push(...parse(body));
      pageUrl = nextUrl?.(body, pageUrl);
    }
    // Still a page to go: say so rather than pass a partial list off as whole.
    if (pageUrl && models.length) {
      return {
        models,
        warning: `${label} listed more than ${MAX_PAGES} pages; showing the first ${MAX_PAGES}.`,
      };
    }
    return models.length
      ? { models }
      : { models: [], warning: `${label} returned no live models.` };
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
export const resolveVenice = resolver(
  "Venice AI",
  "https://api.venice.ai/api/v1/models?type=all",
  parseVeniceModels,
);
export const resolveBazaarlink = resolver(
  "Bazaarlink",
  "https://bazaarlink.ai/api/v1/models",
  parseBazaarlinkModels,
);
export const resolveLlm7 = resolver("LLM7", "https://api.llm7.io/v1/models", parseLlm7Models);
export const resolveSambanova = resolver(
  "SambaNova",
  "https://api.sambanova.ai/v1/models",
  parseSambanovaModels,
);
export const resolveAlicode = resolver(
  "Alibaba Coding",
  "https://coding.dashscope.aliyuncs.com/v1/models",
  parseAlicodeModels,
);
export const resolveAlicodeIntl = resolver(
  "Alibaba Coding Intl",
  "https://coding-intl.dashscope.aliyuncs.com/v1/models",
  parseAlicodeModels,
);
export const resolveGlm = resolver(
  "GLM Coding",
  modelsUrlBeside("GLM", PROVIDERS.glm?.transports?.find((t) => t.format === "openai")?.baseUrl),
  (body) => parseGlmModels(body, "glm"),
);
export const resolveGlmCn = resolver(
  "GLM (China)",
  modelsUrlBeside("GLM", PROVIDERS["glm-cn"]?.baseUrl),
  (body) => parseGlmModels(body, "glm-cn"),
);
export const resolveMinimax = resolver(
  "MiniMax Coding",
  modelsUrlBeside(
    "MiniMax",
    PROVIDERS.minimax?.transports?.find((t) => t.format === "openai")?.baseUrl,
  ),
  (body) => parseMinimaxModels(body, "minimax"),
);
export const resolveMinimaxCn = resolver(
  "MiniMax (China)",
  modelsUrlBeside(
    "MiniMax",
    PROVIDERS["minimax-cn"]?.transports?.find((t) => t.format === "openai")?.baseUrl,
  ),
  (body) => parseMinimaxModels(body, "minimax-cn"),
);
const COHERE_MODELS_URL = "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000";
export const resolveCohere = resolver("Cohere", COHERE_MODELS_URL, parseCohereModels, {
  nextUrl: (body) =>
    typeof body?.next_page_token === "string" && body.next_page_token
      ? `${COHERE_MODELS_URL}&page_token=${encodeURIComponent(body.next_page_token)}`
      : undefined,
});
export const resolveTokenrouter = resolver(
  "TokenRouter",
  "https://api.tokenrouter.com/v1/models",
  (body) => parseTokenrouterModels(body),
);
export const resolveKiloGateway = resolver(
  "Kilo Gateway",
  "https://api.kilo.ai/api/gateway/models",
  (body) => parseKiloModels(body),
);
// Kilo Code (OAuth) lists the same gateway catalog its chat route serves; the
// token and the organization header match the chat executor's.
export const resolveKilocode = resolver(
  "Kilo Code",
  "https://api.kilo.ai/api/gateway/models",
  (body) => parseKiloModels(body),
  {
    token: (c) => c.apiKey || c.accessToken,
    headers: (c) =>
      c.providerSpecificData?.orgId
        ? { "X-Kilocode-OrganizationID": c.providerSpecificData.orgId }
        : {},
  },
);
// Paged by `page`/`per_page` (max 1000) with no next-page field: a full page
// means there may be another.
const FEATHERLESS_PAGE_SIZE = 1000;
const featherlessPage = (page) =>
  `https://api.featherless.ai/v1/models?per_page=${FEATHERLESS_PAGE_SIZE}&page=${page}`;
export const resolveFeatherless = resolver(
  "Featherless",
  featherlessPage(1),
  (body) => parseFeatherlessModels(body),
  {
    nextUrl: (body, url) =>
      entries(body).length >= FEATHERLESS_PAGE_SIZE
        ? featherlessPage(Number(new URL(url).searchParams.get("page")) + 1)
        : undefined,
  },
);
export const resolveAirforce = resolver(
  "API.airforce",
  "https://api.airforce/v1/models",
  parseAirforceModels,
);
