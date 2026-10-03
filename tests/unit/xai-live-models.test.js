// Live xAI catalog (API key + OAuth) seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tokenMocks = vi.hoisted(() => ({
  refreshTokenByProvider: vi.fn(),
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
import { parseXaiModels, reconcileXaiAliases } from "@/lib/providerModels/xaiModels.js";

let calls;
let respond;
beforeEach(async () => {
  calls = [];
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  tokenMocks.refreshTokenByProvider.mockReset();
  tokenMocks.updateProviderCredentials.mockClear();
  await deleteProviderConnectionsByProviderUnscoped("xai");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!String(url).startsWith("https://api.x.ai/")) return nativeFetch(url, init);
    const call = { url: String(url), auth: init.headers?.Authorization };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

const lists = {
  "language-models": { models: [{ id: "grok-4.6-0901", aliases: ["grok-4.6"] }, { id: "grok-9" }] },
  "image-generation-models": { models: [{ id: "grok-imagine-image" }] },
  "video-generation-models": { models: [{ id: "grok-imagine-video" }] },
};
const serve = ({ url }) => Response.json(lists[url.split("/v1/")[1]]);

async function dashboardModels(id) {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

describe("xai parsing", () => {
  it("tags kinds and keeps the static id when it is a live alias", () => {
    const live = [
      ...parseXaiModels(lists["language-models"]),
      ...parseXaiModels({ models: [{ id: "img-0901", aliases: ["img"] }] }, "image"),
    ];
    const statics = [{ id: "grok-4.6" }, { id: "img", kind: "image" }];
    expect(reconcileXaiAliases(live, statics)).toEqual([
      { id: "grok-4.6", name: "grok-4.6" },
      { id: "grok-9", name: "grok-9" },
      { id: "img", name: "img", kind: "image" },
    ]);
  });
});

describe("xai live catalog", () => {
  it("lists language, image and video models for an API key", async () => {
    respond = serve;
    const conn = await createProviderConnectionUnscoped({
      provider: "xai",
      authType: "apikey",
      apiKey: "xai-key",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);

    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => [m.id, m.kind])).toEqual([
      ["grok-4.6", undefined],
      ["grok-9", undefined],
      ["grok-imagine-image", "image"],
      ["grok-imagine-video", "video"],
    ]);
    expect(calls.every((c) => c.auth === "Bearer xai-key")).toBe(true);

    const alias = getProviderAlias("xai");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/grok-9`);
  });

  it("keeps static media entries when a media list fails", async () => {
    respond = (call) =>
      call.url.endsWith("video-generation-models")
        ? new Response("no", { status: 404 })
        : serve(call);
    const conn = await createProviderConnectionUnscoped({
      provider: "xai",
      authType: "apikey",
      apiKey: "xai-key",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);

    expect(body.models.find((m) => m.id === "grok-imagine-video")?.kind).toBe("video");
  });

  it("refreshes an OAuth token on 401 and reuses it for every list", async () => {
    tokenMocks.refreshTokenByProvider.mockResolvedValue({ accessToken: "fresh" });
    respond = (call) =>
      call.auth === "Bearer stale" ? new Response("", { status: 401 }) : serve(call);
    const conn = await createProviderConnectionUnscoped({
      provider: "xai",
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "r",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);

    expect(body.models.map((m) => m.id)).toContain("grok-9");
    expect(tokenMocks.updateProviderCredentials).toHaveBeenCalled();
    expect(calls.slice(1).every((c) => c.auth === "Bearer fresh")).toBe(true);
  });
});
