// Live DeepSeek, Mistral and Groq (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import {
  parseDeepSeekModels,
  parseGroqModels,
  parseMistralModels,
} from "@/lib/providerModels/apiKeyModels.js";

const HOSTS = ["https://api.deepseek.com/", "https://api.mistral.ai/", "https://api.groq.com/"];
let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of ["deepseek", "mistral", "groq"])
    await deleteProviderConnectionsByProviderUnscoped(p);
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
  createProviderConnectionUnscoped({ provider, authType: "apikey", apiKey, testStatus: "active" });

describe("parsers", () => {
  it("deepseek keeps static thinking variants while their upstream id is live", () => {
    const statics = [
      { id: "deepseek-v4-pro" },
      { id: "deepseek-v4-pro-max", name: "Max", upstreamModelId: "deepseek-v4-pro" },
      { id: "gone-max", name: "Gone", upstreamModelId: "gone" },
    ];
    expect(parseDeepSeekModels({ data: [{ id: "deepseek-v4-pro" }] }, statics)).toEqual([
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      { id: "deepseek-v4-pro-max", name: "Max", upstreamModelId: "deepseek-v4-pro" },
    ]);
  });

  it("mistral collapses aliases to -latest, drops deprecated and unroutable models", () => {
    const body = {
      data: [
        {
          id: "mistral-large-2512",
          aliases: ["mistral-large-latest"],
          capabilities: { completion_chat: true },
          max_context_length: 256000,
        },
        { id: "mistral-large-latest", aliases: ["mistral-large-2512"], capabilities: {} },
        {
          id: "codestral-latest",
          aliases: ["codestral-2508"],
          capabilities: { completion_chat: true },
        },
        { id: "codestral-2508", aliases: ["codestral-latest"], capabilities: {} },
        {
          id: "open-mistral-nemo",
          aliases: ["mistral-tiny-latest"],
          capabilities: { completion_chat: true },
        },
        {
          id: "mistral-medium-2505",
          deprecation: "2999-01-01T00:00:00Z",
          capabilities: { completion_chat: true },
        },
        {
          id: "mistral-small-2402",
          deprecation: "2025-01-01",
          capabilities: { completion_chat: true },
        },
        { id: "mistral-embed", capabilities: {} },
        { id: "mistral-ocr-latest", capabilities: { ocr: true } },
        { id: "mistral-moderation-latest", capabilities: { moderation: true } },
      ],
    };
    const parsed = parseMistralModels(body);
    expect(parsed.map((m) => [m.id, m.kind])).toEqual([
      ["mistral-large-latest", undefined],
      ["codestral-latest", undefined],
      ["open-mistral-nemo", undefined],
      ["mistral-medium-2505", undefined],
      ["mistral-embed", "embedding"],
    ]);
    expect(parsed[0].contextLength).toBe(256000);
  });

  it("groq drops inactive and TTS models, classifies whisper as stt, maps limits", () => {
    const body = {
      data: [
        { id: "llama-4", context_window: 131072, max_completion_tokens: 8192 },
        { id: "old", active: false },
        { id: "whisper-large-v3", active: true },
        { id: "playai-tts" },
        { id: "canopylabs/orpheus-v1-english" },
        { id: "meta-llama/llama-guard-4-12b" },
      ],
    };
    expect(parseGroqModels(body).map((m) => [m.id, m.kind, m.contextLength])).toEqual([
      ["llama-4", undefined, 131072],
      ["whisper-large-v3", "stt", undefined],
      ["meta-llama/llama-guard-4-12b", undefined, undefined],
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("groq lists live models on the dashboard and in /v1/models with limits", async () => {
    respond = () =>
      Response.json({
        data: [
          { id: "llama-9", context_window: 131072, max_completion_tokens: 32768 },
          { id: "whisper-large-v3" },
        ],
      });
    const conn = await connect("groq", "gsk-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: "https://api.groq.com/openai/v1/models",
      auth: "Bearer gsk-test",
    });

    const alias = getProviderAlias("groq");
    const llama = (await buildModelsList(["llm"])).find((m) => m.id === `${alias}/llama-9`);
    expect(llama).toMatchObject({ context_length: 131072, max_completion_tokens: 32768 });
    const stt = (await buildModelsList(["stt"])).map((m) => m.id);
    expect(stt).toContain(`${alias}/whisper-large-v3`);
  });

  it.each([
    ["deepseek", "https://api.deepseek.com/models"],
    ["mistral", "https://api.mistral.ai/v1/models"],
  ])("%s warns (static fallback) when the key is rejected", async (provider, url) => {
    respond = () => new Response("bad key", { status: 401 });
    const conn = await connect(provider);

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
  });
});
