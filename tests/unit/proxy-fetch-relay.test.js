// YAN-1577: the Vercel relay branch of proxyAwareFetch must not reuse a
// dispatcher pinned to the target host — the relay is a different origin.
// proxyAwareFetch captures globalThis.fetch at import as its direct path, so
// stub fetch and re-import a fresh module graph.
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("proxyAwareFetch Vercel relay", () => {
  const currentRelayResponse = () =>
    new Response("ok", { status: 200, headers: { "x-relay-version": "2" } });
  const probedFetch = (responseFactory = currentRelayResponse) =>
    vi.fn(async (_url, options = {}) =>
      options.headers?.["x-relay-target"]
        ? responseFactory()
        : new Response("probe", { status: 400, headers: { "x-relay-version": "2" } }),
    );

  it("rethrows a caller abort during the probe without caching a version", async () => {
    const pendingFetches = [];
    const fetchStub = vi.fn(
      () =>
        new Promise((resolve) => {
          pendingFetches.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();
    const { probeRelayVersion } = await import("../../open-sse/utils/proxyFetch.js");
    const controller = new AbortController();

    const first = probeRelayVersion("https://relay.example.com/forward", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller stopped"));
    await expect(first).rejects.toThrow("caller stopped");
    const second = probeRelayVersion("https://relay.example.com/forward", { fresh: true });
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    pendingFetches[0](new Response("probe", { status: 400 }));
    pendingFetches[1](new Response("probe", { status: 400 }));
    await expect(second).resolves.toBe(0);
  });

  it("reports a probe network failure without treating it as outdated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("relay host refused") });
      }),
    );
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const err = await proxyAwareFetch(
      "https://example.com/x",
      { redirect: "manual" },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    ).catch((e) => e);

    expect(err.message).toBe("[ProxyFetch] Relay request failed");
    expect(err.code).not.toBe("ERR_RELAY_OUTDATED");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("outdated"));
  });

  it("bounds an unresponsive probe with an internal timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => options.signal.reason),
    );
    vi.resetModules();
    const { probeRelayVersion } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(probeRelayVersion("https://relay.example.com/forward")).rejects.toMatchObject({
      message: "[ProxyFetch] Relay request failed",
    });
  });

  it("deduplicates concurrent cold-cache probes", async () => {
    let resolveProbe;
    const fetchStub = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();
    const { probeRelayVersion } = await import("../../open-sse/utils/proxyFetch.js");

    const first = probeRelayVersion("https://relay.example.com/forward");
    const second = probeRelayVersion("https://relay.example.com/forward");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    resolveProbe(new Response("probe", { status: 400, headers: { "x-relay-version": "2" } }));
    await expect(Promise.all([first, second])).resolves.toEqual([2, 2]);
  });
  it("refuses an old relay before sending the redirect-sensitive request", async () => {
    const fetchStub = vi.fn(async (_url, options = {}) => {
      if (!options.headers?.["x-relay-target"]) {
        return new Response("probe", { status: 400 });
      }
      throw new Error("real request reached the relay");
    });
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const err = await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "manual", headers: { Authorization: "Bearer caller-secret" } },
      { vercelRelayUrl: "https://relay.example.com/forward?token=relay-secret" },
    ).catch((e) => e);

    expect(err).toMatchObject({ code: "ERR_RELAY_OUTDATED" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, probeOptions] = fetchStub.mock.calls[0];
    expect(probeOptions.method).toBe("GET");
    expect(probeOptions.headers).toEqual({});
    expect(probeOptions.body).toBeUndefined();
  });

  it("caches a current probe and then sends redirect-sensitive requests", async () => {
    const fetchStub = vi.fn(async (_url, options = {}) =>
      options.headers?.["x-relay-target"]
        ? currentRelayResponse()
        : new Response("probe", { status: 400, headers: { "x-relay-version": "2" } }),
    );
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = { vercelRelayUrl: "https://relay.example.com/forward" };

    await proxyAwareFetch("https://example.com/a.png", { redirect: "manual" }, relay);
    await proxyAwareFetch("https://example.com/b.png", { redirect: "error" }, relay);

    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(fetchStub.mock.calls[0][1].method).toBe("GET");
    expect(fetchStub.mock.calls[1][1].headers["x-relay-target"]).toBe("https://example.com");
    expect(fetchStub.mock.calls[2][1].headers["x-relay-target"]).toBe("https://example.com");
  });

  it("re-probes after a short negative cache TTL", async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn(async (_url, options = {}) =>
      options.headers?.["x-relay-target"]
        ? currentRelayResponse()
        : new Response("probe", { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = { vercelRelayUrl: "https://relay.example.com/forward" };

    await expect(
      proxyAwareFetch("https://example.com/a.png", { redirect: "manual" }, relay),
    ).rejects.toMatchObject({ code: "ERR_RELAY_OUTDATED" });
    await expect(
      proxyAwareFetch("https://example.com/b.png", { redirect: "manual" }, relay),
    ).rejects.toMatchObject({ code: "ERR_RELAY_OUTDATED" });
    expect(fetchStub).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    await expect(
      proxyAwareFetch("https://example.com/c.png", { redirect: "manual" }, relay),
    ).rejects.toMatchObject({ code: "ERR_RELAY_OUTDATED" });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("hides relay network details behind the generic proxy error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options = {}) => {
        if (!options.headers?.["x-relay-target"]) {
          return new Response("probe", { status: 400, headers: { "x-relay-version": "2" } });
        }
        throw new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED relay.example.com:443"),
        });
      }),
    );
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const { mapProxyFetchError } = await import("../../open-sse/utils/proxyError.js");

    const err = await proxyAwareFetch(
      "https://example.com/x",
      { redirect: "manual" },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    ).catch((e) => e);

    expect(err.message).toBe("[ProxyFetch] Relay request failed");
    expect(err.cause?.cause?.message).toContain("relay.example.com");
    expect(mapProxyFetchError(err, "TEST").message).toBe("Upstream proxy unavailable");
  });
  it.each(["error", "manual"])(
    "refuses a relay without a current probe version for redirect %s",
    async (redirect) => {
      const fetchStub = vi.fn(async (_url, options = {}) => {
        if (!options.headers?.["x-relay-target"]) return new Response("probe", { status: 400 });
        throw new Error("real request reached the relay");
      });
      vi.stubGlobal("fetch", fetchStub);
      vi.resetModules();

      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
      const err = await proxyAwareFetch(
        "https://example.com/image.png",
        { redirect },
        { vercelRelayUrl: "https://relay.example.com/forward?token=secret" },
      ).catch((e) => e);

      expect(err).toMatchObject({ code: "ERR_RELAY_OUTDATED" });
      expect(err.message).toContain("redeployed");
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a relay probe reporting an older template version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options = {}) =>
        options.headers?.["x-relay-target"]
          ? new Response("old", { headers: { "x-relay-version": "1" } })
          : new Response("probe", { status: 400, headers: { "x-relay-version": "1" } }),
      ),
    );
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(
      proxyAwareFetch(
        "https://example.com/image.png",
        { redirect: "manual" },
        { vercelRelayUrl: "https://relay.example.com/forward" },
      ),
    ).rejects.toMatchObject({ code: "ERR_RELAY_OUTDATED" });
  });

  it.each(["error", "manual"])(
    "accepts a current relay version for redirect %s",
    async (redirect) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, options = {}) =>
          options.headers?.["x-relay-target"]
            ? new Response("ok", { headers: { "x-relay-version": "2" } })
            : new Response("probe", { status: 400, headers: { "x-relay-version": "2" } }),
        ),
      );
      vi.resetModules();
      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

      const response = await proxyAwareFetch(
        "https://example.com/image.png",
        { redirect },
        { vercelRelayUrl: "https://relay.example.com/forward" },
      );
      expect(await response.text()).toBe("ok");
    },
  );

  it.each(["follow", undefined])(
    "allows an older relay for redirect %s but warns once without URL details",
    async (redirect) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("ok")),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
      const options = redirect ? { redirect } : {};
      const relay = { vercelRelayUrl: "https://relay.example.com/forward?token=secret" };

      await proxyAwareFetch("https://example.com/image.png", options, relay);
      await proxyAwareFetch("https://example.com/other.png", options, relay);

      const relayWarnings = warn.mock.calls.filter(([message]) =>
        String(message).includes("redeployed"),
      );
      expect(relayWarnings).toHaveLength(1);
      expect(String(relayWarnings[0][0])).not.toContain("token=secret");
      expect(String(relayWarnings[0][0])).not.toContain("relay.example.com/forward");
      warn.mockRestore();
    },
  );
  it("drops a caller-supplied dispatcher when forwarding to the relay", async () => {
    const fetchStub = probedFetch();
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const pinnedDispatcher = { marker: "pinned-to-target-host" };

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "manual", dispatcher: pinnedDispatcher },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    expect(fetchStub).toHaveBeenCalledTimes(2);
    const [url, options] = fetchStub.mock.calls.at(-1);
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
    const fetchStub = probedFetch();
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "error" },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    const [, options] = fetchStub.mock.calls.at(-1);
    expect(options.headers).toEqual(expect.objectContaining({ "x-relay-redirect": "error" }));
  });

  it("does not let a caller-supplied relay redirect header override the mode", async () => {
    const fetchStub = probedFetch();
    vi.stubGlobal("fetch", fetchStub);
    vi.resetModules();

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://example.com/image.png",
      { redirect: "error", headers: { "x-relay-redirect": "follow", "x-key": "k" } },
      { vercelRelayUrl: "https://relay.example.com/forward" },
    );

    const [, options] = fetchStub.mock.calls.at(-1);
    expect(options.headers).toEqual(
      expect.objectContaining({ "x-relay-redirect": "error", "x-key": "k" }),
    );
  });

  it("strips caller x-relay-* headers in any casing and header container", async () => {
    const fetchStub = probedFetch();
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
      { redirect: "error", headers: new Headers({ "X-Relay-Target": "https://other.test" }) },
      relay,
    );
    await proxyAwareFetch(url, { redirect: "error", headers: [["X-RELAY-PATH", "/other"]] }, relay);

    for (const [, options] of fetchStub.mock.calls.filter(
      ([, o]) => o.headers?.["x-relay-target"],
    )) {
      const names = Object.keys(options.headers).filter((n) => n.startsWith("x-relay-"));
      expect(names.sort()).toEqual(["x-relay-path", "x-relay-redirect", "x-relay-target"]);
      expect(options.headers["x-relay-redirect"]).toBe("error");
      expect(options.headers["x-relay-target"]).toBe("https://example.com");
      expect(options.headers["x-relay-path"]).toBe("/image.png");
    }
    const xKeyForward = fetchStub.mock.calls.find(
      ([, options]) => options.headers?.["x-relay-target"] && options.headers?.["x-key"],
    );
    expect(Object.keys(xKeyForward[1].headers)).not.toContain("X-Relay-Redirect");
    expect(xKeyForward[1].headers["x-key"]).toBe("k");
  });

  it("surfaces a refused redirect from the relay fetch like the proxy branches", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("unexpected redirect"),
    });
    const fetchStub = vi.fn(async (_url, options = {}) => {
      if (!options.headers?.["x-relay-target"]) {
        return new Response("probe", { status: 400, headers: { "x-relay-version": "2" } });
      }
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
    expect(other.message).toBe("[ProxyFetch] Relay request failed");
    expect(other.cause).toBe(refused);
  });

  it("omits the relay redirect header when no redirect mode is given", async () => {
    const fetchStub = vi.fn(currentRelayResponse);
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
  it("refuses a relay without a current version header before observing redirect behavior", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("found", { status: 200 })),
    );
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(
      proxyAwareFetch(
        "https://example.com/x",
        { redirect: "error" },
        { vercelRelayUrl: "https://relay.example.com/forward" },
      ),
    ).rejects.toMatchObject({ code: "ERR_RELAY_OUTDATED" });
  });
});
