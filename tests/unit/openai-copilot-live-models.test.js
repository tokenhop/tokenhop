// Live OpenAI (API key) and GitHub Copilot catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const stub = vi.hoisted(() => ({ calls: [], respond: null }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, init = {}) => {
    stub.calls.push({ url: String(url), auth: init.headers?.Authorization });
    return stub.respond({ url: String(url), auth: init.headers?.Authorization });
  },
}));
const copilot = vi.hoisted(() => ({ refreshCopilotToken: vi.fn() }));
vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...copilot,
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { createProviderConnection, deleteProviderConnectionsByProvider } from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { clearCopilotModelCache } from "open-sse/services/copilotModels.js";
import { classifyOpenAIModel, parseOpenAIModels } from "@/lib/providerModels/openaiModels.js";

beforeEach(async () => {
  stub.calls = [];
  stub.respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  clearCopilotModelCache();
  copilot.refreshCopilotToken.mockReset();
  await deleteProviderConnectionsByProvider("openai");
  await deleteProviderConnectionsByProvider("github");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!String(url).startsWith("https://api.openai.com/")) return nativeFetch(url, init);
    stub.calls.push({ url: String(url), auth: init.headers?.Authorization });
    return stub.respond({ url: String(url) });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function dashboardModels(id) {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

describe("openai classifier", () => {
  it.each([
    ["gpt-6", "llm"],
    ["ft:gpt-4o-mini-2024-07-18:acme:x:abc", "llm"],
    ["text-embedding-4", "embedding"],
    ["gpt-5-tts", "tts"],
    ["gpt-5-transcribe", "stt"],
    ["whisper-2", "stt"],
    ["gpt-image-3", "image"],
    ["omni-moderation-latest", null],
    ["gpt-realtime", null],
    ["gpt-3.5-turbo-instruct", null],
    ["sora-2", null],
  ])("%s -> %s", (id, kind) => expect(classifyOpenAIModel(id)).toBe(kind));

  it("prefers the static registry kind and drops unservable ids", () => {
    const body = { data: [{ id: "x-voice" }, { id: "gpt-6" }, { id: "gpt-realtime" }] };
    expect(parseOpenAIModels(body, [{ id: "x-voice", kind: "tts" }])).toEqual([
      { id: "x-voice", name: "x-voice", kind: "tts" },
      { id: "gpt-6", name: "gpt-6" },
    ]);
  });
});

describe("openai live catalog", () => {
  it("lists live models on the dashboard and in /v1/models", async () => {
    stub.respond = () =>
      Response.json({
        data: [{ id: "gpt-6" }, { id: "text-embedding-4" }, { id: "gpt-realtime" }],
      });
    const conn = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-test",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => [m.id, m.kind])).toEqual([
      ["gpt-6", undefined],
      ["text-embedding-4", "embedding"],
    ]);
    expect(stub.calls[0].auth).toBe("Bearer sk-test");

    const alias = getProviderAlias("openai");
    const llm = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(llm).toContain(`${alias}/gpt-6`);
    expect(llm).not.toContain(`${alias}/text-embedding-4`);
  });

  it("returns a warning (static fallback) when the key is rejected", async () => {
    stub.respond = () => new Response("bad key", { status: 401 });
    const conn = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-bad",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
  });
});

describe("github copilot live catalog", () => {
  const catalog = {
    data: [
      {
        id: "gpt-9",
        name: "GPT-9",
        policy: { state: "enabled" },
        capabilities: {
          type: "chat",
          limits: {
            max_prompt_tokens: 128000,
            max_context_window_tokens: 200000,
            max_output_tokens: 64000,
          },
        },
      },
      { id: "off", policy: { state: "disabled" }, capabilities: { type: "chat" } },
      { id: "text-embedding-3-small", capabilities: { type: "embeddings" } },
    ],
  };

  it("refreshes a stale token, maps limits and keeps static embeddings", async () => {
    copilot.refreshCopilotToken.mockResolvedValue({ token: "fresh", expiresAt: 1 });
    stub.respond = ({ auth }) =>
      auth === "Bearer stale" ? new Response("", { status: 401 }) : Response.json(catalog);
    const conn = await createProviderConnection({
      provider: "github",
      authType: "oauth",
      accessToken: "gh",
      providerSpecificData: { copilotToken: "stale" },
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(copilot.refreshCopilotToken).toHaveBeenCalledWith("gh");
    expect(body.models[0]).toMatchObject({
      id: "gpt-9",
      contextLength: 128000,
      maxOutputTokens: 64000,
    });
    expect(body.models.map((m) => m.id)).not.toContain("off");
    expect(body.models.find((m) => m.id === "text-embedding-3-small")?.kind).toBe("embedding");

    const alias = getProviderAlias("github");
    const embeddings = (await buildModelsList(["embedding"])).map((m) => m.id);
    expect(embeddings).toContain(`${alias}/text-embedding-3-small`);
    const gpt9 = (await buildModelsList(["llm"])).find((m) => m.id === `${alias}/gpt-9`);
    expect(gpt9).toMatchObject({ context_length: 128000, max_completion_tokens: 64000 });
  });

  it("warns and keeps the static list when the catalog fails", async () => {
    stub.respond = () => new Response("down", { status: 500 });
    const conn = await createProviderConnection({
      provider: "github",
      authType: "oauth",
      accessToken: "gh",
      providerSpecificData: { copilotToken: "t" },
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toBeTruthy();
  });
});
