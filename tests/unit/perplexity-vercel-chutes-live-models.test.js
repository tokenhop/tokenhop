// Live Perplexity Agent, Vercel AI Gateway and Chutes (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseChutesModels,
  parsePerplexityAgentModels,
  parseVercelModels,
} from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["perplexity-agent", "vercel-ai-gateway", "chutes"];
const HOSTS = [
  "https://api.perplexity.ai/",
  "https://ai-gateway.vercel.sh/",
  "https://llm.chutes.ai/",
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

async function dashboardModels(id) {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

const connect = (provider, apiKey = "k") =>
  createProviderConnection({ provider, authType: "apikey", apiKey, testStatus: "active" });

describe("parsers", () => {
  it("perplexity agent keeps registry names for known ids", () => {
    const statics = [{ id: "openai/gpt-5.5", name: "GPT-5.5" }];
    const body = { data: [{ id: "openai/gpt-5.5" }, { id: "xai/grok-9" }, { id: "xai/grok-9" }] };
    expect(parsePerplexityAgentModels(body, statics)).toEqual([
      { id: "openai/gpt-5.5", name: "GPT-5.5" },
      { id: "xai/grok-9", name: "xai/grok-9" },
    ]);
  });

  it("vercel maps type to kind and drops unroutable kinds", () => {
    const body = {
      data: [
        {
          id: "alibaba/qwen",
          type: "language",
          name: "Qwen",
          context_window: 40960,
          max_tokens: 16384,
          modalities: { input: ["text", "image"] },
        },
        { id: "alibaba/qwen3-embedding", type: "embedding" },
        { id: "bfl/flux", type: "image", context_window: 0 },
        { id: "bytedance/seedance", type: "video" },
        { id: "cohere/rerank", type: "reranking" },
        { id: "openai/whisper", type: "transcription" },
      ],
    };
    expect(
      parseVercelModels(body).map((m) => [
        m.id,
        m.name,
        m.kind,
        m.contextLength,
        m.maxOutputTokens,
      ]),
    ).toEqual([
      ["alibaba/qwen", "Qwen", undefined, 40960, 16384],
      ["alibaba/qwen3-embedding", "alibaba/qwen3-embedding", "embedding", undefined, undefined],
      ["bfl/flux", "bfl/flux", "image", undefined, undefined],
    ]);
  });

  it("chutes keeps text-output chutes with their limits", () => {
    const body = {
      data: [
        {
          id: "Qwen/Qwen3-TEE",
          context_length: 262144,
          max_output_length: 65536,
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
        { id: "img/model", output_modalities: ["image"] },
        { id: "Nemotron-TEE" },
      ],
    };
    expect(parseChutesModels(body)).toEqual([
      {
        id: "Qwen/Qwen3-TEE",
        name: "Qwen/Qwen3-TEE",
        contextLength: 262144,
        maxOutputTokens: 65536,
        inputModalities: ["text", "image"],
      },
      {
        id: "Nemotron-TEE",
        name: "Nemotron-TEE",
        contextLength: undefined,
        maxOutputTokens: undefined,
      },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("vercel lists live models on the dashboard and in /v1/models", async () => {
    respond = () =>
      Response.json({
        data: [
          { id: "acme/chat-9", type: "language", context_window: 131072 },
          { id: "acme/embed-9", type: "embedding" },
        ],
      });
    const conn = await connect("vercel-ai-gateway", "vg-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["acme/chat-9", "acme/embed-9"]);
    expect(calls[0]).toMatchObject({
      url: "https://ai-gateway.vercel.sh/v1/models",
      auth: "Bearer vg-test",
    });

    const alias = getProviderAlias("vercel-ai-gateway");
    const chat = (await buildModelsList(["llm"])).find((m) => m.id === `${alias}/acme/chat-9`);
    expect(chat).toMatchObject({ context_length: 131072 });
    expect((await buildModelsList(["embedding"])).map((m) => m.id)).toContain(
      `${alias}/acme/embed-9`,
    );
  });

  it.each([
    ["perplexity-agent", "https://api.perplexity.ai/v1/models"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/models"],
    ["chutes", "https://llm.chutes.ai/v1/models"],
  ])("%s warns when the key is rejected", async (provider, url) => {
    respond = () => new Response("bad key sk-secret", { status: 401 });
    const conn = await connect(provider, "sk-secret");

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("sk-secret");
  });
});
