// Live Alibaba Coding (CN) and Alibaba Coding Intl (API key) catalogs seen by
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
import { parseAlicodeModels } from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["alicode", "alicode-intl"];
const HOSTS = [
  "https://coding.dashscope.aliyuncs.com/",
  "https://coding-intl.dashscope.aliyuncs.com/",
];

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
  it("alicode keeps registry names and falls back to id-as-name", () => {
    const body = {
      data: [{ id: "qwen3.5-plus" }, { id: "brand-new-model" }],
    };
    expect(parseAlicodeModels(body)).toEqual([
      { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
      { id: "brand-new-model", name: "brand-new-model" },
    ]);
  });

  it("alicode dedupes ids across both regional catalogs", () => {
    const body = { data: [{ id: "qwen3.5-plus" }, { id: "qwen3.5-plus" }, { id: "" }] };
    expect(parseAlicodeModels(body)).toEqual([{ id: "qwen3.5-plus", name: "Qwen3.5 Plus" }]);
  });
});

describe("live catalogs end to end", () => {
  it("alicode lists from the coding host into /v1/models", async () => {
    respond = () => Response.json({ data: [{ id: "qwen3.5-plus" }, { id: "acme-new" }] });
    const conn = await connect("alicode", "ac-test");

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["qwen3.5-plus", "acme-new"]);
    expect(calls[0]).toEqual({
      url: "https://coding.dashscope.aliyuncs.com/v1/models",
      auth: "Bearer ac-test",
    });
    const alias = getProviderAlias("alicode");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/acme-new`);
  });

  it.each([
    ["alicode", "https://coding.dashscope.aliyuncs.com/v1/models"],
    ["alicode-intl", "https://coding-intl.dashscope.aliyuncs.com/v1/models"],
  ])("%s failure keeps the static list with a warning", async (provider, url) => {
    respond = () => new Response("bad key ac-secret", { status: 401 });
    const conn = await connect(provider, "ac-secret");

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe(url);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("ac-secret");
  });
});
