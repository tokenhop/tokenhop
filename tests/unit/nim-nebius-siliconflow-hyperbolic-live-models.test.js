// Live NVIDIA NIM, Nebius, SiliconFlow and Hyperbolic (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseHyperbolicModels,
  parseNebiusModels,
  parseNvidiaModels,
} from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["nvidia", "nebius", "siliconflow", "hyperbolic"];
const HOSTS = [
  "https://integrate.api.nvidia.com/",
  "https://api.studio.nebius.ai/",
  "https://api.siliconflow.com/",
  "https://api.hyperbolic.xyz/",
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

const connect = (provider, apiKey) =>
  createProviderConnection({ provider, authType: "apikey", apiKey, testStatus: "active" });

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

describe("parsers", () => {
  it("nvidia classifies by id, drops unrouted models and keeps static speech rows", () => {
    const body = {
      data: [
        { id: "moonshotai/kimi-k2.6" },
        { id: "acme/new-chat" },
        { id: "acme/sparse-eclipse-chat" },
        { id: "nvidia/nv-embedqa-e5-v5" },
        { id: "nvidia/llama-3.1-nemoguard-8b-content-safety" },
        { id: "nvidia/nemotron-4-340b-reward" },
        { id: "nvidia/nemotron-parse" },
      ],
    };
    const models = parseNvidiaModels(body);
    expect(models.slice(0, 4)).toEqual([
      { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
      { id: "acme/new-chat", name: "acme/new-chat" },
      { id: "acme/sparse-eclipse-chat", name: "acme/sparse-eclipse-chat" },
      { id: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA E5 v5", kind: "embedding" },
    ]);
    expect(models.map((m) => m.kind)).toEqual(expect.arrayContaining(["tts", "stt"]));
    expect(models.some((m) => /nemoguard|-reward|-parse/.test(m.id))).toBe(false);
    expect(parseNvidiaModels({ data: [] })).toEqual([]);
  });

  it("nebius keeps chat and embeddings, drops image and guard models", () => {
    const body = {
      data: [
        { id: "meta-llama/Llama-3.3-70B-Instruct" },
        { id: "Qwen/Qwen3-Embedding-8B" },
        { id: "black-forest-labs/flux-dev" },
        { id: "meta-llama/Llama-Guard-3-8B" },
      ],
    };
    expect(parseNebiusModels(body)).toEqual([
      { id: "meta-llama/Llama-3.3-70B-Instruct", name: "meta-llama/Llama-3.3-70B-Instruct" },
      { id: "Qwen/Qwen3-Embedding-8B", name: "Qwen/Qwen3-Embedding-8B", kind: "embedding" },
    ]);
  });

  it("hyperbolic drops non-chat rows and maps limits", () => {
    const body = {
      data: [
        {
          id: "Qwen/Qwen2.5-VL-72B",
          supports_chat: true,
          supports_image_input: true,
          context_length: 32768,
        },
        { id: "SDXL1.0-base", supports_chat: false },
        { id: "deepseek-ai/DeepSeek-V3" },
      ],
    };
    expect(parseHyperbolicModels(body)).toEqual([
      {
        id: "Qwen/Qwen2.5-VL-72B",
        name: "Qwen/Qwen2.5-VL-72B",
        contextLength: 32768,
        inputModalities: ["text", "image"],
      },
      { id: "deepseek-ai/DeepSeek-V3", name: "deepseek-ai/DeepSeek-V3", contextLength: undefined },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("siliconflow asks for chat models and lists them in /v1/models", async () => {
    respond = () => Response.json({ object: "list", data: [{ id: "acme/Chat-9" }] });
    const conn = await connect("siliconflow", "sf-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["acme/Chat-9"]);
    expect(calls[0]).toEqual({
      url: "https://api.siliconflow.com/v1/models?sub_type=chat",
      auth: "Bearer sf-test",
    });

    const alias = getProviderAlias("siliconflow");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/acme/Chat-9`);
  });

  it.each([
    ["nvidia", "https://integrate.api.nvidia.com/v1/models"],
    ["nebius", "https://api.studio.nebius.ai/v1/models"],
    ["siliconflow", "https://api.siliconflow.com/v1/models?sub_type=chat"],
    ["hyperbolic", "https://api.hyperbolic.xyz/v1/models"],
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
