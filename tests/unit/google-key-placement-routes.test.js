// YAN-1629: the provider validate route and the saved-connection test must send
// Google keys in x-goog-api-key, never the URL (proxy relays log pathname+search).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "secret-google-key-yan-1629-route";
const SA = JSON.stringify({
  type: "service_account",
  client_email: "svc@sa-proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  project_id: "sa-proj",
});
const ADC = JSON.stringify({
  type: "authorized_user",
  client_id: "adc-client",
  client_secret: "adc-secret",
  refresh_token: "adc-refresh",
});

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

  function post(provider, apiKey) {
    return POST(
      new Request("https://tokenhop.local/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      }),
    );
  }

  function validate(provider, status, apiKey = KEY) {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    return post(provider, apiKey);
  }

  it("gemini: key in header and a 200 is valid", async () => {
    const response = await validate("gemini", 200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectKeyInHeaderOnly(...fetchMock.mock.calls[0]);
    expect(response.body.valid).toBe(true);
  });

  it("gemini: key with a line break is rejected without echoing the key", async () => {
    const response = await validate("gemini", 200, "abc\ndef-gemini-secret");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.body.valid).toBe(false);
    expect(response.body.error).not.toContain("abc");
    expect(response.body.error).not.toContain("def-gemini-secret");
  });

  describe.each(["vertex", "vertex-partner"])("%s", (p) => {
    it("raw key: key in header; 404 valid", async () => {
      const response = await validate(p, 404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectKeyInHeaderOnly(...fetchMock.mock.calls[0]);
      expect(response.body.valid).toBe(true);
    });

    it("raw key: 401 is invalid", async () => {
      const response = await validate(p, 401);
      expect(response.body.valid).toBe(false);
    });

    it("raw key: 403 is invalid", async () => {
      const response = await validate(p, 403);
      expect(response.body.valid).toBe(false);
    });

    it("complete service-account JSON is valid without a probe", async () => {
      const response = await validate(p, 200, SA);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body.valid).toBe(true);
    });

    it("service-account JSON missing private_key is invalid without a probe", async () => {
      const { private_key: _omit, ...partial } = JSON.parse(SA);
      const response = await validate(p, 200, JSON.stringify(partial));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body.valid).toBe(false);
    });

    it("complete ADC JSON is valid without a probe", async () => {
      const response = await validate(p, 200, ADC);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body.valid).toBe(true);
    });

    it("arbitrary JSON object is invalid without a probe", async () => {
      const response = await validate(p, 200, '{"foo":1}');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body.valid).toBe(false);
    });

    it("key with a line break is rejected without echoing the key", async () => {
      const response = await validate(p, 200, "abc\ndef-vertex-secret");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body.valid).toBe(false);
      expect(response.body.error).not.toContain("abc");
      expect(response.body.error).not.toContain("def-vertex-secret");
    });
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
  ])("%s: key in header, not URL", async (label, proxy) => {
    vi.resetModules();
    const globalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const proxyFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const connection = { id: "g-1", provider: "gemini", authType: "apikey", apiKey: KEY };
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionByIdUnscoped: vi.fn(async () => connection),
      updateProviderConnectionUnscoped: vi.fn(async () => {}),
    }));
    vi.doMock("open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: (url, opts, proxyOptions) => proxyFetch(url, opts, proxyOptions),
      default: globalFetch,
    }));
    vi.doMock("@/lib/network/connectionProxy", () => ({
      resolveConnectionProxyConfig: vi.fn(async () => proxy),
    }));
    const { testSingleConnection } = await import(
      "../../src/app/api/providers/[id]/test/testUtils.js"
    );
    const result = await testSingleConnection(connection.id);

    expect(result.valid).toBe(true);
    if (label === "relay") {
      expect(globalFetch).not.toHaveBeenCalled();
      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expectKeyInHeaderOnly(...proxyFetch.mock.calls[0]);
      expect(proxyFetch.mock.calls[0][2]).toEqual({ vercelRelayUrl: "https://relay.example" });
    } else {
      expect(proxyFetch).not.toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expectKeyInHeaderOnly(...globalFetch.mock.calls[0]);
    }
  });
});
