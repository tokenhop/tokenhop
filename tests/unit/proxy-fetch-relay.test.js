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
});
