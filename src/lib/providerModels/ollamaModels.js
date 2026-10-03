// Live catalogs for Ollama Cloud (ollama.com) and Ollama Local (the user's
// daemon). Both serve GET /api/tags: { models: [{ name, model, details }] },
// no `id` field.

import { resolveOllamaLocalHost } from "open-sse/config/providers.js";

const CLOUD_TAGS_URL = "https://ollama.com/api/tags";
const CLOUD_TIMEOUT_MS = 10_000;
// A stopped local daemon refuses at once; the timeout covers a wrong host.
const LOCAL_TIMEOUT_MS = 5_000;

// Embedding models have no Ollama route here (chat only), so they are dropped.
const isEmbedding = (entry, id) =>
  /embed/i.test(id) ||
  [entry.details?.family, ...(entry.details?.families || [])].some((f) => /bert/i.test(f || ""));

export function parseOllamaTags(body) {
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(body?.models) ? body.models : []) {
    const raw = entry?.model || entry?.name;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id) || isEmbedding(entry, id)) continue;
    seen.add(id);
    models.push({ id, name: entry.name || id });
  }
  return models;
}

async function fetchTags(label, url, { headers = {}, timeoutMs, secret }) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    let text = (await response.text()).slice(0, 300);
    if (secret) text = text.replaceAll(secret, "***");
    return { models: [], warning: `Failed to fetch ${label} models: ${response.status} ${text}` };
  }
  const models = parseOllamaTags(await response.json());
  return models.length ? { models } : { models: [], warning: `${label} returned no live models.` };
}

// The cloud list is public; the key is sent anyway so an account-scoped list wins.
export const resolveOllama = (connection) =>
  fetchTags("Ollama Cloud", CLOUD_TAGS_URL, {
    headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
    timeoutMs: CLOUD_TIMEOUT_MS,
    secret: connection.apiKey,
  });

export async function resolveOllamaLocal(connection) {
  const host = resolveOllamaLocalHost(connection);
  try {
    return await fetchTags("Ollama Local", `${host}/api/tags`, { timeoutMs: LOCAL_TIMEOUT_MS });
  } catch {
    return { models: [], warning: `Ollama not reachable at ${host}` };
  }
}
