// Live Kimi Coding catalog (API key + OAuth) seen by the dashboard and /v1/models.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const engineMocks = vi.hoisted(() => ({
  mocks: {
    refreshTokenByProvider: vi.fn(),
  },
}));
vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshTokenByProvider: engineMocks.mocks.refreshTokenByProvider,
}));

const proxyMocks = vi.hoisted(() => ({
  transport: null, // async (url, options, proxyOptions) => Response
  resolver: null, // override for failure injection
  refreshProxyOptions: [],
  resolverCalls: [],
}));
const { mocks } = engineMocks;

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: async (url, options, proxyOptions) =>
    proxyMocks.transport(url, options, proxyOptions),
}));
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveConnectionProxyConfig: async (psd) => {
    proxyMocks.resolverCalls.push(psd);
    if (proxyMocks.resolver) return proxyMocks.resolver(psd);
    return {
      source: "pool",
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: true,
    };
  },
}));

const { GET } = await import("@/app/api/providers/[id]/models/route.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const {
  createProviderConnectionUnscoped,
  getProviderConnectionByIdUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} = await import("@/models/index.js");
const { getProviderAlias } = await import("@/shared/constants/providers");
const { clearLiveModelsCache } = await import("@/lib/providerModels/liveResolvers.js");
const { parseKimiModels, resolveKimi } = await import("@/lib/providerModels/kimiModels.js");

const CATALOG_URL = "https://api.kimi.com/coding/v1/models";

let captured;
let respond;
let logLines;
const origLog = console.log;

beforeEach(async () => {
  captured = [];
  respond = () => new Response("unexpected", { status: 500 });
  logLines = [];
  console.log = (...args) => logLines.push(args.map(String).join(" "));
  clearLiveModelsCache();
  mocks.refreshTokenByProvider.mockReset();
  proxyMocks.transport = async (url, options, proxyOptions) => {
    captured.push({ url: String(url), options, proxyOptions });
    return respond(url, options);
  };
  proxyMocks.resolverCalls = [];
  proxyMocks.refreshProxyOptions = [];
  proxyMocks.resolver = null;
  mocks.refreshTokenByProvider.mockImplementation(async (provider, conn, log, proxyOptions) => {
    proxyMocks.refreshProxyOptions.push(proxyOptions);
    return null;
  });
  for (const p of ["kimi", "kimi-coding"]) await deleteProviderConnectionsByProviderUnscoped(p);
});
afterEach(() => {
  console.log = origLog;
  vi.unstubAllGlobals();
});

const successBody = {
  data: [
    {
      id: "kimi-for-coding",
      display_name: "Fixture Coding Live",
      context_length: 262144,
      supports_reasoning: false,
      supports_image_in: false,
      supports_video_in: false,
    },
    {
      id: "kimi-fixture-next",
      display_name: "Fixture Next",
      context_length: 131072,
      supports_reasoning: true,
      supports_image_in: true,
      supports_video_in: true,
    },
  ],
};
const serve = () => Response.json(successBody);

const connect = (over) =>
  createProviderConnectionUnscoped({
    provider: "kimi",
    authType: "apikey",
    apiKey: "kimi-key",
    testStatus: "active",
    providerSpecificData: { deviceId: "dev-1" },
    ...over,
  });

