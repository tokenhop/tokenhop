/**
 * Generic OAuth2 token refresh — config-driven profiles.
 *
 * Verifies refreshAccessToken() handles the 4 foldable providers
 * (iflow, github, kimi, claude) via a REFRESH_PROFILES table,
 * while preserving the legacy generic path for unknown providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function mockFetchOnce(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

describe("refreshAccessToken — config-driven profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("iflow: Basic Auth header from clientId:clientSecret, form body keeps client_secret", async () => {
    const fm = mockFetchOnce({ access_token: "if-acc", refresh_token: "if-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("iflow", "if-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Authorization"]).toMatch(/^Basic /);
    const body = new URLSearchParams(init.body);
    expect(body.get("client_id")).toBeTruthy();
    expect(body.get("client_secret")).toBeTruthy();
  });

  it("github: omits client_secret when config has none", async () => {
    const fm = mockFetchOnce({ access_token: "gh-acc", expires_in: 28800 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const out = await refreshAccessToken("github", "gh-old", {}, console);

    const body = new URLSearchParams(fm.mock.calls[0][1].body);
    expect(body.get("client_secret")).toBeNull();
    expect(out.accessToken).toBe("gh-acc");
    expect(out.refreshToken).toBe("gh-old");
  });

  it("kimi: merges X-Msh-* headers from credentials.providerSpecificData.deviceId", async () => {
    const fm = mockFetchOnce({ access_token: "km-acc", expires_in: 86400 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken(
      "kimi",
      "km-old",
      {
        providerSpecificData: { deviceId: "dev-xyz" },
      },
      console,
    );

    const headers = fm.mock.calls[0][1].headers;
    // Kimi's buildKimiHeaders must contribute at least one X-Msh- header
    const mshKeys = Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-msh-"));
    expect(mshKeys.length).toBeGreaterThan(0);
  });

  it("claude: JSON body, client_id only (no client_secret)", async () => {
    const fm = mockFetchOnce({ access_token: "cl-acc", refresh_token: "cl-rot", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");

    await refreshAccessToken("claude", "cl-old", {}, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body);
    expect(parsed.grant_type).toBe("refresh_token");
    expect(parsed.client_id).toBeTruthy();
    expect(parsed).not.toHaveProperty("client_secret");
  });

  it("returns null on non-ok response", async () => {
    mockFetchOnce({ error: "invalid_grant" }, { ok: false, status: 400 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "dead", {}, console);
    expect(out).toBeNull();
  });

  it("returns null when refreshToken missing", async () => {
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const out = await refreshAccessToken("iflow", "", {}, console);
    expect(out).toBeNull();
  });

  it("dedupes concurrent calls with same refresh token (same dedupKey)", async () => {
    const fm = mockFetchOnce({ access_token: "dd-acc", expires_in: 3600 });
    const { refreshAccessToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const creds = { providerSpecificData: { deviceId: "d" } };
    await Promise.all([
      refreshAccessToken("kimi", "dup-refresh", creds, console),
      refreshAccessToken("kimi", "dup-refresh", creds, console),
    ]);
    expect(fm).toHaveBeenCalledTimes(1);
  });
});
describe("Cline refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses the extension JSON refresh contract", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const fm = mockFetchOnce({
      data: {
        accessToken: "cline-acc",
        refreshToken: "cline-rot",
        expiresAt,
      },
    });
    const { refreshTokenByProvider } = await import("open-sse/services/tokenRefresh.js");

    const out = await refreshTokenByProvider("cline", { refreshToken: "cline-old" }, console);

    const [, init] = fm.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      refreshToken: "cline-old",
      grantType: "refresh_token",
      clientType: "extension",
    });
    expect(out.accessToken).toBe("cline-acc");
    expect(out.refreshToken).toBe("cline-rot");
    expect(out.expiresIn).toBeGreaterThan(0);
  });
});

// YAN-365 C8: durable refresh persistence through the encrypted repo seam.
describe("updateProviderCredentials — delta refresh persistence", () => {
  const mockRepo = (impl) => {
    vi.resetModules();
    const update = vi.fn(impl);
    vi.doMock("../../src/lib/localDb.js", () => ({ updateProviderConnectionUnscoped: update }));
    return update;
  };

  afterEach(() => {
    vi.doUnmock("../../src/lib/localDb.js");
  });

  it("persists a minted apiKey and only the PSD delta (no stale snapshot)", async () => {
    const update = mockRepo(async () => ({ id: "c1" }));
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh.js");
    const ok = await updateProviderCredentials("c1", {
      apiKey: "minted-key",
      accessToken: "at",
      providerSpecificData: { copilotToken: "cp" },
      existingProviderSpecificData: { stale: "snapshot", clientSecret: "old" },
    });
    expect(ok).toBe(true);
    const [, patch] = update.mock.calls[0];
    expect(patch.apiKey).toBe("minted-key");
    expect(patch.providerSpecificData).toEqual({ copilotToken: "cp" });
  });

  it("copilot/kiro nested refresh stays a delta", async () => {
    const update = mockRepo(async () => ({ id: "c2" }));
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh.js");
    await updateProviderCredentials("c2", {
      copilotToken: "cp2",
      copilotTokenExpiresAt: 123,
      existingProviderSpecificData: { stale: true },
    });
    expect(update.mock.calls[0][1].providerSpecificData).toEqual({
      copilotToken: "cp2",
      copilotTokenExpiresAt: 123,
    });
  });

  it("proactive Copilot refresh sends only the two Copilot keys, merging siblings in memory", async () => {
    const update = mockRepo(async () => ({ id: "github-1" }));
    vi.doMock("open-sse/services/oauthCredentialManager.js", () => ({
      shouldRefreshCredentials: () => false,
      refreshProviderCredentials: vi.fn(),
    }));
    vi.doMock("open-sse/services/tokenRefresh.js", async (importOriginal) => ({
      ...(await importOriginal()),
      refreshCopilotToken: vi.fn(async () => ({ token: "cp-new", expiresAt: 12345 })),
    }));
    try {
      const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");
      const creds = await checkAndRefreshToken("github", {
        connectionId: "github-1",
        accessToken: "gh-at",
        providerSpecificData: {
          stale: "snapshot",
          copilotToken: "cp-old",
          copilotTokenExpiresAt: 1,
        },
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][1].providerSpecificData).toEqual({
        copilotToken: "cp-new",
        copilotTokenExpiresAt: 12345,
      });
      expect(creds.providerSpecificData).toEqual({
        stale: "snapshot",
        copilotToken: "cp-new",
        copilotTokenExpiresAt: 12345,
      });
    } finally {
      vi.doUnmock("open-sse/services/oauthCredentialManager.js");
      vi.doUnmock("open-sse/services/tokenRefresh.js");
    }
  });

  it("typed integrity/storage failures propagate instead of reporting success", async () => {
    mockRepo(async () => {
      throw Object.assign(new Error("boom"), { code: "DECRYPT_FAILED" });
    });
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh.js");
    await expect(updateProviderCredentials("c3", { accessToken: "x" })).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });

  it("untyped failures keep the legacy false result", async () => {
    mockRepo(async () => {
      throw new Error("plain");
    });
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh.js");
    expect(await updateProviderCredentials("c4", { accessToken: "x" })).toBe(false);
  });
});
