// Model Garden catalogs are publisher-wide, not a list of models enabled in the
// connection's project. Only advertise models served by our existing routes.
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import {
  parseVertexSaJson,
  parseVertexAdcJson,
  vertexProjectId,
  canServeVertexVideo,
  refreshGoogleToken,
  refreshVertexToken,
} from "open-sse/services/tokenRefresh.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import {
  proxyOptionsFromConfig,
  resolveConnectionProxyConfig,
} from "@/lib/network/connectionProxy";

const MODELS_BASE_URL = "https://aiplatform.googleapis.com/v1beta1/publishers";
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const EXPRESS_WARNING =
  "Vertex AI API-key (express mode) connections can't list models; add a Service Account JSON to use the live catalog.";

// These publishers supply the static MaaS ids and support the executor's global
// OpenAI chat endpoint. Do not add Anthropic (rawPredict) or publishers requiring
// regional endpoints/self-deployment. Keep this list separate from model ids so
// new MaaS chat models from these publishers need no registry update.
export const VERTEX_PARTNER_PUBLISHERS = ["deepseek-ai", "qwen", "zai-org"];

const unrouted = /embedding|(^|[-_])(tts|live|audio|image|imagen)([-_]|$)|native-audio/i;
// The API currently documents UNSPECIFIED/EXPERIMENTAL/PRIVATE_PREVIEW/
// PUBLIC_PREVIEW/GA. Explicitly reject retired values if upstream sends them.
const retired = (model) => /^(DEPRECATED|LEGACY)$/i.test(model?.launchStage || "");
const entries = (body) => (Array.isArray(body?.publisherModels) ? body.publisherModels : []);

function publisherModelId(model, publisher) {
  const prefix = `publishers/${publisher}/models/`;
  if (typeof model?.name !== "string" || !model.name.startsWith(prefix)) return null;
  const id = model.name.slice(prefix.length);
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ? id : null;
}

function parsePublisherModels(body, publisher, provider) {
  const statics = new Map(getModelsByProviderId(provider).map((m) => [m.id, m]));
  const models = new Map();
  for (const model of entries(body)) {
    const bareId = publisherModelId(model, publisher);
    if (!bareId || retired(model) || unrouted.test(bareId)) continue;
    let kind;
    if (provider === "vertex") {
      if (bareId.startsWith("veo-")) kind = "video";
      else if (!bareId.startsWith("gemini-")) continue;
    } else if (!bareId.endsWith("-maas")) continue;
    const id = provider === "vertex" ? bareId : `${publisher}/${bareId}`;
    const known = statics.get(id);
    models.set(id, known ? { ...known } : { id, name: id, ...(kind ? { kind } : {}) });
  }
  return [...models.values()];
}

/** Parse Google publisher resources into routable Gemini chat and Veo rows. */
export function parseVertexModels(body) {
  return parsePublisherModels(body, "google", "vertex");
}

/** Parse one configured partner's MaaS chat resources into publisher/model ids. */
export function parseVertexPartnerModels(body, publisher) {
  if (!VERTEX_PARTNER_PUBLISHERS.includes(publisher)) return [];
  return parsePublisherModels(body, publisher, "vertex-partner");
}

// Refresh helpers do not accept a signal, so bound their wait without changing
// their shared token-cache behaviour. Remove listeners on successful completion.
function withinDeadline(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function withStaticVertexModels(providerId, models) {
  const live = new Set(models.map((model) => model.id));
  return [
    ...models,
    ...getModelsByProviderId(providerId)
      .filter((model) => !live.has(model.id))
      .map((model) => ({ ...model })),
  ];
}

async function fetchPublisher(publisher, token, projectId, proxyOptions, signal) {
  const publisherModels = [];
  const seenTokens = new Set();
  let pageToken;
  const partial = (reason) => ({ publisherModels, error: `${publisher}: ${reason}` });
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${MODELS_BASE_URL}/${publisher}/models?pageSize=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    try {
      signal.throwIfAborted();
      const response = await withinDeadline(
        proxyAwareFetch(
          url,
          {
            headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": projectId },
            signal,
          },
          proxyOptions,
        ),
        signal,
      );
      // Never echo upstream bodies or exception messages: they can contain keys.
      if (!response.ok) return partial(`HTTP ${response.status}`);
      const body = await withinDeadline(response.json(), signal);
      publisherModels.push(...entries(body));
      pageToken = body?.nextPageToken;
      if (typeof pageToken !== "string" || !pageToken) return { publisherModels };
      if (seenTokens.has(pageToken)) return partial("repeated page token");
      seenTokens.add(pageToken);
    } catch {
      return partial("catalog request failed or deadline exceeded");
    }
  }
  return partial("page cap reached");
}

async function resolveCatalog(connection, partner) {
  const sa = parseVertexSaJson(connection.apiKey);
  const adc = parseVertexAdcJson(connection.apiKey);
  if (!sa && !adc && !connection.accessToken) return { models: [], warning: EXPRESS_WARNING };
  const label = partner ? "Vertex Partner" : "Vertex AI";
  const failure = (reason) => ({
    models: [],
    warning: `Failed to fetch ${label} models: ${reason}`,
  });
  const projectId = vertexProjectId(connection, sa, adc);
  if (!projectId) {
    return failure(
      "models require a project_id; add Service Account JSON, ADC quota_project_id or set providerSpecificData.projectId.",
    );
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let proxyOptions;
  try {
    const proxy = await withinDeadline(
      resolveConnectionProxyConfig(connection.providerSpecificData || {}),
      signal,
    );
    if (proxy.source === "error") return failure("proxy resolution failed");
    proxyOptions = proxyOptionsFromConfig(proxy);
  } catch {
    return failure("proxy resolution failed or deadline exceeded");
  }
  let token = connection.accessToken;
  try {
    if (sa)
      token = (await withinDeadline(refreshVertexToken(sa, undefined, proxyOptions), signal))
        ?.accessToken;
    else if (adc) {
      token = (
        await withinDeadline(
          refreshGoogleToken(
            adc.refresh_token,
            adc.client_id,
            adc.client_secret,
            undefined,
            proxyOptions,
          ),
          signal,
        )
      )?.accessToken;
    }
  } catch {
    return failure("could not acquire an access token");
  }
  if (!token) return failure("could not acquire an access token");
  const publishers = partner ? VERTEX_PARTNER_PUBLISHERS : ["google"];
  const results = await Promise.all(
    publishers.map((p) => fetchPublisher(p, token, projectId, proxyOptions, signal)),
  );
  const models = new Map();
  for (let i = 0; i < results.length; i++) {
    const rows = partner
      ? parseVertexPartnerModels(results[i], publishers[i])
      : parseVertexModels(results[i]);
    for (const model of rows) models.set(model.id, model);
  }
  const errors = results.flatMap((result) => (result.error ? [result.error] : []));
  if (models.size) {
    const merged = withStaticVertexModels(partner ? "vertex-partner" : "vertex", [
      ...models.values(),
    ]).filter((model) => (model.kind || model.type) !== "video" || canServeVertexVideo(connection));
    if (merged.length)
      return {
        models: merged,
        ...(errors.length ? { warning: `Partial ${label} catalog: ${errors.join("; ")}` } : {}),
      };
  }
  return errors.length
    ? failure(errors.join("; "))
    : { models: [], warning: `${label} returned no live models.` };
}

export const resolveVertex = (connection) => resolveCatalog(connection, false);
export const resolveVertexPartner = (connection) => resolveCatalog(connection, true);
