/**
 * Unit tests for Codex (OpenAI) refresh token mechanism
 *
 * Verifies that:
 * - Early refresh lead times are configured per provider (synced with CLIProxyAPI)
 * - New refresh_token from response is persisted (token rotation)
 * - Falls back to old refresh_token when server doesn't return new one
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

describe("Codex Refresh Token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchWithJson(payload) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });
    global.fetch = fetchMock;
    return fetchMock;
  }

  describe("refreshCodexToken", () => {
    it("should return new refresh_token when server provides one (token rotation)", async () => {
      const fetchMock = mockFetchWithJson({
        access_token: "new-access",
        refresh_token: "rotated-refresh-token",
        id_token: "new-id-token",
        expires_in: 3600,
      });

      const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.js");
      const result = await refreshCodexToken("old-refresh-token", null);

      expect(result.refreshToken).toBe("rotated-refresh-token");
      expect(result.accessToken).toBe("new-access");
      expect(result.idToken).toBe("new-id-token");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.openai.com/oauth/token",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "application/json",
          }),
          body: JSON.stringify({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            grant_type: "refresh_token",
            refresh_token: "old-refresh-token",
          }),
        }),
      );
    });

    it("should keep old refresh_token when server does not return new one", async () => {
      mockFetchWithJson({
        access_token: "new-access",
        expires_in: 3600,
      });

      const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.js");
      const result = await refreshCodexToken("old-refresh-token-without-rotation", null);

      expect(result.refreshToken).toBe("old-refresh-token-without-rotation");
    });
  });

  describe("CodexExecutor credential lifecycle", () => {
    it("should refresh Codex credentials and preserve omitted id_token", async () => {
      mockFetchWithJson({
        access_token: "new-access",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });

      const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
      const executor = new CodexExecutor();
      const result = await executor.refreshCredentials(
        {
          connectionId: "codex-1",
          refreshToken: "old-refresh-token",
          idToken: "old-id-token",
        },
        null,
      );

      expect(result.accessToken).toBe("new-access");
      expect(result.refreshToken).toBe("rotated-refresh-token");
      expect(result.idToken).toBe("old-id-token");
      expect(result.lastRefreshAt).toBeTruthy();
      expect(result.expiresAt).toBeTruthy();
    });

    it("should refresh Codex when lastRefreshAt is older than the upstream stale window", async () => {
      const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
      const executor = new CodexExecutor();
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const staleRefresh = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
      const recentRefresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

      expect(
        executor.needsRefresh({
          refreshToken: "refresh-token",
          expiresAt: farFuture,
          lastRefreshAt: staleRefresh,
        }),
      ).toBe(true);

      expect(
        executor.needsRefresh({
          refreshToken: "refresh-token",
          expiresAt: farFuture,
          lastRefreshAt: recentRefresh,
        }),
      ).toBe(false);
    });

    it("should de-duplicate concurrent refreshes for the same Codex connection", async () => {
      const fetchMock = mockFetchWithJson({
        access_token: "new-access",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });

      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const credentials = {
        connectionId: "codex-single-flight",
        refreshToken: "old-refresh-token",
      };

      const [first, second] = await Promise.all([
        refreshProviderCredentials("codex", credentials, null),
        refreshProviderCredentials("codex", credentials, null),
      ]);

      expect(first.accessToken).toBe("new-access");
      expect(second.accessToken).toBe("new-access");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("CodexExecutor.canRefreshCredentials (YAN-1038)", () => {
    it("only allows refresh when a refresh token is present", async () => {
      const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
      const executor = new CodexExecutor();
      expect(executor.canRefreshCredentials({ refreshToken: "x" })).toBe(true);
      expect(executor.canRefreshCredentials({ accessToken: "a" })).toBe(false);
      expect(executor.canRefreshCredentials(null)).toBe(false);
    });
  });

  describe("classifyOAuthRefreshError (YAN-1038)", () => {
    it("treats a 4xx permanent marker as permanent", async () => {
      const { classifyOAuthRefreshError } = await import(
        "../../open-sse/services/tokenRefresh/providers.js"
      );
      expect(classifyOAuthRefreshError('{"error":"refresh_token_reused"}', 400).permanent).toBe(
        true,
      );
      expect(classifyOAuthRefreshError('{"error":"invalid_grant"}', 401).permanent).toBe(true);
    });

    it("never treats a 5xx as permanent even when the body mentions invalid_grant", async () => {
      const { classifyOAuthRefreshError } = await import(
        "../../open-sse/services/tokenRefresh/providers.js"
      );
      expect(classifyOAuthRefreshError('{"error":"invalid_grant"}', 500).permanent).toBe(false);
      expect(classifyOAuthRefreshError("invalid_grant", 503).permanent).toBe(false);
    });

    it("treats only 400/401/403 as permanent; 408 and 429 are transient", async () => {
      const { classifyOAuthRefreshError } = await import(
        "../../open-sse/services/tokenRefresh/providers.js"
      );
      const body = '{"error":"invalid_grant"}';
      for (const status of [400, 401, 403]) {
        expect(classifyOAuthRefreshError(body, status).permanent).toBe(true);
      }
      for (const status of [408, 429, 404, 500]) {
        expect(classifyOAuthRefreshError(body, status).permanent).toBe(false);
      }
    });

    it("keeps unknown status (0) backward compatible", async () => {
      const { classifyOAuthRefreshError } = await import(
        "../../open-sse/services/tokenRefresh/providers.js"
      );
      expect(classifyOAuthRefreshError("refresh_token_expired").permanent).toBe(true);
    });
  });

  describe("refreshProviderCredentials with a credential store (YAN-1037)", () => {
    const NOW = Date.parse("2026-08-01T12:00:00.000Z");
    const HOUR = 3600 * 1000;
    const fakeJwt = (payload) =>
      `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
    const jwtExpiringIn = (ms, extra = {}) =>
      fakeJwt({ exp: Math.floor((NOW + ms) / 1000), iat: Math.floor(NOW / 1000), ...extra });

    let setCredentialStore;

    /** In-memory store recording call order. */
    function makeStore(initial) {
      const state = { row: initial ? { ...initial } : null };
      const calls = [];
      const store = {
        state,
        calls,
        load: vi.fn(async (id) => {
          calls.push(["load", id]);
          return state.row ? { ...state.row } : null;
        }),
        persistRefresh: vi.fn(async (id, { expectedRefreshToken, credentials }) => {
          calls.push(["persistRefresh", id]);
          if (
            state.row &&
            state.row.refreshToken !== expectedRefreshToken &&
            state.row.refreshToken !== credentials.refreshToken
          ) {
            return { applied: false };
          }
          state.row = { ...(state.row || {}), ...credentials };
          return { applied: true };
        }),
        markReauthRequired: vi.fn(async (id, { expectedRefreshToken, reauthRequired }) => {
          calls.push(["markReauthRequired", id]);
          if (state.row && state.row.refreshToken !== expectedRefreshToken) {
            return { applied: false };
          }
          state.row = { ...(state.row || {}), reauthRequired };
          return { applied: true };
        }),
      };
      return store;
    }

    function tokenResponse(accessToken, refreshToken) {
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
          }),
      };
    }

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      ({ setCredentialStore } = await import("../../open-sse/services/credentialStore.js"));
      setCredentialStore(null);
    });

    afterEach(() => {
      setCredentialStore?.(null);
      vi.useRealTimers();
    });

    it("rotates once for a second stale-snapshot request after the dedup window", async () => {
      const newAt = jwtExpiringIn(HOUR, { n: "new" });
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse(newAt, "rt-1"));
      global.fetch = fetchMock;
      const store = makeStore({
        accessToken: "old-at",
        refreshToken: "rt-0",
        providerSpecificData: { workspaceId: "w" },
      });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const snapshot = { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" };

      const first = await refreshProviderCredentials("codex", { ...snapshot }, null);
      expect(first.accessToken).toBe(newAt);
      expect(first.refreshToken).toBe("rt-1");
      // persisted before the first promise resolved
      expect(store.persistRefresh).toHaveBeenCalledTimes(1);
      expect(store.state.row.refreshToken).toBe("rt-1");

      vi.setSystemTime(NOW + 11_000);
      const second = await refreshProviderCredentials("codex", { ...snapshot }, null);
      expect(second.accessToken).toBe(newAt);
      expect(second.refreshToken).toBe("rt-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.state.row.refreshToken).toBe("rt-1");
    });

    it("persists inside the lock before the refresh promise resolves", async () => {
      global.fetch = vi.fn().mockResolvedValue(tokenResponse(jwtExpiringIn(HOUR), "rt-1"));
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      let resolved = false;
      const p = refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" },
        null,
      ).then((r) => {
        resolved = true;
        return r;
      });
      await vi.waitFor(() => expect(store.persistRefresh).toHaveBeenCalled());
      await p;
      expect(resolved).toBe(true);
      expect(store.persistRefresh.mock.calls[0][1].expectedRefreshToken).toBe("rt-0");
      const persisted = store.persistRefresh.mock.calls[0][1].credentials;
      expect(persisted.providerSpecificData).toBeUndefined();
    });

    it("single-flights concurrent same-snapshot requests with a store installed", async () => {
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse(jwtExpiringIn(HOUR), "rt-1"));
      global.fetch = fetchMock;
      setCredentialStore(makeStore({ accessToken: "old-at", refreshToken: "rt-0" }));
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const snap = { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" };
      const [a, b] = await Promise.all([
        refreshProviderCredentials("codex", { ...snap }, null),
        refreshProviderCredentials("codex", { ...snap }, null),
      ]);
      expect(a.accessToken).toBe(b.accessToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("adopts credentials rotated by another process without a network call", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;
      const storedAt = jwtExpiringIn(HOUR);
      const lastRefreshAt = new Date(NOW - 60_000).toISOString();
      setCredentialStore(
        makeStore({
          accessToken: storedAt,
          refreshToken: "rt-rotated",
          expiresAt: new Date(NOW + HOUR).toISOString(),
          lastRefreshAt,
          providerSpecificData: { secret: "x" },
        }),
      );
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "stale-at", refreshToken: "rt-stale" },
        null,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.accessToken).toBe(storedAt);
      expect(result.refreshToken).toBe("rt-rotated");
      expect(result.lastRefreshAt).toBe(lastRefreshAt);
      expect(result.providerSpecificData).toBeUndefined();
    });

    it("redeems the STORED refresh token when its access token is nearly expired", async () => {
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse(jwtExpiringIn(HOUR), "rt-new"));
      global.fetch = fetchMock;
      setCredentialStore(
        makeStore({
          accessToken: jwtExpiringIn(2 * 60 * 1000),
          refreshToken: "rt-stored",
          expiresAt: new Date(NOW + 2 * 60 * 1000).toISOString(),
        }),
      );
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "stale-at", refreshToken: "rt-snapshot" },
        null,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).refresh_token).toBe("rt-stored");
      expect(result.refreshToken).toBe("rt-new");
    });

    it("marks a dead refresh token once, then short-circuits without a network call", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"refresh_token_reused"}'),
      });
      global.fetch = fetchMock;
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const snap = { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" };

      const first = await refreshProviderCredentials("codex", { ...snap }, null);
      expect(first).toMatchObject({ error: "unrecoverable_refresh_error" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.markReauthRequired).toHaveBeenCalledTimes(1);
      const [id, args] = store.markReauthRequired.mock.calls[0];
      expect(id).toBe("c1");
      expect(args.expectedRefreshToken).toBe("rt-0");
      expect(args.reauthRequired).toMatchObject({
        reason: "refresh_token_rejected",
        code: "refresh_token_reused",
      });

      vi.setSystemTime(NOW + 60_000);
      const second = await refreshProviderCredentials("codex", { ...snap }, null);
      expect(second).toMatchObject({ error: "unrecoverable_refresh_error" });
      expect(second.code).toBe("refresh_token_reused");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns the stored newer tokens when persistRefresh reports applied:false (M1)", async () => {
      const mergedAt = jwtExpiringIn(HOUR, { n: "merged" });
      const storedAt = jwtExpiringIn(2 * HOUR, { n: "stored" });
      global.fetch = vi.fn().mockResolvedValue(tokenResponse(mergedAt, "rt-merged"));
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      store.persistRefresh.mockImplementation(async () => {
        // live row moved on (re-login / other rotation) before the write
        store.state.row = {
          accessToken: storedAt,
          refreshToken: "rt-newer",
          expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
          lastRefreshAt: new Date(NOW - 1000).toISOString(),
        };
        return { applied: false };
      });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" },
        null,
      );
      expect(result.accessToken).toBe(storedAt);
      expect(result.refreshToken).toBe("rt-newer");
      expect(result.providerSpecificData).toBeUndefined();
    });

    it("returns null when persistRefresh is not applied and the stored token is unusable (M1)", async () => {
      global.fetch = vi.fn().mockResolvedValue(tokenResponse(jwtExpiringIn(HOUR), "rt-merged"));
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      store.persistRefresh.mockImplementation(async () => {
        store.state.row = { accessToken: "opaque", refreshToken: "rt-newer" };
        return { applied: false };
      });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" },
        null,
      );
      expect(result).toBeNull();
    });

    it("short-circuits a flagged stored row even when the snapshot RT differs (M2)", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;
      setCredentialStore(
        makeStore({
          accessToken: "dead-at",
          refreshToken: "rt-1",
          reauthRequired: {
            reason: "refresh_token_rejected",
            code: "refresh_token_reused",
            at: new Date(NOW).toISOString(),
          },
        }),
      );
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "stale-at", refreshToken: "rt-0" },
        null,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error: "unrecoverable_refresh_error",
        code: "refresh_token_reused",
      });
    });

    it("does not flag or fail permanently on a 5xx that mentions invalid_grant", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      });
      global.fetch = fetchMock;
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" },
        null,
      );
      expect(result).toBeNull();
      expect(store.markReauthRequired).not.toHaveBeenCalled();
      expect(store.persistRefresh).not.toHaveBeenCalled();
    });

    it("fails open when store.load throws, and when persistRefresh throws", async () => {
      const newAt = jwtExpiringIn(HOUR);
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse(newAt, "rt-1"));
      global.fetch = fetchMock;
      const store = makeStore({ accessToken: "old-at", refreshToken: "rt-0" });
      store.load.mockRejectedValue(new Error("db down"));
      store.persistRefresh.mockRejectedValue(new Error("db down"));
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      const result = await refreshProviderCredentials(
        "codex",
        { connectionId: "c1", accessToken: "old-at", refreshToken: "rt-0" },
        null,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).refresh_token).toBe("rt-0");
      expect(result.accessToken).toBe(newAt);
      expect(result.refreshToken).toBe("rt-1");
    });

    it("never touches the store for providers without rotatingRefreshToken", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "kimi-at", expires_in: 3600 }),
      });
      const store = makeStore({ accessToken: "a", refreshToken: "r" });
      setCredentialStore(store);
      const { refreshProviderCredentials } = await import(
        "../../open-sse/services/oauthCredentialManager.js"
      );
      await refreshProviderCredentials(
        "kimi",
        { connectionId: "k1", accessToken: "a", refreshToken: "r" },
        null,
      );
      expect(store.load).not.toHaveBeenCalled();
      expect(store.persistRefresh).not.toHaveBeenCalled();
      expect(store.markReauthRequired).not.toHaveBeenCalled();
    });
  });

  describe("getRefreshLeadMs (early refresh config)", () => {
    it("should return provider-specific lead time for OAuth providers", async () => {
      const { getRefreshLeadMs } = await import("../../open-sse/services/tokenRefresh.js");

      // Synced with CLIProxyAPI refresh_registry
      expect(getRefreshLeadMs("codex")).toBe(5 * 24 * 60 * 60 * 1000); // 5 days
      expect(getRefreshLeadMs("claude")).toBe(4 * 60 * 60 * 1000); // 4 hours
      expect(getRefreshLeadMs("iflow")).toBe(24 * 60 * 60 * 1000); // 24 hours
      expect(getRefreshLeadMs("kimi")).toBe(5 * 60 * 1000); // 5 minutes
      expect(getRefreshLeadMs("kimi-coding")).toBe(5 * 60 * 1000); // legacy alias
      expect(getRefreshLeadMs("antigravity")).toBe(5 * 60 * 1000); // 5 minutes
    });

    it("should fallback to default buffer for unknown providers", async () => {
      const { getRefreshLeadMs, TOKEN_EXPIRY_BUFFER_MS } = await import(
        "../../open-sse/services/tokenRefresh.js"
      );

      expect(getRefreshLeadMs("unknown-provider")).toBe(TOKEN_EXPIRY_BUFFER_MS);
      expect(getRefreshLeadMs("openai")).toBe(TOKEN_EXPIRY_BUFFER_MS);
    });

    it("codex lead should be greater than default buffer", async () => {
      const { getRefreshLeadMs, TOKEN_EXPIRY_BUFFER_MS } = await import(
        "../../open-sse/services/tokenRefresh.js"
      );

      expect(getRefreshLeadMs("codex")).toBeGreaterThan(TOKEN_EXPIRY_BUFFER_MS);
    });
  });
});
