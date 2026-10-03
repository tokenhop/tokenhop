// Live OpenCode Free catalog (YAN-190): opencode is noAuth with no connection
// row, so the dashboard route and /v1/models fall back to a synthetic one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseOpencodeFreeModels } from "@/lib/providerModels/apiKeyModels.js";
import { OPENCODE_PUBLIC_HEADERS } from "../../open-sse/executors/opencode.js";

const URL_ = "https://opencode.ai/zen/v1/models";
let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  clearLiveModelsCache();
  await deleteProviderConnectionsByProviderUnscoped("opencode");
  await deleteProviderConnectionsByProviderUnscoped("cohere");
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (String(url) !== URL_) return nativeFetch(url, init);
    calls.push(init.headers);
    return respond();
  });
});

afterEach(() => vi.unstubAllGlobals());

const dashboardModels = async (id = "opencode", query = "") => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models${query}`), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
};

// cohere has no live resolver, so it forces the non-empty /v1/models branch
// without adding a fetch of its own.
const connectUnrelated = () =>
  createProviderConnectionUnscoped({
    provider: "cohere",
    authType: "apikey",
    apiKey: "sk-co",
    testStatus: "active",
  });

describe("OpenCode Free live catalog", () => {
  it("serves the filtered free list on the dashboard without a connection row", async () => {
    respond = () =>
      Response.json({
        data: [{ id: "space-bunny-free" }, { id: "gpt-5" }, { id: "jev-1.13-free" }],
      });

    const { status, body } = await dashboardModels();
    expect(status).toBe(200);
    expect(body.warning).toBeUndefined();
    expect(body.models).toEqual([{ id: "space-bunny-free", name: "space-bunny-free" }]);
    expect(body.connectionId).toBe("noauth");
    expect(calls[0]?.Authorization).toBe("Bearer public");
    expect(calls[0]?.["User-Agent"]).toBe(OPENCODE_PUBLIC_HEADERS["User-Agent"]);
  });

  it("lists oc/* free ids in /v1/models when only another provider is connected", async () => {
    respond = () =>
      Response.json({
        data: [{ id: "space-bunny-free" }, { id: "gpt-5" }, { id: "jev-1.13-free" }],
      });
    await connectUnrelated();

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(ids).toContain("oc/space-bunny-free");
    expect(ids).not.toContain("oc/gpt-5");
  });

  it("falls back to the static list on failure, holds it briefly, and refresh retries", async () => {
    respond = () => new Response("overloaded", { status: 503 });

    const { body } = await dashboardModels();
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/503/);

    await connectUnrelated();
    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(ids).toContain("oc/union-alpha");
    // The outage is held: /v1/models didn't refetch.
    expect(calls).toHaveLength(1);

    respond = () => Response.json({ data: [{ id: "space-bunny-free" }] });
    const retry = await dashboardModels("opencode", "?refresh=1");
    expect(retry.body.models).toEqual([{ id: "space-bunny-free", name: "space-bunny-free" }]);
  });

  it("still 404s for an unknown provider id", async () => {
    respond = () => Response.json({ data: [] });
    const { status } = await dashboardModels("nope");
    expect(status).toBe(404);
  });
});

describe("parseOpencodeFreeModels", () => {
  it("keeps -free ids and big-pickle, drops paid and dead ids", () => {
    const models = parseOpencodeFreeModels({
      data: [
        { id: "space-bunny-free" },
        { id: "big-pickle" },
        { id: "gpt-5" },
        { id: "deepseek-v4-flash-free" },
        { id: "jev-1.13-free" },
      ],
    });
    expect(models).toEqual([
      { id: "space-bunny-free", name: "space-bunny-free" },
      { id: "big-pickle", name: "big-pickle" },
    ]);
  });

  it("tolerates a bare array body", () => {
    expect(parseOpencodeFreeModels([{ id: "mimo-v2.5-free" }, { id: "gpt-5" }])).toEqual([
      { id: "mimo-v2.5-free", name: "mimo-v2.5-free" },
    ]);
  });
});
