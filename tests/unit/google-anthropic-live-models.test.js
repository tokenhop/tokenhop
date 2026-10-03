// Live model catalogs for anthropic (API key), gemini (AI Studio key), gemini-cli and
// antigravity (Cloud Code OAuth), seen by the dashboard and by /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tokenMocks = vi.hoisted(() => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(async () => true),
}));
vi.mock("@/sse/services/tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal()),
  ...tokenMocks,
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
  parseGeminiModels,
  reconcileAntigravityModels,
} from "@/lib/providerModels/googleModels.js";

const UPSTREAMS = [
  "https://api.anthropic.com/",
  "https://generativelanguage.googleapis.com/",
  "https://cloudcode-pa.googleapis.com/",
  "https://daily-cloudcode-pa.googleapis.com/",
];

let calls;
let respond;
beforeEach(async () => {
  calls = [];
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  tokenMocks.refreshGoogleToken.mockReset();
  tokenMocks.updateProviderCredentials.mockClear();
  for (const p of ["anthropic", "gemini", "gemini-cli", "antigravity"]) {
    await deleteProviderConnectionsByProviderUnscoped(p);
  }
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!UPSTREAMS.some((u) => String(url).startsWith(u))) return nativeFetch(url, init);
    const call = { url: String(url), headers: init.headers || {}, body: init.body };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const seed = (provider, extra = {}) =>
  createProviderConnectionUnscoped({ provider, testStatus: "active", ...extra });

async function dashboardModels(connectionId) {
  const res = await GET(new Request(`http://localhost/api/providers/${connectionId}/models`), {
    params: Promise.resolve({ id: connectionId }),
  });
  return res.json();
}

describe("anthropic", () => {
  it("pages through every model with x-api-key", async () => {
    respond = ({ url }) =>
      url.includes("after_id=")
        ? Response.json({ data: [{ id: "claude-b" }], has_more: false })
        : Response.json({
            data: [{ id: "claude-a", display_name: "A" }],
            has_more: true,
            last_id: "claude-a",
          });
    const conn = await seed("anthropic", { authType: "apikey", apiKey: "sk-ant-key" });

    const body = await dashboardModels(conn.id);

    expect(body.models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(calls[0].url).toContain("limit=1000");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-key");
  });
});

describe("gemini", () => {
  it("strips models/, maps kinds and limits, drops unroutable entries", () => {
    const models = parseGeminiModels({
      models: [
        {
          name: "models/gemini-9-pro",
          displayName: "Gemini 9 Pro",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        { name: "models/gemini-embedding-9", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-9", supportedGenerationMethods: ["predict"] },
        { name: "models/veo-9", supportedGenerationMethods: ["predictLongRunning"] },
        { name: "models/gemini-9-flash-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-9-live", supportedGenerationMethods: ["bidiGenerateContent"] },
      ],
    });
    expect(models).toEqual([
      {
        id: "gemini-9-pro",
        name: "Gemini 9 Pro",
        contextLength: 1048576,
        maxOutputTokens: 65536,
      },
      { id: "gemini-embedding-9", name: "gemini-embedding-9", kind: "embedding" },
      { id: "imagen-9", name: "imagen-9", kind: "image" },
      { id: "veo-9", name: "veo-9", kind: "video" },
      { id: "gemini-9-flash-tts", name: "gemini-9-flash-tts", kind: "tts" },
    ]);
  });

  it("authenticates by header, follows nextPageToken and lists live ids in /v1/models", async () => {
    const page = (name, next) =>
      Response.json({
        models: [{ name: `models/${name}`, supportedGenerationMethods: ["generateContent"] }],
        ...(next ? { nextPageToken: next } : {}),
      });
    respond = ({ url }) =>
      url.includes("pageToken=p2") ? page("gemini-2.5-pro") : page("gemini-live-9", "p2");
    await seed("gemini", { authType: "apikey", apiKey: "AIza-key" });

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    const alias = getProviderAlias("gemini");
    expect(ids).toContain(`${alias}/gemini-live-9`);
    // Static STT twin of a live chat id must not push it out of the chat list.
    expect(ids).toContain(`${alias}/gemini-2.5-pro`);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !c.url.includes("key="))).toBe(true);
    expect(calls[0].headers["x-goog-api-key"]).toBe("AIza-key");

    // ...and its static STT twin stays discoverable.
    const sttIds = (await buildModelsList(["stt"])).map((m) => m.id);
    expect(sttIds).toContain(`${alias}/gemini-2.5-pro`);
  });
});

describe("gemini-cli", () => {
  it("sends the project, drops internal models and refreshes on 401", async () => {
    tokenMocks.refreshGoogleToken.mockResolvedValue({ accessToken: "at-new" });
    respond = ({ headers }) =>
      headers.Authorization === "Bearer at-new"
        ? Response.json({
            models: {
              "gemini-9-pro": { displayName: "Gemini 9 Pro", maxTokens: 1048576 },
              "internal-x": { isInternal: true },
            },
          })
        : new Response("expired", { status: 401 });
    const conn = await seed("gemini-cli", {
      authType: "oauth",
      accessToken: "at-old",
      refreshToken: "rt",
      projectId: "proj-1",
    });

    const body = await dashboardModels(conn.id);

    expect(body.models).toEqual([
      { id: "gemini-9-pro", name: "Gemini 9 Pro", contextLength: 1048576 },
    ]);
    expect(JSON.parse(calls[0].body)).toEqual({ project: "proj-1" });
    expect(tokenMocks.updateProviderCredentials).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({ accessToken: "at-new" }),
    );
  });

  it("explains a missing project id when the fetch fails", async () => {
    respond = () => new Response("bad", { status: 400 });
    const conn = await seed("gemini-cli", { authType: "oauth", accessToken: "at" });

    const body = await dashboardModels(conn.id);

    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/reconnect Gemini CLI/);
  });
});

