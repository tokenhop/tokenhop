// GROK_CLI_VERSION env override (open-sse/config/grokCli.js) flows into the grok-cli
// registry headers and the auth.x.ai device-code request; malformed fails fast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let saved;
beforeEach(() => {
  saved = process.env.GROK_CLI_VERSION;
  delete process.env.GROK_CLI_VERSION;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.GROK_CLI_VERSION;
  else process.env.GROK_CLI_VERSION = saved;
});

describe("GROK_CLI_VERSION", () => {
  it("overrides the registry fingerprint", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    const cfg = PROVIDERS["grok-cli"];
    expect(cfg.clientVersion).toBe("9.8.7");
    expect(cfg.headers["x-grok-client-version"]).toBe("9.8.7");
    expect(cfg.headers["User-Agent"]).toBe("grok-shell/9.8.7 (linux; x86_64)");
  });

  it("overrides the OAuth device-code request headers", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    const fetchMock = vi.fn(async () => Response.json({ device_code: "dc" }));
    vi.stubGlobal("fetch", fetchMock);
    const { default: grokCli } = await import("@/lib/oauth/providers/grok-cli.js");
    await grokCli.requestDeviceCode({
      deviceCodeUrl: "https://auth.x.ai/device",
      clientId: "id",
      scope: "openid",
    });
    const { headers } = fetchMock.mock.calls[0][1];
    expect(headers["User-Agent"]).toBe("grok-shell/9.8.7 (linux; x86_64)");
    expect(headers["x-grok-client-version"]).toBe("9.8.7");
  });

  it("fails fast on a malformed value", async () => {
    process.env.GROK_CLI_VERSION = "v1.0";
    await expect(import("open-sse/config/grokCli.js")).rejects.toThrow(/Invalid GROK_CLI_VERSION/);
  });
});
