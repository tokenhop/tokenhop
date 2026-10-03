// Live Venice, Bazaarlink, LLM7 and SambaNova (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseBazaarlinkModels,
  parseLlm7Models,
  parseSambanovaModels,
  parseVeniceModels,
} from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["venice", "bazaarlink", "llm7", "sambanova"];
const HOSTS = [
  "https://api.venice.ai/",
  "https://bazaarlink.ai/",
  "https://api.llm7.io/",
  "https://llm7.example.test/",
  "https://api.sambanova.ai/",
];

let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of PROVIDERS) await deleteProviderConnectionsByProvider(p);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!HOSTS.some((h) => String(url).startsWith(h))) return nativeFetch(url, init);
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return respond(String(url));
  });
});

afterEach(() => vi.unstubAllGlobals());

const connect = (provider, apiKey, providerSpecificData) =>
  createProviderConnection({
    provider,
    authType: "apikey",
    apiKey,
    testStatus: "active",
    ...(providerSpecificData ? { providerSpecificData } : {}),
  });

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

describe("parsers", () => {
  it("venice maps text/embedding/image and drops unrouted or offline rows", () => {
    const body = {
      data: [
        {
          id: "gemini-3-6-flash",
          type: "text",
          model_spec: {
            name: "Gemini 3.6 Flash",
            availableContextTokens: 1000000,
            maxCompletionTokens: 65536,
            capabilities: { supportsVision: true },
          },
        },
        { id: "text-embedding-bge-m3", type: "embedding", model_spec: { name: "BGE-M3" } },
        { id: "venice-sd35", type: "image", model_spec: { name: "Venice SD35" } },
        { id: "kling-video", type: "video", model_spec: {} },
        { id: "tts-kokoro", type: "tts", model_spec: {} },
        { id: "old-chat", type: "text", model_spec: { offline: true } },
      ],
    };
    expect(parseVeniceModels(body)).toEqual([
      {
        id: "gemini-3-6-flash",
        name: "Gemini 3.6 Flash",
        contextLength: 1000000,
        maxOutputTokens: 65536,
        inputModalities: ["text", "image"],
      },
      { id: "text-embedding-bge-m3", name: "BGE-M3", kind: "embedding" },
      { id: "venice-sd35", name: "Venice SD35", kind: "image" },
    ]);
  });

  it("bazaarlink keeps text-output rows with their metadata", () => {
    const body = {
      data: [
        {
          id: "qwen3.8-max",
          name: "Qwen3.8 Max",
          context_length: 1000000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        },
        { id: "img-only", architecture: { output_modalities: ["image"] } },
      ],
    };
    expect(parseBazaarlinkModels(body)).toEqual([
      {
        id: "qwen3.8-max",
        name: "Qwen3.8 Max",
        contextLength: 1000000,
        description: undefined,
        inputModalities: ["text", "image"],
      },
    ]);
  });

  it("llm7 keeps chat rows only", () => {
    const body = {
      data: [
        { id: "DeepSeek-V4-Flash", model_type: "chat", context_window: { tokens: 400000 } },
        { id: "whisper-large-v3", model_type: "audio_to_text" },
        { id: "gpt-image-2", model_type: "image" },
        { id: "jev-latest", model_type: "systemone" },
      ],
    };
    expect(parseLlm7Models(body)).toEqual([
      { id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash", contextLength: 400000 },
    ]);
  });

  it("sambanova keeps registry names and limits", () => {
    const body = {
      data: [
        { id: "MiniMax-M2.7", context_length: 196608, max_completion_tokens: 8192 },
        { id: "gpt-oss-120b" },
      ],
    };
    expect(parseSambanovaModels(body)).toEqual([
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextLength: 196608, maxOutputTokens: 8192 },
      {
        id: "gpt-oss-120b",
        name: "gpt-oss-120b",
        contextLength: undefined,
        maxOutputTokens: undefined,
      },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("llm7 honours a custom base URL and lists live ids in /v1/models", async () => {
    respond = () => Response.json({ data: [{ id: "acme-chat", model_type: "chat" }] });
    const conn = await connect("llm7", "l7-test", { baseUrl: "https://llm7.example.test/v1/" });

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["acme-chat"]);
    expect(calls[0]).toEqual({
      url: "https://llm7.example.test/v1/models",
      auth: "Bearer l7-test",
    });
    const alias = getProviderAlias("llm7");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/acme-chat`);
  });

  it.each([
    ["venice", "https://api.venice.ai/api/v1/models?type=all"],
    ["bazaarlink", "https://bazaarlink.ai/api/v1/models"],
    ["llm7", "https://api.llm7.io/v1/models"],
    ["sambanova", "https://api.sambanova.ai/v1/models"],
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
