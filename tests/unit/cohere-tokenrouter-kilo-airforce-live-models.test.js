// Live Cohere, TokenRouter, Kilo Gateway and API.airforce (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseAirforceModels,
  parseCohereModels,
  parseKiloModels,
  parseTokenrouterModels,
} from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["cohere", "tokenrouter", "kilo-gateway", "api-airforce"];
const HOSTS = [
  "https://api.cohere.com/",
  "https://api.tokenrouter.com/",
  "https://api.kilo.ai/",
  "https://api.airforce/",
];

let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of PROVIDERS) await deleteProviderConnectionsByProviderUnscoped(p);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!HOSTS.some((h) => String(url).startsWith(h))) return nativeFetch(url, init);
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return respond(String(url));
  });
});

afterEach(() => vi.unstubAllGlobals());

const connect = (provider, apiKey) =>
  createProviderConnectionUnscoped({ provider, authType: "apikey", apiKey, testStatus: "active" });

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

describe("parsers", () => {
  it("cohere maps name to id and keeps chat rows only", () => {
    const body = {
      models: [
        {
          name: "command-a-vision-07-2025",
          endpoints: ["chat"],
          context_length: 128000,
          features: ["vision"],
        },
        { name: "command-r-08-2024", endpoints: ["generate", "chat"], context_length: 128000 },
        { name: "embed-v4.0", endpoints: ["embed"] },
        { name: "rerank-v3.5", endpoints: ["rerank"] },
        { name: "command-old", endpoints: ["chat"], is_deprecated: true },
        { endpoints: ["chat"] },
      ],
    };
    expect(parseCohereModels(body)).toEqual([
      {
        id: "command-a-vision-07-2025",
        name: "command-a-vision-07-2025",
        contextLength: 128000,
        inputModalities: ["text", "image"],
      },
      { id: "command-r-08-2024", name: "command-r-08-2024", contextLength: 128000 },
    ]);
  });

  it("tokenrouter keeps registry names and kinds, classifies the rest by id", () => {
    const statics = [
      { id: "openai/gpt-5.5", name: "Gpt 5.5" },
      { id: "acme/known-embedder", name: "Known Embedder", kind: "embedding" },
    ];
    const body = {
      data: [
        { id: "openai/gpt-5.5" },
        { id: "acme/known-embedder" },
        { id: "moonshotai/kimi-k3-free", context_length: 262144 },
        { id: "openai/text-embedding-3-small" },
        { id: "openai/gpt-image-2" },
        { id: "black-forest-labs/flux-2-pro" },
        { id: "openai/whisper-1" },
        { id: "openai/omni-moderation-latest" },
        { id: "google/veo-4", architecture: { output_modalities: ["video"] } },
      ],
    };
    expect(parseTokenrouterModels(body, statics)).toEqual([
      { id: "openai/gpt-5.5", name: "Gpt 5.5", contextLength: undefined, isFree: false },
      {
        id: "acme/known-embedder",
        name: "Known Embedder",
        contextLength: undefined,
        isFree: false,
        kind: "embedding",
      },
      {
        id: "moonshotai/kimi-k3-free",
        name: "moonshotai/kimi-k3-free",
        contextLength: 262144,
        isFree: true,
      },
      {
        id: "openai/text-embedding-3-small",
        name: "openai/text-embedding-3-small",
        contextLength: undefined,
        isFree: false,
        kind: "embedding",
      },
      {
        id: "openai/gpt-image-2",
        name: "openai/gpt-image-2",
        contextLength: undefined,
        isFree: false,
        kind: "image",
      },
      {
        id: "black-forest-labs/flux-2-pro",
        name: "black-forest-labs/flux-2-pro",
        contextLength: undefined,
        isFree: false,
        kind: "image",
      },
    ]);
  });

  it("kilo keeps text rows, trusts its isFree flag and drops expired rows", () => {
    const now = Date.parse("2026-10-31T00:00:00Z");
    const body = {
      data: [
        {
          id: "kilo-auto/efficient",
          name: "Kilo Auto Efficient",
          context_length: 1000000,
          pricing: { prompt: "-1", completion: "-1" },
          isFree: false,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          top_provider: { max_completion_tokens: 65536 },
        },
        {
          id: "kilo-auto/free",
          name: "Kilo Auto Free",
          pricing: { prompt: "0", completion: "0" },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        },
        {
          id: "google/gemini-nano-banana-2.1",
          architecture: { output_modalities: ["image", "text"] },
        },
        { id: "img/only", architecture: { output_modalities: ["image"] } },
        { id: "old/model:free", expiration_date: "2026-10-01" },
      ],
    };
    expect(parseKiloModels(body, now)).toEqual([
      {
        id: "kilo-auto/efficient",
        name: "Kilo Auto Efficient",
        contextLength: 1000000,
        maxOutputTokens: 65536,
        isFree: false,
        inputModalities: ["text", "image"],
      },
      {
        id: "kilo-auto/free",
        name: "Kilo Auto Free",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: true,
        inputModalities: ["text"],
      },
      {
        id: "google/gemini-nano-banana-2.1",
        name: "google/gemini-nano-banana-2.1",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: false,
      },
    ]);
  });

  it("airforce keeps chat rows and marks the free tier", () => {
    const body = {
      object: "list",
      data: [
        {
          id: "gpt-oss-20b",
          supports_chat: true,
          tier: "free",
          context_length: 131072,
          max_output_tokens: 32768,
        },
        { id: "glm-5.3-flash", supports_chat: true, tier: "paid", supports_images: true },
        { id: "deepseek-v4:free", supports_chat: true, tier: "paid", media_type: "chat" },
        { id: "flux-3", supports_chat: false, media_type: "image" },
        { id: "suno-v6", supports_chat: true, media_type: "audio" },
        { id: "rerank-x", supports_chat: true, media_type: "rerank" },
      ],
    };
    expect(parseAirforceModels(body)).toEqual([
      {
        id: "gpt-oss-20b",
        name: "gpt-oss-20b",
        contextLength: 131072,
        maxOutputTokens: 32768,
        isFree: true,
      },
      {
        id: "glm-5.3-flash",
        name: "glm-5.3-flash",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: false,
        inputModalities: ["text", "image"],
      },
      {
        id: "deepseek-v4:free",
        name: "deepseek-v4:free",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: true,
      },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("cohere follows next_page_token and lists chat models in /v1/models", async () => {
    respond = (url) =>
      url.includes("page_token=")
        ? Response.json({ models: [{ name: "command-b", endpoints: ["chat"] }] })
        : Response.json({
            models: [{ name: "command-a", endpoints: ["chat"] }],
            next_page_token: "p 2",
          });
    const conn = await connect("cohere", "co-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["command-a", "command-b"]);
    expect(calls).toEqual([
      {
        url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
        auth: "Bearer co-test",
      },
      {
        url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000&page_token=p%202",
        auth: "Bearer co-test",
      },
    ]);
    const alias = getProviderAlias("cohere");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/command-b`);
  });

  it.each([
    ["cohere", "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000"],
    ["tokenrouter", "https://api.tokenrouter.com/v1/models"],
    ["kilo-gateway", "https://api.kilo.ai/api/gateway/models"],
    ["api-airforce", "https://api.airforce/v1/models"],
  ])("%s failure keeps the static list with a warning", async (provider, url) => {
    respond = () => new Response("bad key sk-secret", { status: 401 });
    const conn = await connect(provider, "sk-secret");

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("sk-secret");
  });
});
