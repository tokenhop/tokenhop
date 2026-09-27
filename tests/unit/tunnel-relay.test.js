import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPublicUrl, parseRelayUrl } from "../../src/lib/tunnel/cloudflare/relay.js";

describe("tunnel relay (TUNNEL_WORKER_URL)", () => {
  afterEach(() => {
    delete process.env.TUNNEL_WORKER_URL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is off when unset or blank", () => {
    expect(parseRelayUrl(undefined)).toBeNull();
    expect(parseRelayUrl("")).toBeNull();
    expect(parseRelayUrl("   ")).toBeNull();
  });

  it("parses an https origin you run yourself", () => {
    expect(parseRelayUrl("https://relay.example.test/")).toEqual({
      origin: "https://relay.example.test",
      host: "relay.example.test",
    });
  });

  it("fails fast on invalid, non-https or non-origin values", () => {
    expect(() => parseRelayUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => parseRelayUrl("http://relay.example.test")).toThrow(/must use https/);
    expect(() => parseRelayUrl("https://relay.example.test/relay")).toThrow(/bare https origin/);
    expect(() => parseRelayUrl("https://user:pw@relay.example.test")).toThrow(/bare https origin/);
    expect(() => parseRelayUrl("https://relay.example.test/?x=1")).toThrow(/bare https origin/);
  });

  it("uses the direct tunnel URL when no relay is configured", () => {
    expect(
      buildPublicUrl({ shortId: "abc123", tunnelUrl: "https://x.trycloudflare.com", relay: null }),
    ).toBe("https://x.trycloudflare.com");
    expect(buildPublicUrl({ shortId: "abc123", tunnelUrl: "", relay: null })).toBe("");
  });

  it("uses the relay host when one is configured", () => {
    const relay = parseRelayUrl("https://relay.example.test");
    expect(
      buildPublicUrl({ shortId: "abc123", tunnelUrl: "https://x.trycloudflare.com", relay }),
    ).toBe("https://rabc123.relay.example.test");
  });

  it("has no relay by default", async () => {
    const { getTunnelRelay } = await import("../../src/lib/tunnel/cloudflare/config.js");
    expect(getTunnelRelay()).toBeNull();
  });

  it("reads a configured relay from TUNNEL_WORKER_URL", async () => {
    process.env.TUNNEL_WORKER_URL = "https://relay.example.test";
    const { getTunnelRelay } = await import("../../src/lib/tunnel/cloudflare/config.js");
    expect(getTunnelRelay()).toEqual({
      origin: "https://relay.example.test",
      host: "relay.example.test",
    });
  });

  it("reports an invalid TUNNEL_WORKER_URL when used, not when imported", async () => {
    process.env.TUNNEL_WORKER_URL = "http://localhost:8787";
    const config = await import("../../src/lib/tunnel/cloudflare/config.js");
    expect(() => config.getTunnelRelay()).toThrow(/must use https/);
  });

  it("never contacts a relay unless one is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { registerTunnelUrl } = await import("../../src/lib/tunnel/cloudflare/manager.js");

    await registerTunnelUrl("abc123", "https://x.trycloudflare.com", null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers with a configured relay best-effort, without throwing on failure", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registerTunnelUrl } = await import("../../src/lib/tunnel/cloudflare/manager.js");
    const relay = parseRelayUrl("https://relay.example.test");

    await expect(
      registerTunnelUrl("abc123", "https://x.trycloudflare.com", relay),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://relay.example.test/api/tunnel/register",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
