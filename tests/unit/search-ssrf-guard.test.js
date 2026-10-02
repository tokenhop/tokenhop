import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

const CONFIG = { id: "searxng", baseUrl: "https://searxng.example.com" };

const TAVILY_CONFIG = {
  id: "tavily",
  baseUrl: "https://api.tavily.com",
  method: "POST",
  authType: "apikey",
  defaultMaxResults: 5,
  maxMaxResults: 100,
};

const EMPTY_TAVILY = () =>
  new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("resolveBaseUrl ignores the client baseUrl override (YAN-649)", () => {
  it("uses provider default when no override", () => {
    expect(resolveBaseUrl(CONFIG, {})).toBe("https://searxng.example.com");
  });

  it("ignores a public client provider_options.baseUrl", () => {
    const params = { providerOptions: { baseUrl: "https://attacker.example" } };
    expect(resolveBaseUrl(CONFIG, params)).toBe("https://searxng.example.com");
  });

  it("ignores internal and non-http client overrides instead of throwing", () => {
    for (const url of [
      "http://127.0.0.1:18999",
      "http://localhost:8080",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      expect(resolveBaseUrl(CONFIG, { providerOptions: { baseUrl: url } }), url).toBe(
        "https://searxng.example.com",
      );
    }
  });

  it("honours the operator connection baseUrl (providerSpecificData)", () => {
    const params = { providerSpecificData: { baseUrl: "https://search.example.net/search" } };
    expect(resolveBaseUrl(CONFIG, params)).toBe("https://search.example.net/search");
  });

  it("prefers the operator connection baseUrl over a client override", () => {
    const params = {
      providerOptions: { baseUrl: "https://attacker.example" },
      providerSpecificData: { baseUrl: "https://search.example.net" },
    };
    expect(resolveBaseUrl(CONFIG, params)).toBe("https://search.example.net");
  });

  it("rejects a non-http operator connection baseUrl", () => {
    const params = { providerSpecificData: { baseUrl: "file:///etc/passwd" } };
    expect(() => resolveBaseUrl(CONFIG, params)).toThrow(/protocol/);
  });
});

describe("stored credential never reaches a client-supplied URL (YAN-649)", () => {
  it("sends the stored key only to the provider's configured endpoint", async () => {
    const fetchMock = vi.fn(async () => EMPTY_TAVILY());
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSearchCore({
      body: { query: "x", provider_options: { baseUrl: "https://attacker.example" } },
      provider: { id: "tavily" },
      providerConfig: TAVILY_CONFIG,
      credentials: { apiKey: "stored-tavily-key" },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe("https://api.tavily.com");
    expect(String(calledUrl)).not.toContain("attacker.example");
    expect(init.headers.Authorization).toBe("Bearer stored-tavily-key");
  });
});