const dashboardModels = async (id, query = "") => {
  const res = await GET(new Request(`http://localhost/api/providers/${id}/models${query}`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
};

const normProxy = () => ({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://proxy.test:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
});

describe("kimi parsing", () => {
  it("maps names/context/flags to capabilities and keeps explicit false", () => {
    expect(parseKimiModels(successBody)).toEqual([
      {
        id: "kimi-for-coding",
        name: "Fixture Coding Live",
        kind: "llm",
        contextLength: 262144,
        capabilities: {
          reasoning: false,
          vision: false,
          videoInput: false,
          contextWindow: 262144,
        },
        inputModalities: ["text"],
      },
      {
        id: "kimi-fixture-next",
        name: "Fixture Next",
        kind: "llm",
        contextLength: 131072,
        capabilities: {
          reasoning: true,
          vision: true,
          videoInput: true,
          contextWindow: 131072,
        },
        inputModalities: ["text", "image", "video"],
      },
    ]);
  });

  it("rejects malformed rows and invalid optional fields", () => {
    expect(
      parseKimiModels({
        data: [
          null,
          42,
          { id: "  " },
          { id: 7 },
          { id: "dup", display_name: "First" },
          { id: "dup", display_name: "Second" },
          { id: "loose", display_name: "  ", context_length: "big", supports_reasoning: "yes" },
          { id: "neg", context_length: -5 },
          { id: "frac", context_length: 1.5 },
        ],
      }),
    ).toEqual([
      { id: "dup", name: "First", kind: "llm", inputModalities: ["text"] },
      { id: "loose", name: "loose", kind: "llm", inputModalities: ["text"] },
      { id: "neg", name: "neg", kind: "llm", inputModalities: ["text"] },
      { id: "frac", name: "frac", kind: "llm", inputModalities: ["text"] },
    ]);
    expect(parseKimiModels(null)).toEqual([]);
    expect(parseKimiModels({})).toEqual([]);
    expect(parseKimiModels({ data: "no" })).toEqual([]);
  });
});

describe("kimi auth and transport", () => {
  it("prefers the API key with exact URL, Bearer and device headers", async () => {
    respond = serve;
    const conn = await connect({ accessToken: "oauth-tok", refreshToken: "r" });
    const body = await dashboardModels(conn.id, "?hidden=1");
    expect(body.warning).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(["kimi-for-coding", "kimi-fixture-next"]);
    expect(captured).toHaveLength(1);
    const [call] = captured;
    expect(call.url).toBe(CATALOG_URL);
    expect(call.options.method).toBe("GET");
    expect(call.options.headers.Authorization).toBe("Bearer kimi-key");
    expect(call.options.headers.Accept).toBe("application/json");
    expect(call.options.headers["X-Msh-Device-Id"]).toBe("dev-1");
    expect(call.options.redirect).toBe("error");
    expect(call.options.signal?.aborted).toBe(false);
    expect(call.proxyOptions).toEqual(normProxy());
    expect(mocks.refreshTokenByProvider).not.toHaveBeenCalled();
  });

  it("uses the OAuth token when no API key exists", async () => {
    respond = serve;
    const conn = await connect({ apiKey: null, authType: "oauth", accessToken: "oauth-tok" });
    await dashboardModels(conn.id);
    expect(captured[0].options.headers.Authorization).toBe("Bearer oauth-tok");
  });

  it("warns without network when both credentials are missing", async () => {
    const result = await resolveKimi({ provider: "kimi", id: "x", apiKey: "  ", accessToken: "" });
    expect(result).toEqual({ models: [], warning: "No valid token found" });
    expect(captured).toHaveLength(0);
  });

  it("never refreshes a rejected API key even when OAuth tokens coexist", async () => {
    respond = () => new Response("", { status: 401 });
    const conn = await connect({ accessToken: "oauth-tok", refreshToken: "r" });
    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/^Failed to fetch Kimi models: 401$/);
    expect(mocks.refreshTokenByProvider).not.toHaveBeenCalled();
  });

  it("refreshes OAuth once on 401, persists rotation and retries with the same proxy", async () => {
    mocks.refreshTokenByProvider.mockImplementation(async (provider, conn, log, proxyOptions) => {
      proxyMocks.refreshProxyOptions.push(proxyOptions);
      return { accessToken: "fresh", refreshToken: "rot", expiresIn: 3600 };
    });
    respond = (url, options) =>
      options.headers.Authorization === "Bearer stale"
        ? new Response(null, { status: 401 })
        : serve();
    const conn = await connect({
      apiKey: null,
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "r",
      providerSpecificData: { deviceId: "dev-1", proxyPoolId: "pool-1" },
    });
    const body = await dashboardModels(conn.id);
    expect(body.models.map((m) => m.id)).toEqual(["kimi-for-coding", "kimi-fixture-next"]);
    expect(mocks.refreshTokenByProvider).toHaveBeenCalledTimes(1);
    expect(mocks.refreshTokenByProvider.mock.calls[0][0]).toBe("kimi");
    expect(mocks.refreshTokenByProvider.mock.calls[0][2]).toBeNull();
    expect(proxyMocks.refreshProxyOptions[0]).toEqual(normProxy());
    // Real persistence through the shared helper into disposable SQLite.
    const saved = await getProviderConnectionByIdUnscoped(conn.id);
    expect(saved.accessToken).toBe("fresh");
    expect(saved.refreshToken).toBe("rot");
    expect(saved.providerSpecificData.deviceId).toBe("dev-1");
    expect(captured).toHaveLength(2);
    expect(captured[1].proxyOptions).toEqual(normProxy());
    expect(captured[1].options.headers.Authorization).toBe("Bearer fresh");
    expect(captured[1].options.headers["X-Msh-Device-Id"]).toBe("dev-1");
  });

  it("returns a safe warning when the retry still fails", async () => {
    mocks.refreshTokenByProvider.mockResolvedValue({ accessToken: "fresh" });
    respond = () => new Response("SECRET-token-leak", { status: 401 });
    const conn = await connect({
      apiKey: null,
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "r",
    });
    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toBe("Failed to fetch Kimi models: 401 ");
    expect(body.warning).not.toContain("SECRET-token-leak");
    expect(mocks.refreshTokenByProvider).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the refresh fails", async () => {
    mocks.refreshTokenByProvider.mockRejectedValue(new Error("refresh SECRET-failure"));
    respond = () => new Response(null, { status: 401 });
    const conn = await connect({
      apiKey: null,
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "r",
    });
    const body = await dashboardModels(conn.id);
    expect(body.models).toEqual([]);
    expect(body.warning).toBe("Failed to fetch Kimi models: 401 ");
    expect(body.warning).not.toContain("SECRET");
    expect(captured).toHaveLength(1);
    expect(logLines.join("\n")).not.toContain("SECRET");
  });

  it("maps timeouts, invalid JSON, empty catalogs and 5xx to safe warnings", async () => {
    const conn = await connect();
    respond = () => {
      throw new Error("boom SECRET-key");
    };
    expect((await dashboardModels(conn.id)).warning).toBe("Failed to fetch Kimi models.");
    expect((await dashboardModels(conn.id, "?refresh=1")).warning).toBe(
      "Failed to fetch Kimi models.",
    );
    for (const boom of [
      () => {
        throw new SyntaxError("bad json SECRET-key");
      },
      () => Response.json({ data: [] }),
      () => Response.json({ data: [{ id: " " }] }),
      () => new Response("SECRET-upstream", { status: 503 }),
    ]) {
      respond = boom;
      const body = await dashboardModels(conn.id, "?refresh=1");
      expect(body.models).toEqual([]);
      expect(body.warning).toMatch(/^(Failed to fetch Kimi models|Kimi returned no live models)/);
      expect(JSON.stringify(body)).not.toContain("SECRET");
    }
    expect(logLines.join("\n")).not.toContain("SECRET");
  });

  it("aborts on proxy-resolution failure without network", async () => {
    proxyMocks.resolver = () => ({ source: "error" });
    const conn = await connect();
    const body = await dashboardModels(conn.id);
    expect(body).toEqual({
      provider: "kimi",
      connectionId: conn.id,
      models: expect.any(Array),
      warning: "Failed to fetch Kimi models: proxy resolution failed",
    });
    expect(captured).toHaveLength(0);
  });

  it("contains synthetic secrets in warnings, models and logs", async () => {
    const secret = "SECRET-kimi-key-9";
    const conn = await connect({ apiKey: secret });
    respond = () => new Response(`upstream says ${secret}`, { status: 503 });
    const body = await dashboardModels(conn.id);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(captured.map((c) => c.proxyOptions))).not.toContain(secret);
    expect(logLines.join("\n")).not.toContain(secret);
  });
});

