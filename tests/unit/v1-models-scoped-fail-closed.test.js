// YAN-1056: under a gateway principal, catalog read failures fail closed (503,
// generic message) instead of degrading to a partial/legacy catalog. Legacy
// storage (principal null) keeps its fail-open behavior. The API-type probe is
// metadata only: its failure can never fail the request.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGatewayAuth: vi.fn(),
  apiType: vi.fn(),
  getModelInfo: vi.fn(),
  gateway: {
    getGatewayConnections: vi.fn(),
    getGatewayCombos: vi.fn(),
    getGatewayCustomModels: vi.fn(),
    getGatewayAliases: vi.fn(),
    getGatewayDisabled: vi.fn(),
  },
  unscoped: {
    connections: vi.fn(),
    combos: vi.fn(),
    customModels: vi.fn(),
    aliases: vi.fn(),
  },
}));

vi.mock("@/lib/auth/gatewayResources.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...mocks.gateway,
}));

vi.mock("@/lib/localDb", async (importOriginal) => {
  const actual = await importOriginal();
  mocks.unscoped.connections.mockImplementation(actual.getProviderConnectionsUnscoped);
  mocks.unscoped.combos.mockImplementation(actual.getCombosUnscoped);
  mocks.unscoped.customModels.mockImplementation(actual.getCustomModelsUnscoped);
  mocks.unscoped.aliases.mockImplementation(actual.getModelAliasesUnscoped);
  return {
    ...actual,
    getProviderConnectionsUnscoped: mocks.unscoped.connections,
    getCombosUnscoped: mocks.unscoped.combos,
    getCustomModelsUnscoped: mocks.unscoped.customModels,
    getModelAliasesUnscoped: mocks.unscoped.aliases,
  };
});

vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveOpenAICompatibleConnectionApiType: mocks.apiType,
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("@/lib/auth/gatewayAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

import { GET as listModels, buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as lookupModel } from "@/app/api/v1/models/[...model]/route.js";
import { GET as geminiList } from "@/app/api/v1beta/models/route.js";

const req = (url) => new Request(url);
const params = (model) => ({ params: Promise.resolve({ model }) });
const PRINCIPAL = Object.freeze({
  workspaceId: "w1",
  userId: null,
  apiKeyId: "key-1",
  scopes: Object.freeze({ allowedModels: Object.freeze([]), allowedCombos: Object.freeze([]) }),
  via: "apiKey",
});
const CATALOG_DOWN = { message: "Model catalog unavailable", type: "server_error" };

vi.spyOn(console, "log").mockImplementation(() => {});
const NODE_ID = "openai-compatible-completions-11111111-2222-3333-4444-555555555555";
const nodeConn = (patch = {}) => ({
  id: "c1",
  provider: NODE_ID,
  isActive: true,
  apiKey: "k",
  providerSpecificData: {
    prefix: "fimnode",
    baseUrl: "http://localhost:9",
    enabledModels: ["m1"],
  },
  ...patch,
});
const scopedReads = () => ({
  connections: mocks.gateway.getGatewayConnections,
  combos: mocks.gateway.getGatewayCombos,
  customModels: mocks.gateway.getGatewayCustomModels,
  aliases: mocks.gateway.getGatewayAliases,
  disabled: mocks.gateway.getGatewayDisabled,
});
const okayScope = () => {
  mocks.gateway.getGatewayConnections.mockResolvedValue([nodeConn()]);
  mocks.gateway.getGatewayCombos.mockResolvedValue([]);
  mocks.gateway.getGatewayCustomModels.mockResolvedValue([]);
  mocks.gateway.getGatewayAliases.mockResolvedValue({});
  mocks.gateway.getGatewayDisabled.mockResolvedValue({});
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveGatewayAuth.mockResolvedValue({ principal: PRINCIPAL, legacy: false });
  mocks.apiType.mockResolvedValue("completions");
  okayScope();
});

