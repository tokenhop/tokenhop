// Live OpenRouter catalog. /models/user honours the key's provider and privacy
// filters; when the key can't use it, the public /models list stands in.
// output_modalities=all returns every kind, not only text models.

import { withStaticNonChatModels } from "@/lib/providerModels/staticExtras.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const QUERY = "?output_modalities=all";
const FETCH_TIMEOUT_MS = 10_000;

// Output modality → tokenhop kind. rerank, decisions and transcription have no
// route here, so they are dropped.
const KIND_BY_OUTPUT = {
  text: "llm",
  embeddings: "embedding",
  speech: "tts",
  image: "image",
  video: "video",
};

// Prices are decimal strings ("0", sometimes "0.0").
const isZero = (value) => value != null && value !== "" && Number(value) === 0;
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);

const list = (value, fallback) => (Array.isArray(value) ? value : fallback);

// One entry per (id, kind): an image+text model is listed as both kinds, so
// downstream dedupe must key on kind + id, never id alone.
export function parseOpenRouterModels(body) {
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const outputs = list(entry.architecture?.output_modalities, ["text"]);
    const kinds = [...new Set(outputs.map((m) => KIND_BY_OUTPUT[m]).filter(Boolean))];
    const base = {
      id,
      name: entry.name || id,
      contextLength: positive(entry.context_length),
      maxOutputTokens: positive(entry.top_provider?.max_completion_tokens),
      isFree: isZero(entry.pricing?.prompt) && isZero(entry.pricing?.completion),
      inputModalities: list(entry.architecture?.input_modalities, []),
    };
    for (const kind of kinds) models.push({ ...base, ...(kind !== "llm" ? { kind } : {}) });
  }
  return models;
}

async function fetchList(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Error pages can be large HTML; the warning only needs the start.
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
  return parseOpenRouterModels(await response.json());
}

export async function resolveOpenRouter(connection) {
  let models = null;
  let error;
  if (connection.apiKey) {
    try {
      models = await fetchList(`${MODELS_URL}/user${QUERY}`, connection.apiKey);
    } catch (e) {
      error = e;
    }
  }
  // Only a failed /models/user falls back. An empty one means the key's
  // filters allow nothing, and the public list would hide that.
  if (models === null) {
    try {
      models = await fetchList(`${MODELS_URL}${QUERY}`);
    } catch (e) {
      error = e;
    }
  }
  if (!models?.length) {
    return {
      models: [],
      warning:
        !models && error
          ? `Failed to fetch OpenRouter models: ${error.message}`
          : "OpenRouter returned no live models.",
    };
  }
  return { models: withStaticNonChatModels("openrouter", models) };
}
