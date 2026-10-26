// Live catalogs for Ollama Cloud (ollama.com) and Ollama Local (the user's
// daemon). Both serve GET /api/tags: { models: [{ name, model, details }] },
// no `id` field.

import { resolveOllamaLocalHost } from "open-sse/config/providers.js";
import { connectionProxyOptions } from "@/lib/network/connectionProxy";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

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

async function fetchTags(label, url, { headers = {}, timeoutMs, secret, proxyOptions }) {
  const response = await proxyAwareFetch(
    url,
    {
      headers: { Accept: "application/json", ...headers },
      // Failures aren't cached, so an unbounded hang would stall every /v1/models call.
      signal: AbortSignal.timeout(timeoutMs),
    },
    proxyOptions,
  );
  if (!response.ok) {
    let text = (await response.text()).slice(0, 300);
    if (secret) text = text.replaceAll(secret, "***");
    return { models: [], warning: `Failed to fetch ${label} models: ${response.status} ${text}` };
  }
  const models = parseOllamaTags(await response.json());
  return models.length ? { models } : { models: [], warning: `${label} returned no live models.` };
}

// The cloud list is public; the key is sent anyway so an account-scoped list wins.
export async function resolveOllama(connection) {
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) {
    return { models: [], warning: "Failed to fetch Ollama Cloud models: proxy resolution failed" };
  }
  try {
    return await fetchTags("Ollama Cloud", CLOUD_TAGS_URL, {
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      timeoutMs: CLOUD_TIMEOUT_MS,
      secret: connection.apiKey,
      proxyOptions,
    });
  } catch (error) {
    return { models: [], warning: `Ollama Cloud not reachable: ${error?.message || error}` };
  }
}

export async function resolveOllamaLocal(connection) {
  const host = resolveOllamaLocalHost(connection);
  const proxyOptions = await connectionProxyOptions(connection);
  if (!proxyOptions) {
    return { models: [], warning: "Failed to fetch Ollama Local models: proxy resolution failed" };
  }
  try {
    return await fetchTags("Ollama Local", `${host}/api/tags`, {
      timeoutMs: LOCAL_TIMEOUT_MS,
      proxyOptions,
    });
  } catch {
    return { models: [], warning: `Ollama not reachable at ${host}` };
  }
}
