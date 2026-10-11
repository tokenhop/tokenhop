import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { resolveGatewayAuth, authorizeGatewayTarget } from "@/lib/auth/gatewayAuth.js";
import { buildModelsList } from "../route.js";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  if (model.contextWindow) out.contextWindow = model.contextWindow;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId
// requestedKind: optional, disambiguates duplicate ids across kinds (e.g. gemini-2.5-pro llm vs stt)
function lookup(fullId, requestedKind) {
  if (!fullId?.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = requestedKind
    ? list.find((x) => x.id === modelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === modelId);
  if (m) {
    const kind = getModelKind(m, "llm");
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (modelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias,
      providerId,
      kind: "webSearch",
      providerInfo,
      model: {
        id: "search",
        name: `${providerInfo.name} Search`,
        params: [
          "query",
          "max_results",
          "country",
          "language",
          "time_range",
          "domain_filter",
          "search_type",
        ],
      },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias,
      providerId,
      kind: "webFetch",
      providerInfo,
      model: {
        id: "fetch",
        name: `${providerInfo.name} Fetch`,
        params: ["url", "format", "max_characters"],
      },
    });
  }
  return null;
}

// Public fields of a /v1/models catalog entry (compatible nodes, custom/live
// models) in the info shape. Fields are picked explicitly: never spread the entry.
function fromCatalogEntry(id, entry, kind) {
  const entryKind = entry.kind || kind || "llm";
  const out = {
    id,
    name: id.slice(id.indexOf("/") + 1),
    kind: entryKind,
    owned_by: entry.owned_by,
    endpoint: entry.endpoint || KIND_ENDPOINT[entryKind] || null,
  };
  if (entry.capabilities) out.capabilities = entry.capabilities;
  const ctx = entry.context_length ?? entry.capabilities?.contextWindow;
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = ctx;
  return out;
}

const unavailable = (message) =>
  Response.json(
    { error: { message, type: "server_error" } },
    { status: 503, headers: { "Access-Control-Allow-Origin": "*" } },
  );

// Static miss: look the id up in the same principal-scoped catalog as GET
// /v1/models (compatible nodes, custom models), which already applies the key
// allowlist, grants and disabled-model filters. Legacy storage (principal null)
// intentionally reads the same unscoped catalog /v1/models serves.
async function catalogInfo(auth, id, kind) {
  let entry;
  try {
    const models = await buildModelsList(
      [kind || "llm"],
      auth.principal ? { principal: auth.principal } : undefined,
    );
    entry = models.find((m) => m.id === id);
  } catch {
    // Only errors the builder throws land here; its internal fail-open paths are unchanged.
    return unavailable("Model catalog unavailable");
  }
  if (!entry) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  return Response.json(fromCatalogEntry(id, entry, kind), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  let auth;
  try {
    auth = await resolveGatewayAuth(request);
  } catch {
    // Auth/state failures must fail closed as 503: never null-principal
    // discovery, never the legacy global path.
    return Response.json(
      { error: { message: "Gateway authentication unavailable", type: "server_error" } },
      { status: 503, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  if (auth instanceof Response) return auth;
  // Match the sibling catalog route: malformed auth state must never select
  // legacy, unscoped discovery.
  if (
    !(auth?.legacy === true && auth.principal === null) &&
    !(auth?.legacy === false && auth.principal)
  ) {
    return unavailable("Gateway authentication unavailable");
  }
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      {
        error: {
          message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)",
          type: "invalid_request_error",
        },
      },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  const staticInfo = lookup(id, kind);
  if (!staticInfo) {
    // Missing "/" means malformed id, not an unknown model: say so explicitly.
    if (!id.includes("/")) {
      return Response.json(
        {
          error: {
            message:
              "Invalid model id: expected format {provider}/{model} (e.g. gpt-4o → openai/gpt-4o)",
            type: "invalid_request_error",
          },
        },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    return catalogInfo(auth, id, kind);
  }
  const info = staticInfo;
  const slash = id.indexOf("/");
  const provider = id.slice(0, slash);
  const denied = authorizeGatewayTarget(auth.principal, {
    modelId: `${ALIAS_TO_ID[provider] || provider}/${id.slice(slash + 1)}`,
  });
  if (denied) return denied;
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
