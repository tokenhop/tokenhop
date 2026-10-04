import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyFetch }));

let savedVersion;
beforeEach(() => {
  savedVersion = process.env.GROK_CLI_VERSION;
  process.env.GROK_CLI_VERSION = "9.8.7";
  vi.resetModules();
  proxyFetch.mockReset();
});
afterEach(() => {
  if (savedVersion === undefined) delete process.env.GROK_CLI_VERSION;
  else process.env.GROK_CLI_VERSION = savedVersion;
});

const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });

describe("dedicated Grok CLI refresh", () => {
  it("shares canonical alias dedup, auth fingerprint, selected proxy and rotation contract", async () => {
    const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");
    const { PROVIDER_OAUTH } = await import("../../open-sse/config/providers.js");
    let resolve;
    proxyFetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080" };
    const credentials = { refreshToken: "old-refresh" };
    const first = refreshTokenByProvider("grok-cli", credentials, log(), proxy);
    const second = refreshTokenByProvider("gcli", credentials, log(), proxy);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [url, options, passedProxy] = proxyFetch.mock.calls[0];
    expect(url).toBe(PROVIDER_OAUTH["grok-cli"].tokenUrl);
    expect(passedProxy).toBe(proxy);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      "User-Agent": "grok-shell/9.8.7 (linux; x86_64)",
      "x-grok-client-version": "9.8.7",
      "x-grok-client-surface": "headless",
    });
    expect(Object.fromEntries(options.body)).toEqual({
      grant_type: "refresh_token",
      client_id: PROVIDER_OAUTH["grok-cli"].clientId,
      refresh_token: "old-refresh",
    });
    resolve(
      Response.json({
        access_token: "new-access",
        refresh_token: "rotated",
        expires_in: 2400,
        id_token: "new-id",
      }),
    );
    const expected = {
      accessToken: "new-access",
      refreshToken: "rotated",
      expiresIn: 2400,
      idToken: "new-id",
    };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
  });

  it("retains old refresh token and merges expiry/idToken through credential manager", async () => {
    const { refreshProviderCredentials } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    proxyFetch.mockResolvedValue(
      Response.json({ access_token: "new-access", expires_in: 2400, id_token: "new-id" }),
    );
    const before = Date.now();
    const refreshed = await refreshProviderCredentials(
      "grok-cli",
      { refreshToken: "old-refresh", idToken: "old-id" },
      log(),
    );
    expect(refreshed).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      expiresIn: 2400,
      idToken: "new-id",
    });
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThanOrEqual(before + 2400 * 1000);
    expect(Date.parse(refreshed.lastRefreshAt)).toBeGreaterThanOrEqual(before);
  });

  it.each(["invalid_grant", "invalid_request"])(
    "classifies %s permanently without logging secrets",
    async (error) => {
      const { refreshGrokCliToken } = await import(
        "../../open-sse/services/tokenRefresh/providers.js"
      );
      const logger = log();
      proxyFetch.mockResolvedValue(
        Response.json(
          { error, access_token: "secret-access", refresh_token: "secret-refresh" },
          { status: 400 },
        ),
      );
      expect(await refreshGrokCliToken("secret-refresh", logger)).toEqual({
        error: "invalid_grant",
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
    },
  );

  it("treats 5xx bodies mentioning invalid_grant as transient", async () => {
    const { refreshGrokCliToken } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );
    const logger = log();
    proxyFetch.mockResolvedValue(
      Response.json({ error: "invalid_grant", access_token: "secret" }, { status: 503 }),
    );
    expect(await refreshGrokCliToken("secret-refresh", logger)).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });

  it.each([
    [
      "server error",
      () => Response.json({ error: "server_error", access_token: "secret" }, { status: 503 }),
    ],
    ["malformed JSON", () => new Response("secret malformed")],
    ["missing access", () => Response.json({ refresh_token: "secret" })],
    ["non-string access", () => Response.json({ access_token: {} })],
    ["blank access", () => Response.json({ access_token: " " })],
  ])("returns null for %s without logging response bodies", async (_name, response) => {
    const { refreshGrokCliToken } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );
    const logger = log();
    proxyFetch.mockResolvedValue(response());
    expect(await refreshGrokCliToken("secret-refresh", logger)).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });

  it("returns null on transport error without logging exception secrets; skips missing token", async () => {
    const { refreshGrokCliToken } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );
    const logger = log();
    expect(await refreshGrokCliToken(null, logger)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
    proxyFetch.mockRejectedValue(new Error("secret-refresh transport failure"));
    expect(await refreshGrokCliToken("secret-refresh", logger)).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });
});
