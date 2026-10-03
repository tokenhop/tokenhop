// Live catalogs for OpenAI-style API-key providers (GET …/models, Bearer key):
// DeepSeek, Mistral and Groq. Each list carries every kind the provider
// serves, so it is authoritative: no static extras are added back.

import { getModelsByProviderId } from "open-sse/config/providerModels.js";

const FETCH_TIMEOUT_MS = 10_000;
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const entries = (body) => (Array.isArray(body?.data) ? body.data : []);
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
// Deprecated entries are dropped; an alias group (dated id + `-latest`) is
// listed once, under the `-latest` id the registry uses. OCR, moderation and
// classifier models have no route here.
export function parseMistralModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of entries(body)) {
    const id = idOf(entry);
    if (!id || entry.deprecation) continue;
    const names = [id, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    const primary = names.find((n) => n.endsWith("-latest")) || id;
    if (names.some((n) => seen.has(n))) continue;
    for (const n of names) seen.add(n);
    const kind = /embed/i.test(id)
      ? "embedding"
      : entry.capabilities?.completion_chat
        ? "llm"
        : null;
    if (!kind) continue;
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
    if (/tts|orpheus/i.test(id)) continue;
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

const resolver = (label, url, parse) => async (connection) => {
  if (!connection.apiKey) return { models: [], warning: "No valid token found" };
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
    // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
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
