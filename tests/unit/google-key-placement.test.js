// YAN-1629: Google API keys must travel in x-goog-api-key, never the URL —
// proxy relays log pathname+search (x-relay-path), so ?key= leaks to the relay.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [] }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options = {}, proxyOptions = null) => {
    mocks.calls.push({ url: String(url), options, proxyOptions });
    if (String(url).includes("__probe__")) {
      return {
        json: async () => [
          { error: { message: "Invalid project: projects/resolved-proj/locations/global" } },
        ],
      };
    }
    return { status: 200, ok: true, json: async () => ({}) };
  },
  default: async () => ({ status: 200, ok: true, json: async () => ({}) }),
}));

import geminiEmbedding from "../../open-sse/handlers/embeddingProviders/gemini.js";
import geminiImage from "../../open-sse/handlers/imageProviders/gemini.js";
import { VertexExecutor } from "../../open-sse/executors/vertex.js";
import { probeVertexKey, probeWebProvider } from "@/lib/providerKeyProbes.js";

const KEY = "secret-google-key-yan-1629";
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
  quota_project_id: "adc-proj",
});

function expectNoKeyInUrl(url, key = KEY) {
  const parsed = new URL(url);
  expect(parsed.searchParams.has("key")).toBe(false);
  expect(url).not.toContain(key);
  return parsed;
}

describe("gemini embedding adapter", () => {
  it("single embed: key in header, not URL", () => {
    const url = geminiEmbedding.buildUrl("gemini-embedding-001", { apiKey: KEY }, { input: "hi" });
    const parsed = expectNoKeyInUrl(url);
    expect(parsed.pathname).toContain(":embedContent");
    expect(geminiEmbedding.buildHeaders({ apiKey: KEY }, { input: "hi" })["x-goog-api-key"]).toBe(
      KEY,
    );
  });

  it("batch embed: key in header, not URL", () => {
    const url = geminiEmbedding.buildUrl(
      "gemini-embedding-001",
      { apiKey: KEY },
      { input: ["a", "b"] },
    );
    const parsed = expectNoKeyInUrl(url);
    expect(parsed.pathname).toContain(":batchEmbedContents");
    expect(
      geminiEmbedding.buildHeaders({ apiKey: KEY }, { input: ["a", "b"] })["x-goog-api-key"],
    ).toBe(KEY);
  });

  it("accessToken fallback stays out of the URL", () => {
    const url = geminiEmbedding.buildUrl(
      "gemini-embedding-001",
      { accessToken: "oauth-tok" },
      { input: "hi" },
    );
    expectNoKeyInUrl(url, "oauth-tok");
  });
});

describe("gemini image adapter", () => {
  it("key in header, not URL", () => {
    const url = geminiImage.buildUrl("gemini-2.5-flash-image", { apiKey: KEY });
    const parsed = expectNoKeyInUrl(url);
    expect(parsed.pathname).toContain(":generateContent");
    expect(
      geminiImage.buildHeaders({ apiKey: KEY }, {}, "gemini-2.5-flash-image", {})["x-goog-api-key"],
    ).toBe(KEY);
  });
});

describe("VertexExecutor", () => {
  it("vertex raw key, non-stream: key in header, not URL", () => {
    const ex = new VertexExecutor("vertex");
    const url = ex.buildUrl("gemini-2.5-pro", false, 0, { apiKey: KEY });
    expectNoKeyInUrl(url);
    const headers = ex.buildHeaders({ apiKey: KEY }, false);
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  it("vertex raw key, stream: URL keeps alt=sse and no key", () => {
    const ex = new VertexExecutor("vertex");
    const url = ex.buildUrl("gemini-2.5-pro", true, 0, { apiKey: KEY });
    const parsed = expectNoKeyInUrl(url);
    expect(parsed.searchParams.get("alt")).toBe("sse");
    expect(ex.buildHeaders({ apiKey: KEY }, true)["x-goog-api-key"]).toBe(KEY);
  });

  it("vertex-partner raw key: key in header, not URL", () => {
    const ex = new VertexExecutor("vertex-partner");
    const creds = { apiKey: KEY, providerSpecificData: { projectId: "proj-1" } };
    const url = ex.buildUrl("meta/llama-3.1-405b-instruct-maas", false, 0, creds);
    expectNoKeyInUrl(url);
    expect(url).toContain("/projects/proj-1/");
    expect(ex.buildHeaders(creds, false)["x-goog-api-key"]).toBe(KEY);
  });

  it("SA flow sends no x-goog-api-key", () => {
    const ex = new VertexExecutor("vertex");
    const url = ex.buildUrl("gemini-2.5-pro", true, 0, { apiKey: SA });
    expect(url).toContain("/projects/sa-proj/");
    // Before the token is minted, SA JSON must never be sent as an API key.
    expect(ex.buildHeaders({ apiKey: SA }, true)["x-goog-api-key"]).toBeUndefined();
    const headers = ex.buildHeaders({ apiKey: SA, accessToken: "minted-tok" }, true);
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer minted-tok");
  });

  it("ADC flow sends no x-goog-api-key", () => {
    const ex = new VertexExecutor("vertex");
    const url = ex.buildUrl("gemini-2.5-pro", false, 0, { apiKey: ADC });
    expect(url).toContain("/projects/adc-proj/");
    const headers = ex.buildHeaders({ apiKey: ADC, accessToken: "adc-tok" }, false);
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer adc-tok");
  });

  it("accessToken flow sends no x-goog-api-key", () => {
    const ex = new VertexExecutor("vertex");
    const creds = { accessToken: "tok-1", providerSpecificData: { projectId: "proj-9" } };
    const url = ex.buildUrl("gemini-2.5-pro", false, 0, creds);
    expect(url).toContain("/projects/proj-9/");
    expect(url).not.toContain(KEY);
    const headers = ex.buildHeaders(creds, false);
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer tok-1");
  });

  it("vertex-partner project probe (resolveProjectId via execute) keeps key out of URLs", async () => {
    mocks.calls.length = 0;
    const ex = new VertexExecutor("vertex-partner");
    // A distinct-key proxy-options object; the probe must route through the same proxy.
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://p:1" };
    await ex.execute({
      model: "meta/llama-3.1-405b-instruct-maas",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: `${KEY}-probe` },
      proxyOptions,
    });
    expect(mocks.calls).toHaveLength(2);
    for (const call of mocks.calls) {
      expectNoKeyInUrl(call.url, `${KEY}-probe`);
      expect(call.options.headers["x-goog-api-key"]).toBe(`${KEY}-probe`);
      expect(call.proxyOptions).toBe(proxyOptions);
    }
    expect(mocks.calls[1].url).toContain("/projects/resolved-proj/");
  });
});

describe("providerKeyProbes", () => {
  it("probeVertexKey sends key in header, not URL", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: 404, ok: false };
    };
    await expect(probeVertexKey(KEY, fetchImpl)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expectNoKeyInUrl(calls[0].url);
    expect(calls[0].init.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("google-pse probe sends key in header and keeps q/cx params", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: 200, ok: true };
    };
    await expect(probeWebProvider("google-pse", KEY, fetchImpl)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    const parsed = expectNoKeyInUrl(calls[0].url);
    expect(parsed.searchParams.get("q")).toBe("ping");
    expect(parsed.searchParams.get("cx")).toBe("test");
    expect(calls[0].init.headers["x-goog-api-key"]).toBe(KEY);
  });
});