describe("antigravity", () => {
  const STATIC = [
    { id: "gemini-3.8-flash", name: "Flash", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
    {
      id: "gemini-3.8-flash-medium",
      name: "Flash (Medium)",
      upstreamModelId: "gemini-3.8-flash-medium(medium)",
    },
    { id: "claude-sonnet-4-6", name: "Sonnet" },
    { id: "gone-model", name: "Gone" },
    { id: "gemini-3.1-flash-image", name: "Image", kind: "image" },
  ];

  it("keeps static aliases whose wire id is live, adds unknown ids, skips internals", () => {
    const models = reconcileAntigravityModels(
      [
        { id: "gemini-3.8-flash-medium", name: "x", maxOutputTokens: 65536 },
        { id: "claude-sonnet-4-6", name: "x" },
        { id: "gemini-3.1-flash-image", name: "x" },
        { id: "gemini-9-new", name: "Gemini 9" },
        { id: "gemini-9-image", name: "Img 9" },
        { id: "chat_20706", name: "internal" },
      ],
      STATIC,
    );
    expect(models).toEqual([
      { id: "gemini-3.8-flash", name: "Flash", maxOutputTokens: 65536 },
      { id: "gemini-3.8-flash-medium", name: "Flash (Medium)", maxOutputTokens: 65536 },
      { id: "claude-sonnet-4-6", name: "Sonnet" },
      { id: "gemini-3.1-flash-image", name: "Image", kind: "image" },
      { id: "gemini-9-new", name: "Gemini 9" },
      { id: "gemini-9-image", name: "Img 9", kind: "image" },
    ]);
  });

  it("calls fetchAvailableModels with the IDE headers", async () => {
    respond = () => Response.json({ models: { "claude-sonnet-4-6": { displayName: "S" } } });
    const conn = await seed("antigravity", { authType: "oauth", accessToken: "at" });

    const body = await dashboardModels(conn.id);

    expect(calls[0].url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(calls[0].headers["X-Client-Name"]).toBe("antigravity");
    expect(body.models.map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
  });
});