describe("scoped catalog fails closed (YAN-1056)", () => {
  it.each(Object.keys(scopedReads()))(
    "%s read rejection → builder rejects, GET 503, no data",
    async (key) => {
      scopedReads()[key].mockRejectedValueOnce(new Error("storage down"));
      await expect(buildModelsList(["llm"], { principal: PRINCIPAL })).rejects.toThrow();
      scopedReads()[key].mockRejectedValueOnce(new Error("storage down"));
      const res = await listModels(req("http://localhost/v1/models"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: CATALOG_DOWN });
      expect(JSON.stringify(body)).not.toContain("storage down");
    },
  );

  it.each([
    ["kind list", () => lookupModel(req("http://localhost/v1/models/tts"), params(["tts"]))],
    [
      "single lookup",
      () =>
        lookupModel(req("http://localhost/v1/models/openai/gpt-4o"), params(["openai", "gpt-4o"])),
    ],
    ["v1beta list", () => geminiList(req("http://localhost/v1beta/models"))],
  ])("%s: scoped failure → 503, never a row or 404", async (_name, call) => {
    mocks.gateway.getGatewayCombos.mockRejectedValue(new Error("storage down"));
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toEqual(CATALOG_DOWN);
    expect(body).toEqual({ error: CATALOG_DOWN });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("disabled success control still excludes the model (200)", async () => {
    mocks.gateway.getGatewayDisabled.mockResolvedValue({ fimnode: ["m1"] });
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((m) => m.id)).not.toContain("fimnode/m1");
  });

  it("key-allowlist lookup rejection → 503", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({
      principal: Object.freeze({
        ...PRINCIPAL,
        scopes: Object.freeze({
          allowedModels: Object.freeze(["openai/gpt-4o"]),
          allowedCombos: Object.freeze([]),
        }),
      }),
      legacy: false,
    });
    mocks.getModelInfo.mockRejectedValue(new Error("resolver down"));
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toEqual(CATALOG_DOWN);
  });

  it("grant filter: lookup rejection → 503; allowed lists, denied drops", async () => {
    const granted = (allowed) => [
      { id: "own", provider: "openai", isActive: true },
      nodeConn({ id: "g1", grantId: "gr1", grantAllowedModels: allowed }),
    ];
    mocks.getModelInfo.mockResolvedValue({ provider: NODE_ID, model: "m1" });
    mocks.gateway.getGatewayConnections.mockResolvedValue(granted([`${NODE_ID}/m1`]));
    const allowedIds = (await buildModelsList(["llm"], { principal: PRINCIPAL })).map((m) => m.id);
    expect(allowedIds).toContain("fimnode/m1");
    mocks.gateway.getGatewayConnections.mockResolvedValue(granted(["openai/gpt-4o"]));
    const deniedIds = (await buildModelsList(["llm"], { principal: PRINCIPAL })).map((m) => m.id);
    expect(deniedIds).not.toContain("fimnode/m1");
    mocks.getModelInfo.mockRejectedValue(new Error("resolver down"));
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toEqual(CATALOG_DOWN);
  });

  it("api-type probe failure is metadata only: 200, entry stays, no completions/FIM hint", async () => {
    mocks.apiType.mockRejectedValue(new Error("probe down"));
    const models = await buildModelsList(["llm"], { principal: PRINCIPAL });
    const entry = models.find((m) => m.id === "fimnode/m1");
    expect(entry).toBeTruthy();
    expect(entry).not.toHaveProperty("endpoint");
    expect(entry.capabilities?.fim).not.toBe(true);
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(200);
  });

  it.each([
    ["base list", () => listModels(req("http://localhost/v1/models"))],
    ["kind lookup", () => lookupModel(req("http://localhost/v1/models/tts"), params(["tts"]))],
    ["Gemini list", () => geminiList(req("http://localhost/v1beta/models"))],
  ])("%s auth throw → 503, never a legacy catalog", async (_name, call) => {
    mocks.resolveGatewayAuth.mockRejectedValue(new Error("API_KEY_STATE_INVALID"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { message: "Gateway authentication unavailable", type: "server_error" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("legacy storage keeps fail-open", () => {
  it("unscoped read failures still return a list (200)", async () => {
    mocks.resolveGatewayAuth.mockResolvedValue({ principal: null, legacy: true });
    for (const fn of Object.values(mocks.unscoped)) fn.mockRejectedValue(new Error("storage down"));
    const res = await listModels(req("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).data)).toBe(true);
  });
});
