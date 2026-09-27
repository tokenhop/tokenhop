import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPublicUrl, parseRelayUrl } from "../../src/lib/tunnel/cloudflare/relay.js";

describe("tunnel relay (TUNNEL_WORKER_URL)", () => {
  afterEach(() => {
    delete process.env.TUNNEL_WORKER_URL;
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

  it("fails fast on invalid or non-https values", () => {
    expect(() => parseRelayUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => parseRelayUrl("http://relay.example.test")).toThrow(/must use https/);
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
    delete process.env.TUNNEL_WORKER_URL;
    const { TUNNEL_RELAY } = await import("../../src/lib/tunnel/cloudflare/config.js");
    expect(TUNNEL_RELAY).toBeNull();
  });
});
