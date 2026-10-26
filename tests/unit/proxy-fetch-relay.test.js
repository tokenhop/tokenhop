// YAN-1577: the Vercel relay branch of proxyAwareFetch must not reuse a
// dispatcher pinned to the target host — the relay is a different origin.
// proxyAwareFetch captures globalThis.fetch at import as its direct path, so
// stub fetch and re-import a fresh module graph.
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxyAwareFetch Vercel relay", () => {
  it("drops a caller-supplied dispatcher when forwarding to the relay", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const pinnedDispatcher = { marker: "pinned-to-target-host" };

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "manual", dispatcher: pinnedDispatcher },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe("https://relay.example.com/forward");
    expect(options.dispatcher).toBeUndefined();
    expect(options.redirect).toBe("manual");
    expect(options.headers).toEqual(
      expect.objectContaining({
        "x-relay-target": "https://example.com",
        "x-relay-path": "/image.png",
      }),
    );
  });

  it("forwards the caller's redirect mode to the relay", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "error" },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    const [, options] = fetchStub.mock.calls[0];
    expect(options.headers).toEqual(expect.objectContaining({ "x-relay-redirect": "error" }));
  });

  it("does not let a caller-supplied relay redirect header override the mode", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "error", headers: { "x-relay-redirect": "follow", "x-key": "k" } },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    const [, options] = fetchStub.mock.calls[0];
    expect(options.headers).toEqual(
      expect.objectContaining({ "x-relay-redirect": "error", "x-key": "k" }),
    );
  });

  it("strips caller x-relay-* headers in any casing and header container", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = { vercelRelayUrl: "https://relay.example.com/forward" };
    const url = "https://example.com/image.png";

    await proxyAwareFetch(
      url,
      { redirect: "error", headers: { "X-Relay-Redirect": "follow", "x-key": "k" } },
      relay,
    );
    await proxyAwareFetch(
      url,
      { redirect: "error", headers: new Headers({ "X-Relay-Target": "https://evil.test" }) },
      relay,
    );
    await proxyAwareFetch(url, { redirect: "error", headers: [["X-RELAY-PATH", "/evil"]] }, relay);

    for (const [, options] of fetchStub.mock.calls) {
      const names = Object.keys(options.headers).filter((n) => n.startsWith("x-relay-"));
      expect(names.sort()).toEqual(["x-relay-path", "x-relay-redirect", "x-relay-target"]);
      expect(options.headers["x-relay-redirect"]).toBe("error");
      expect(options.headers["x-relay-target"]).toBe("https://example.com");
      expect(options.headers["x-relay-path"]).toBe("/image.png");
    }
    expect(Object.keys(fetchStub.mock.calls[0][1].headers)).not.toContain("X-Relay-Redirect");
    expect(fetchStub.mock.calls[0][1].headers["x-key"]).toBe("k");
  });

  it("surfaces a refused redirect from the relay fetch like the proxy branches", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("unexpected redirect"),
    });
    const fetchStub = vi.fn(async () => {
      throw refused;
    });
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = { vercelRelayUrl: "https://relay.example.com/forward" };

    const err = await proxyAwareFetch("https://example.com/x", { redirect: "error" }, relay).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err.cause).toBe(refused);

    const other = await proxyAwareFetch("https://example.com/x", {}, relay).catch((e) => e);
    expect(other).toBe(refused);
  });

  it("omits the relay redirect header when no redirect mode is given", async () => {
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://example.com/image.png",
      {},
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    const [, options] = fetchStub.mock.calls[0];
    expect(options.headers).not.toHaveProperty("x-relay-redirect");
  });
});
