// Live Together AI, Fireworks AI and Cerebras (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseCerebrasModels,
  parseFireworksModels,
  parseTogetherModels,
} from "@/lib/providerModels/apiKeyModels.js";

const HOSTS = [
  "https://api.together.xyz/",
  "https://api.fireworks.ai/",
  "https://api.cerebras.ai/",
];
let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of ["together", "fireworks", "cerebras"])
    await deleteProviderConnectionsByProvider(p);
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

const paid = { input: 1, output: 2 };

describe("parsers", () => {
  it("together maps type to kind and drops unroutable and dedicated-only models", () => {
    const body = [
      { id: "zai/GLM", type: "chat", display_name: "GLM", context_length: 131072, pricing: paid },
      { id: "base", type: "language", pricing: paid },
      { id: "BAAI/bge", type: "embedding", pricing: paid },
      { id: "flux", type: "image", pricing: paid },
      { id: "rr", type: "rerank", pricing: paid },
      { id: "guard", type: "moderation", pricing: paid },
      { id: "dedicated", type: "chat", pricing: { input: 0, output: 0 } },
      { id: "meta/Llama-Turbo-Free", type: "chat", pricing: { input: 0, output: 0 } },
    ];
    expect(parseTogetherModels(body).map((m) => [m.id, m.name, m.kind, m.contextLength])).toEqual([
      ["zai/GLM", "GLM", undefined, 131072],
      ["base", "base", undefined, undefined],
      ["BAAI/bge", "BAAI/bge", "embedding", undefined],
      ["meta/Llama-Turbo-Free", "meta/Llama-Turbo-Free", undefined, undefined],
    ]);
  });

  it("fireworks trusts kind over supports_chat and drops rerankers and image models", () => {
    const body = {
      data: [
        {
          id: "accounts/fireworks/models/gpt-oss-120b",
          kind: "HF_BASE_MODEL",
          supports_chat: true,
          context_length: 131072,
        },
        {
          id: "accounts/fireworks/models/qwen3-embedding-8b",
          kind: "EMBEDDING_MODEL",
          supports_chat: true,
        },
        {
          id: "accounts/fireworks/models/qwen3-reranker-8b",
          kind: "EMBEDDING_MODEL",
          supports_chat: true,
        },
        {
          id: "accounts/fireworks/models/flux-1",
          kind: "FLUMINA_BASE_MODEL",
          supports_chat: false,
        },
        { id: "accounts/fireworks/models/base-only", kind: "HF_BASE_MODEL", supports_chat: false },
      ],
    };
    expect(parseFireworksModels(body).map((m) => [m.name, m.kind, m.contextLength])).toEqual([
      ["gpt-oss-120b", undefined, 131072],
      ["qwen3-embedding-8b", "embedding", undefined],
    ]);
  });

  it("cerebras keeps registry names for known ids", () => {
    const statics = [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }];
    expect(
      parseCerebrasModels({ data: [{ id: "gpt-oss-120b" }, { id: "new-1" }] }, statics),
    ).toEqual([
      { id: "gpt-oss-120b", name: "GPT OSS 120B" },
      { id: "new-1", name: "new-1" },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("together lists live models on the dashboard and in /v1/models", async () => {
    respond = () =>
      Response.json([
        { id: "zai/GLM-9", type: "chat", context_length: 131072, pricing: paid },
        { id: "BAAI/bge-9", type: "embedding", pricing: paid },
      ]);
    const conn = await connect("together", "tg-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: "https://api.together.xyz/v1/models",
      auth: "Bearer tg-test",
    });

    const alias = getProviderAlias("together");
    const glm = (await buildModelsList(["llm"])).find((m) => m.id === `${alias}/zai/GLM-9`);
    expect(glm).toMatchObject({ context_length: 131072 });
    expect((await buildModelsList(["embedding"])).map((m) => m.id)).toContain(
      `${alias}/BAAI/bge-9`,
    );
  });

  it.each([
    ["fireworks", "https://api.fireworks.ai/inference/v1/models"],
    ["cerebras", "https://api.cerebras.ai/v1/models"],
  ])("%s warns (static fallback) when the key is rejected", async (provider, url) => {
    respond = () => new Response("bad key", { status: 401 });
    const conn = await connect(provider);

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
  });
});
