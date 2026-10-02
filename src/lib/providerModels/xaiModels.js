// Live model catalog for xAI (api.x.ai), API key or OAuth (scope api:access).
// Chat models come from /v1/language-models; image and video models from their
// own lists, which are optional: if one fails, its static entries are kept.

import { refreshTokenByProvider } from "@/sse/services/tokenRefresh";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";

const XAI_API_BASE = "https://api.x.ai/v1";
const XAI_LANGUAGE_MODELS_URL = `${XAI_API_BASE}/language-models`;
const XAI_OPTIONAL_LISTS = [
  { kind: "image", url: `${XAI_API_BASE}/image-generation-models` },
  { kind: "video", url: `${XAI_API_BASE}/video-generation-models` },
];

const kindOf = (model) => model?.kind || model?.type || "llm";

export function parseXaiModels(body, kind = "llm") {
  return (Array.isArray(body?.models) ? body.models : [])
    .filter((m) => typeof m?.id === "string" && m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.id.trim(),
      ...(kind !== "llm" ? { kind } : {}),
      aliases: Array.isArray(m.aliases) ? m.aliases.filter((a) => typeof a === "string") : [],
    }));
}

/**
 * Keep the static (routing) id when the live catalog lists it only as an alias
 * of a dated id, so curated names/params still apply. Aliases are then dropped.
 */
export function reconcileXaiAliases(liveModels, staticModels) {
  const staticKeys = new Set(staticModels.map((m) => `${kindOf(m)}:${m.id}`));
  const seen = new Set();
  const result = [];
  for (const { aliases = [], ...model } of liveModels) {
    const kind = kindOf(model);
    const alias = staticKeys.has(`${kind}:${model.id}`)
      ? null
      : aliases.find((a) => staticKeys.has(`${kind}:${a}`));
    const id = alias || model.id;
    if (seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    result.push({ ...model, id, name: alias ? id : model.name });
  }
  return result;
}

const fetchList = (url, token) =>
  fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });

// The language list decides success (and drives the OAuth refresh); the media
// lists are fetched with the token that worked.
const fetchLanguageModels = (token) => fetchList(XAI_LANGUAGE_MODELS_URL, token);

const resolveXaiOAuth = buildOAuthResolver({
  refreshFn: (conn) => refreshTokenByProvider("xai", conn),
  fetchFn: fetchLanguageModels,
  parseFn: (body) => parseXaiModels(body),
  errorLabel: "Failed to fetch xAI models",
});

async function resolveXaiApiKey(connection) {
  const response = await fetchLanguageModels(connection.apiKey);
  if (!response.ok) {
    return {
      models: [],
      warning: `Failed to fetch xAI models: ${response.status} ${await response.text()}`,
    };
  }
  return { models: parseXaiModels(await response.json()) };
}

async function fetchOptionalLists(token, staticModels) {
  const lists = await Promise.all(
    XAI_OPTIONAL_LISTS.map(async ({ kind, url }) => {
      try {
        const response = await fetchList(url, token);
        if (response.ok) return parseXaiModels(await response.json(), kind);
        console.log(`xAI ${kind} model list failed (${response.status}); keeping static entries`);
      } catch (error) {
        console.log(`xAI ${kind} model list failed: ${error.message}; keeping static entries`);
      }
      return staticModels.filter((m) => kindOf(m) === kind);
    }),
  );
  return lists.flat();
}

export async function resolveXai(connection) {
  if (!connection.accessToken && !connection.apiKey) {
    return { models: [], warning: "No valid token found" };
  }

  const result = connection.accessToken
    ? await resolveXaiOAuth(connection)
    : await resolveXaiApiKey(connection);
  const warning = result.error || result.warning;
  if (!result.models?.length) {
    return { models: [], warning: warning || "xAI returned no live models." };
  }

  const staticModels = getModelsByProviderId("xai");
  // OAuth may have refreshed the token in place.
  const media = await fetchOptionalLists(connection.accessToken || connection.apiKey, staticModels);
  return { models: reconcileXaiAliases([...result.models, ...media], staticModels) };
}
