// proxyAwareFetch must pass a caller-supplied dispatcher and redirect:"manual"
// through unchanged on every path that ends in a plain fetch, must skip the
// MITM DNS-bypass branch when a dispatcher is supplied, and must not treat
// lookalike hosts (api2.cursor.sh.other.example) as bypass hosts.
// proxyFetch captures globalThis.fetch at import as its direct path, so stub
// it before importing and keep the test offline.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
globalThis.fetch = fetchStub;

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const PINNED = { marker: "caller-dispatcher" };

const failingProxy = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:9",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  connectionProxyPoolId: "pool-1",
};

// Proxy dispatchers fail; plain direct fetch succeeds. Mirrors the offline
// convention from proxy-strict-fetch.test.js.
const isProxyDispatcher = (d) => d && d !== PINNED; // pool ProxyAgent instance

function proxyDown() {
  fetchStub.mockImplementation(async (_url, options = {}) => {
    if (isProxyDispatcher(options?.dispatcher)) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    return new Response("direct", { status: 200 });
  });
}

beforeEach(() => {
  fetchStub.mockReset();
  fetchStub.mockImplementation(async () => new Response("ok", { status: 200 }));
});

describe("proxyAwareFetch dispatcher passthrough", () => {
  it("passes dispatcher and redirect:manual unchanged when no proxy applies", async () => {
    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "manual", dispatcher: PINNED },
      null,
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://example.com/image.png");
    expect(options.dispatcher).toBe(PINNED);
    expect(options.redirect).toBe("manual");
  });

  it("skips the MITM DNS bypass when the caller supplies a dispatcher", async () => {
    await proxyAwareFetch(
      "https://api2.cursor.sh/x",
      { redirect: "manual", dispatcher: PINNED },
      null,
    );

    // One plain fetch with the caller dispatcher; no bypass socket request.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api2.cursor.sh/x");
    expect(options.dispatcher).toBe(PINNED);
    expect(options.redirect).toBe("manual");
  });

  it("does not treat a lookalike suffix host as a MITM bypass host", async () => {
    await proxyAwareFetch("https://api2.cursor.sh.other.example/x", {}, null);

    // No bypass: a single direct fetch, no dispatcher added.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api2.cursor.sh.other.example/x");
    expect(options.dispatcher).toBeUndefined();
  });

  it("keeps the caller dispatcher on the direct fallback after a non-strict proxy failure", async () => {
    proxyDown();

    const res = await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "manual", dispatcher: PINNED },
      { ...failingProxy, strictProxy: false },
    );

    expect(await res.text()).toBe("direct");
    expect(fetchStub).toHaveBeenCalledTimes(2);
    // Proxied attempt used the pool dispatcher…
    expect(isProxyDispatcher(fetchStub.mock.calls[0][1]?.dispatcher)).toBe(true);
    // …and the direct fallback keeps the caller dispatcher and redirect policy.
    const fallbackOptions = fetchStub.mock.calls[1][1];
    expect(fallbackOptions.dispatcher).toBe(PINNED);
    expect(fallbackOptions.redirect).toBe("manual");
  });

  it("throws on proxy failure when strictProxy is true, with no direct fallback", async () => {
    proxyDown();

    await expect(
      proxyAwareFetch(
        "https://example.com/image.png",
        { redirect: "manual", dispatcher: PINNED },
        { ...failingProxy, strictProxy: true },
      ),
    ).rejects.toThrow("strictProxy=true");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(isProxyDispatcher(fetchStub.mock.calls[0][1]?.dispatcher)).toBe(true);
  });
});
