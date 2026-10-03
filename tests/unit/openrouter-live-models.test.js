// Live OpenRouter catalog seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseOpenRouterModels } from "@/lib/providerModels/openrouterModels.js";
import { mergeLiveWithStatic } from "@/shared/utils/liveModels";

const catalog = {
  data: [
    {
      id: "acme/chat-9:free",
      name: "Acme: Chat 9 (free)",
      context_length: 262144,
      top_provider: { max_completion_tokens: 32768 },
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    },
    {
      id: "acme/painter",
      name: "Acme: Painter",
      context_length: 0,
      pricing: { prompt: "0.000001", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] },
    },
    {
      id: "acme/rerank",
      pricing: {},
      architecture: { input_modalities: ["text"], output_modalities: ["rerank"] },
    },
  ],
};

let calls;
let respond;
beforeEach(async () => {
  calls = [];
  respond = () => Response.json(catalog);
  clearLiveModelsCache();
  await deleteProviderConnectionsByProviderUnscoped("openrouter");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!String(url).startsWith("https://openrouter.ai/")) return nativeFetch(url, init);
    const call = { url: String(url), auth: init.headers?.Authorization };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

const connect = () =>
  createProviderConnectionUnscoped({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "or-key",
    testStatus: "active",
  });

async function dashboardModels(id) {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

describe("openrouter parsing", () => {
  it("maps output modalities to kinds, limits and the free flag", () => {
    expect(parseOpenRouterModels(catalog)).toEqual([
      {
        id: "acme/chat-9:free",
        name: "Acme: Chat 9 (free)",
        contextLength: 262144,
        maxOutputTokens: 32768,
        isFree: true,
        inputModalities: ["text", "image"],
      },
      {
        id: "acme/painter",
        name: "Acme: Painter",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: false,
        inputModalities: ["text"],
        kind: "image",
      },
      {
        id: "acme/painter",
        name: "Acme: Painter",
        contextLength: undefined,
        maxOutputTokens: undefined,
        isFree: false,
        inputModalities: ["text"],
      },
    ]);
  });
});

it("keeps an image+text model under both kinds on the dashboard", () => {
  const merged = mergeLiveWithStatic("openrouter", parseOpenRouterModels(catalog), []);
  expect(merged.filter((m) => m.id === "acme/painter").map((m) => m.kind)).toEqual([
    "image",
    undefined,
  ]);
});

describe("openrouter live catalog", () => {
  it("uses the key-filtered list and feeds /v1/models", async () => {
    const conn = await connect();

    const body = await dashboardModels(conn.id);

    expect(body.warning).toBeUndefined();
    expect(calls).toEqual([
      {
        url: "https://openrouter.ai/api/v1/models/user?output_modalities=all",
        auth: "Bearer or-key",
      },
    ]);
    expect(body.models.map((m) => m.id)).toContain("acme/chat-9:free");
    // Static media entries the live list lacks stay listed.
    expect(body.models.some((m) => m.id === "openai/tts-1" && m.kind === "tts")).toBe(true);

    const alias = getProviderAlias("openrouter");
    const llm = await buildModelsList(["llm"]);
    expect(llm.find((m) => m.id === `${alias}/acme/chat-9:free`)).toMatchObject({
      context_length: 262144,
      max_completion_tokens: 32768,
    });
  });

  it("falls back to the public list when the key can't use /models/user", async () => {
    respond = (call) =>
      call.url.includes("/models/user")
        ? new Response("no", { status: 401 })
        : Response.json(catalog);
    const conn = await connect();

    const body = await dashboardModels(conn.id);

    expect(body.warning).toBeUndefined();
    expect(calls[1]).toEqual({
      url: "https://openrouter.ai/api/v1/models?output_modalities=all",
      auth: undefined,
    });
    expect(body.models.map((m) => m.id)).toContain("acme/chat-9:free");
  });

  it("does not fall back when /models/user succeeds empty", async () => {
    respond = (call) =>
      call.url.includes("/models/user") ? Response.json({ data: [] }) : Response.json(catalog);
    const conn = await connect();

    const body = await dashboardModels(conn.id);

    expect(calls).toHaveLength(1);
    expect(body.models).toEqual([]);
    expect(body.warning).toBe("OpenRouter returned no live models.");
  });

  it("returns a warning and no models when both lists fail", async () => {
    respond = () => new Response("down", { status: 503 });
    const conn = await connect();

    const body = await dashboardModels(conn.id);

    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/Failed to fetch OpenRouter models: 503/);
  });
});
