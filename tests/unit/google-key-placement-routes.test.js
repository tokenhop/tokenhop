// YAN-1629: the provider validate route and the saved-connection test must send
// Google keys in x-goog-api-key, never the URL (proxy relays log pathname+search).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "secret-google-key-yan-1629-route";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/models", () => ({
  getProviderNodeByIdUnscoped: vi.fn(),
}));

function expectKeyInHeaderOnly(url, init) {
  const parsed = new URL(String(url));
  expect(parsed.searchParams.has("key")).toBe(false);
  expect(String(url)).not.toContain(KEY);
  expect(init.headers["x-goog-api-key"]).toBe(KEY);
}

describe("POST /api/providers/validate", () => {
  let POST;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    ({ POST } = await import("../../src/app/api/providers/validate/route.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function validate(provider, status) {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    return POST(
      new Request("https://tokenhop.local/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: KEY }),
      }),
    );
  }

  it("gemini: key in header and a 200 is valid", async () => {
    const response = await validate("gemini", 200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectKeyInHeaderOnly(...fetchMock.mock.calls[0]);
    expect(response.body.valid).toBe(true);
  });

  it.each(["vertex", "vertex-partner"])("%s raw key: key in header; 404 valid", async (p) => {
    const response = await validate(p, 404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectKeyInHeaderOnly(...fetchMock.mock.calls[0]);
    expect(response.body.valid).toBe(true);
  });

  it.each(["vertex", "vertex-partner"])("%s raw key: 401 is invalid", async (p) => {
    const response = await validate(p, 401);
    expect(response.body.valid).toBe(false);
  });
});

describe("saved gemini connection test", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    vi.doUnmock("open-sse/utils/proxyFetch.js");
    vi.unstubAllGlobals();
  });

  it.each([
    ["direct", {}],
    ["relay", { vercelRelayUrl: "https://relay.example" }],
  ])("%s: key in header, not URL", async (_label, proxy) => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const connection = { id: "g-1", provider: "gemini", authType: "apikey", apiKey: KEY };
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionByIdUnscoped: vi.fn(async () => connection),
      updateProviderConnectionUnscoped: vi.fn(async () => {}),
    }));
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: (url, opts) => fetchMock(url, opts),
      default: fetchMock,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => proxy),
    }));
    const { testSingleConnection } = await import(
      "../../src/app/api/providers/[id]/test/testUtils.js"
    );
    const result = await testSingleConnection(connection.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectKeyInHeaderOnly(...fetchMock.mock.calls[0]);
    expect(result.valid).toBe(true);
  });
});
