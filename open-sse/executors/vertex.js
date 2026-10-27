import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  parseVertexSaJson,
  parseVertexAdcJson,
  vertexProjectId,
  refreshVertexToken,
  refreshGoogleToken,
} from "../services/tokenRefresh.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Cache project IDs resolved from raw API keys { apiKey → projectId }
const projectIdCache = new Map();

/**
 * Resolve GCP project ID from a raw Vertex API key.
 * Sends a dummy 404 request and parses "projects/{id}" from the error message.
 */
async function resolveProjectId(apiKey, proxyOptions = null) {
  if (projectIdCache.has(apiKey)) return projectIdCache.get(apiKey);

  // Key in a header, not ?key= — proxy relays log pathname+search (YAN-1629).
  const res = await proxyAwareFetch(
    `https://aiplatform.googleapis.com/v1/publishers/google/models/__probe__:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: "{}",
    },
    proxyOptions,
  );
  const json = await res.json().catch(() => null);
  const msg = json?.[0]?.error?.message || json?.error?.message || "";
  const match = msg.match(/projects\/([^/]+)\//);
  const projectId = match?.[1] || null;

  if (projectId) projectIdCache.set(apiKey, projectId);
  return projectId;
}

/**
 * VertexExecutor - Google Cloud Vertex AI
 *
 * "vertex"         → Gemini models via regional/global Vertex endpoint
 * "vertex-partner" → Partner models (Llama, Mistral, GLM, DeepSeek, Qwen)
 *                    via global OpenAI-compatible endpoint
 *
 * Auth: SA JSON (stored as apiKey) → JWT assertion → Bearer token (via jose)
 * Token is minted/cached in tokenRefresh.js, not here.
 */
export class VertexExecutor extends BaseExecutor {
  constructor(providerId = "vertex") {
    super(providerId, PROVIDERS[providerId] || {});
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const saJson = parseVertexSaJson(credentials?.apiKey);
    const adcJson = parseVertexAdcJson(credentials?.apiKey);
    const usesOAuth = !!saJson || !!adcJson || !!credentials?.accessToken;
    const projectId = vertexProjectId(credentials, saJson, adcJson);

    if (this.provider === "vertex-partner") {
      // Partner models require project_id in path regardless of auth method
      if (!projectId)
        throw new Error(
          "Vertex partner models require a project_id. Add it in providerSpecificData or use Service Account JSON.",
        );
      // Key in a header, not ?key= — proxy relays log pathname+search (YAN-1629).
      return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/endpoints/openapi/chat/completions`;
    }

    // Gemini on Vertex
    const action = stream ? "streamGenerateContent" : "generateContent";

    if (usesOAuth) {
      // SA JSON / ADC / pre-set accessToken: must use project-scoped path to avoid RESOURCE_PROJECT_INVALID
      if (!projectId) {
        throw new Error(
          "Vertex OAuth/ADC requires a project_id. " +
            "Add quota_project_id to your ADC JSON or set providerSpecificData.projectId.",
        );
      }
      const location = credentials?.providerSpecificData?.location || "us-central1";
      let url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${action}`;
      if (stream) url += "?alt=sse";
      return url;
    }

    // Raw API key: use global publishers endpoint; key goes in header (buildHeaders).
    // ?alt=sse is required for proper SSE streaming (matches every other Gemini executor)
    let url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:${action}`;
    if (stream) url += "?alt=sse";
    return url;
  }

  buildHeaders(credentials, stream = true) {
    const headers = { "Content-Type": "application/json" };

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    } else if (
      credentials?.apiKey &&
      !parseVertexSaJson(credentials.apiKey) &&
      !parseVertexAdcJson(credentials.apiKey)
    ) {
      // Key in a header, not ?key= — proxy relays log pathname+search (YAN-1629).
      headers["x-goog-api-key"] = credentials.apiKey;
    }

    if (stream) headers["Accept"] = "text/event-stream";

    return headers;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    const saJson = parseVertexSaJson(credentials?.apiKey);
    if (!saJson) return null;

    const result = await refreshVertexToken(saJson, log, proxyOptions);
    if (!result?.accessToken) return null;

    return { accessToken: result.accessToken, expiresAt: result.expiresAt };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const saJson = parseVertexSaJson(credentials?.apiKey);
    const adcJson = parseVertexAdcJson(credentials?.apiKey);

    // SA JSON flow: mint Bearer token via JWT assertion (cached)
    if (saJson) {
      const result = await refreshVertexToken(saJson, log, proxyOptions);
      if (!result?.accessToken)
        throw new Error("Vertex: failed to mint access token from Service Account JSON");
      credentials.accessToken = result.accessToken;
    }

    // ADC user credential flow: refresh Bearer token via Google OAuth2 token endpoint
    if (adcJson) {
      const result = await refreshGoogleToken(
        adcJson.refresh_token,
        adcJson.client_id,
        adcJson.client_secret,
        log,
        proxyOptions,
      );
      if (!result?.accessToken)
        throw new Error("Vertex: failed to refresh access token from ADC JSON (authorized_user)");
      credentials.accessToken = result.accessToken;
    }

    // vertex-partner with raw key: auto-resolve project_id if not provided
    if (
      this.provider === "vertex-partner" &&
      !saJson &&
      !adcJson &&
      !credentials?.providerSpecificData?.projectId
    ) {
      const projectId = await resolveProjectId(credentials.apiKey, proxyOptions);
      if (!projectId)
        throw new Error(
          "Vertex: could not resolve project_id from API key. Please add it manually in provider settings.",
        );
      log?.debug?.("VERTEX", `Resolved project_id: ${projectId}`);
      credentials.providerSpecificData = { ...credentials.providerSpecificData, projectId };
    }

    const url = this.buildUrl(model, stream, 0, credentials);
    const headers = this.buildHeaders(credentials, stream);
    const transformedBody = this.transformRequest(model, body, stream, credentials);

    const response = await proxyAwareFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal,
      },
      proxyOptions,
    );

    return { response, url, headers, transformedBody };
  }
}

export default VertexExecutor;