describe("kimi shared behavior", () => {
  it("caches dashboard success, honors refresh and isolates connections", async () => {
    respond = serve;
    const a = await connect();
    const b = await connect({ apiKey: "other-key" });
    await dashboardModels(a.id);
    await dashboardModels(a.id);
    expect(captured).toHaveLength(1);
    await dashboardModels(a.id, "?refresh=1");
    expect(captured).toHaveLength(2);
    await dashboardModels(b.id);
    expect(captured).toHaveLength(3);
  });

  it("retries after a cached success followed by forced failure, then recovers", async () => {
    respond = serve;
    const conn = await connect();
    await dashboardModels(conn.id);
    expect(captured).toHaveLength(1);
    respond = () => new Response("down", { status: 503 });
    const failed = await dashboardModels(conn.id, "?refresh=1");
    expect(failed.models).toEqual([]);
    expect(failed.warning).toMatch(/^Failed to fetch Kimi models/);
    expect(captured).toHaveLength(2);
    respond = serve;
    const recovered = await dashboardModels(conn.id, "?refresh=1");
    expect(recovered.models.map((m) => m.id)).toContain("kimi-fixture-next");
    expect(captured).toHaveLength(3);
  });

  it("exposes live models through the public list with metadata and no warning", async () => {
    respond = serve;
    await connect();
    const list = await buildModelsList(["llm"]);
    const alias = getProviderAlias("kimi");
    const live = list.find((m) => m.id === `${alias}/kimi-fixture-next`);
    expect(live).toBeDefined();
    expect(live.warning).toBeUndefined();
    expect(JSON.stringify(live)).not.toContain("kimi-key");
    const known = list.find((m) => m.id === `${alias}/kimi-for-coding`);
    expect(known?.capabilities?.reasoning).toBe(false);
  });

  it("keeps explicit enabledModels bypassing discovery", async () => {
    respond = serve;
    const conn = await connect({
      providerSpecificData: { deviceId: "dev-1", enabledModels: ["k3"] },
    });
    void conn;
    const list = await buildModelsList(["llm"]);
    const alias = getProviderAlias("kimi");
    expect(list.map((m) => m.id)).toContain(`${alias}/k3`);
    expect(captured).toHaveLength(0);
  });
});
