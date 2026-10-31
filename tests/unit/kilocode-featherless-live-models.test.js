// Live Kilo Code (OAuth) and Featherless (API key) catalogs seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { parseFeatherlessModels } from "@/lib/providerModels/apiKeyModels.js";

const PROVIDERS = ["kilocode", "featherless"];
const HOSTS = ["https://api.kilo.ai/", "https://api.featherless.ai/"];

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
    calls.push({
      url: String(url),
      auth: init.headers?.Authorization,
      org: init.headers?.["X-Kilocode-OrganizationID"],
    });
    return respond(String(url));
  });
});

afterEach(() => vi.unstubAllGlobals());

const dashboardModels = async (id) => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

describe("parsers", () => {
  it("featherless lists every row as chat, keeping registry names and limits", () => {
    const statics = [{ id: "zai-org/GLM-5.2", name: "GLM 5.2" }];
    const body = {
      data: [
        { id: "zai-org/GLM-5.2", context_length: 32768, max_completion_tokens: 4096 },
        { id: "meta-llama/Llama-3.3-70B-Instruct", is_gated: true, context_length: 32768 },
        { id: "zai-org/GLM-5.2" },
        { id: "" },
      ],
    };
    expect(parseFeatherlessModels(body, statics)).toEqual([
      { id: "zai-org/GLM-5.2", name: "GLM 5.2", contextLength: 32768, maxOutputTokens: 4096 },
      {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        name: "meta-llama/Llama-3.3-70B-Instruct",
        contextLength: 32768,
        maxOutputTokens: undefined,
      },
    ]);
  });
});

describe("live catalogs end to end", () => {
  it("kilocode lists the gateway catalog with its OAuth token and org header", async () => {
    respond = () =>
      Response.json({
        data: [
          {
            id: "kilo-auto/free",
            name: "Kilo Auto Free",
            isFree: true,
            architecture: { output_modalities: ["text"] },
          },
          { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", isFree: false },
        ],
      });
    const conn = await createProviderConnectionUnscoped({
      provider: "kilocode",
      authType: "oauth",
      accessToken: "kc-token",
      testStatus: "active",
      providerSpecificData: { orgId: "org-1" },
    });

    const body = await dashboardModels(conn.id);
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => [m.id, m.isFree])).toEqual([
      ["kilo-auto/free", true],
      ["anthropic/claude-sonnet-5", false],
    ]);
    expect(calls[0]).toEqual({
      url: "https://api.kilo.ai/api/gateway/models",
      auth: "Bearer kc-token",
      org: "org-1",
    });
    const alias = getProviderAlias("kilocode");
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(`${alias}/kilo-auto/free`);
  });

  it("featherless failure keeps the static list with a warning", async () => {
    respond = () => new Response("bad key sk-secret", { status: 401 });
    const conn = await createProviderConnectionUnscoped({
      provider: "featherless",
      authType: "apikey",
      apiKey: "sk-secret",
      testStatus: "active",
    });

    const body = await dashboardModels(conn.id);
    expect(calls[0].url).toBe("https://api.featherless.ai/v1/models");
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(body.warning).not.toContain("sk-secret");
  });
});
