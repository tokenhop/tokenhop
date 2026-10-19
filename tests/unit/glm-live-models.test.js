// Live GLM Coding (z.ai) and GLM (China, bigmodel.cn) API-key catalogs seen by
// the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseGlmModels } from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["glm", "glm-cn"];
const HOSTS = ["https://api.z.ai/", "https://open.bigmodel.cn/"];

let respond;
const calls = [];

beforeEach(async () => {
  calls.length = 0;
  respond = () => new Response("unexpected", { status: 500 });
  clearLiveModelsCache();
  for (const p of PROVIDERS) await deleteProviderConnectionsByProviderUnscoped(p);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init = {}) => {
    if (!HOSTS.some((h) => String(url).startsWith(h))) return nativeFetch(url, init);
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    return respond(String(url));
  });
});

afterEach(() => vi.unstubAllGlobals());

const connect = (provider, apiKey) =>
  createProviderConnectionUnscoped({
    provider,
    authType: "apikey",
    apiKey,
    testStatus: "active",
  });

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

describe("parsers", () => {
  it("names ids from the provider's own registry, then the other's, then the id", () => {
    const body = { data: [{ id: "glm-4.7" }, { id: "glm-4.5-air" }, { id: "brand-new-model" }] };
    const glm = parseGlmModels(body, "glm");
    expect(glm.slice(0, 3)).toEqual([
      { id: "glm-4.7", name: "GLM 4.7" },
      { id: "glm-4.5-air", name: "GLM-4.5-Air" },
      { id: "brand-new-model", name: "brand-new-model" },
    ]);
    expect(parseGlmModels(body, "glm-cn")[0]).toEqual({ id: "glm-4.7", name: "GLM-4.7" });
  });

  it("dedupes ids and drops empty ones", () => {
    const body = { data: [{ id: "glm-5.3" }, { id: "glm-5.3" }, { id: "" }, {}] };
    const ids = parseGlmModels(body, "glm").map((m) => m.id);
    expect(ids.filter((id) => id === "glm-5.3")).toHaveLength(1);
    expect(ids).not.toContain("");
  });

  it("appends registry models missing from the live list, after live ids", () => {
    const models = parseGlmModels({ data: [{ id: "glm-5.3" }] }, "glm-cn");
    expect(models[0]).toEqual({ id: "glm-5.3", name: "GLM 5.3" });
    expect(models).toContainEqual({ id: "glm-4.6v", name: "GLM 4.6V (Vision)" });
    expect(models.filter((m) => m.id === "glm-5.3")).toHaveLength(1);
  });

  it("returns nothing for an empty live list", () => {
    expect(parseGlmModels({ data: [] }, "glm")).toEqual([]);
    expect(parseGlmModels({}, "glm-cn")).toEqual([]);
  });
});

describe("live catalogs end to end", () => {
  it("glm lists from the z.ai coding host into /v1/models", async () => {
    respond = () => Response.json({ data: [{ id: "glm-5.3" }, { id: "acme-new" }] });
    const conn = await connect("glm", "glm-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["glm-5.3", "acme-new", "glm-4.6v"]),
    );
    expect(calls[0]).toEqual({
      url: "https://api.z.ai/api/coding/paas/v4/models",
      auth: "Bearer glm-test",
    });
    const alias = getProviderAlias("glm");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/acme-new`);
  });

  it("glm-cn lists from the bigmodel host and keeps glm-4.6v unlisted upstream", async () => {
    respond = () => Response.json({ data: [{ id: "glm-5.3" }, { id: "acme-cn" }] });
    const conn = await connect("glm-cn", "cn-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(expect.arrayContaining(["glm-5.3", "acme-cn"]));
    expect(body.models.map((m) => m.id)).toContain("glm-4.6v");
    expect(calls[0]).toEqual({
      url: "https://open.bigmodel.cn/api/coding/paas/v4/models",
      auth: "Bearer cn-test",
    });
  });

  it.each([
    ["glm", "https://api.z.ai/api/coding/paas/v4/models"],
    ["glm-cn", "https://open.bigmodel.cn/api/coding/paas/v4/models"],
  ])("%s failure returns no models with warning", async (provider, url) => {
    respond = () => new Response("bad key glm-secret", { status: 401 });
    const conn = await connect(provider, "glm-secret");

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("glm-secret");
  });
});
