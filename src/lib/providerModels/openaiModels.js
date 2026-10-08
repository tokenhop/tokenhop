// Live model catalog for OpenAI API keys (GET /v1/models). The list carries no
// kind or capability info, so kinds come from the static registry when it knows
// the id, else from the id pattern. Ids no tokenhop route can serve are dropped.

import { getModelsByProviderId } from "open-sse/config/providerModels.js";

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

// First match wins. `null` = drop: moderation, realtime/WebSocket, Sora video,
// legacy upstream completion models and computer-use are not supported. The
// gateway serves /v1/completions through chat translation, not those legacy
// upstream models, so their ids stay excluded from the servable catalog.
const ID_KINDS = [
  [
    /moderation|(^|-)realtime(-|$)|^sora-|^(babbage|davinci)-|^text-(ada|babbage|curie|davinci)-|-instruct\b|^computer-use/,
    null,
  ],
  [/^text-embedding-/, "embedding"],
  [/^whisper-|-transcribe\b/, "stt"],
  [/^tts-|-tts\b/, "tts"],
  [/^dall-e-|^(chatgpt|gpt)-image-/, "image"],
];

/** Kind for an OpenAI model id: "llm", a media kind, or null (not servable). */
export function classifyOpenAIModel(id) {
  const lower = id.toLowerCase();
  // Fine-tunes are chat models whatever their base id looks like.
  if (lower.startsWith("ft:")) return "llm";
  for (const [pattern, kind] of ID_KINDS) if (pattern.test(lower)) return kind;
  return "llm";
}

export function parseOpenAIModels(body, staticModels = getModelsByProviderId("openai")) {
  // id → every static kind (one id can be listed under several kinds).
  const staticKinds = new Map();
  for (const m of staticModels) {
    staticKinds.set(m.id, [...(staticKinds.get(m.id) || []), m.kind || m.type || "llm"]);
  }
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kinds = staticKinds.get(id) || [classifyOpenAIModel(id)];
    for (const kind of kinds.filter(Boolean)) {
      models.push({ id, name: id, ...(kind !== "llm" ? { kind } : {}) });
    }
  }
  return models;
}

export async function resolveOpenAI(connection) {
  if (!connection.apiKey) return { models: [], warning: "No valid token found" };
  const response = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
    // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return {
      models: [],
      warning: `Failed to fetch OpenAI models: ${response.status} ${await response.text()}`,
    };
  }
  // Every kind comes from this one list, so it is authoritative: no static extras.
  const models = parseOpenAIModels(await response.json());
  return models.length ? { models } : { models: [], warning: "OpenAI returned no live models." };
}
