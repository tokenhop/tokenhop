/**
 * Background OAuth token-refresh scheduler.
 *
 * Covers pure selection (selectConnectionsNeedingRefresh) and a fake tick that
 * exercises checkAndRefreshToken dispatch + fail-open per connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function conn(overrides = {}) {
  return {
    id: "c1",
    provider: "grok-cli",
    authType: "oauth",
    refreshToken: "rt-1",
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    isActive: true,
    ...overrides,
  };
}

describe("selectConnectionsNeedingRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("selects oauth grok-cli connection expiring in 10 minutes", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString() })],
      NOW,
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c1");
  });

  it("skips connection expiring in 2 hours", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() })],
      NOW,
    );
    expect(list).toHaveLength(0);
  });

  it("never selects apikey connections", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({ authType: "apikey", refreshToken: "rt" }),
        conn({ id: "c2", authType: "api_key", refreshToken: "rt" }),
      ],
      NOW,
    );
    expect(list).toHaveLength(0);
  });

  it("skips oauth connection without refreshToken", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ refreshToken: null }), conn({ id: "c2", refreshToken: undefined })],
      NOW,
    );
    expect(list).toHaveLength(0);
  });

  it("selects already-expired oauth connection", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW - 60 * 1000).toISOString() })],
      NOW,
    );
    expect(list).toHaveLength(1);
  });
});

describe("runBackgroundTokenRefreshTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls refresh only for due connections and swallows per-connection errors", async () => {
    const due = conn({
      id: "due",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });
    const notDue = conn({
      id: "not-due",
      expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    });
    const apikey = conn({
      id: "key",
      authType: "apikey",
      expiresAt: new Date(NOW + 60 * 1000).toISOString(),
    });

    const refreshConnection = vi.fn(async (c) => {
      if (c.id === "due") throw new Error("boom");
      return c;
    });
    const loadConnections = vi.fn(async () => [due, notDue, apikey]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection }),
    ).resolves.toBeUndefined();

    expect(loadConnections).toHaveBeenCalledTimes(1);
    expect(refreshConnection).toHaveBeenCalledTimes(1);
    expect(refreshConnection.mock.calls[0][0].id).toBe("due");
  });

  it("does not call refresh when nothing is due", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => [
      conn({
        expiresAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({ loadConnections, refreshConnection });

    expect(refreshConnection).not.toHaveBeenCalled();
  });

  it("swallows top-level load errors", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => {
      throw new Error("db down");
    });

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection }),
    ).resolves.toBeUndefined();
    expect(refreshConnection).not.toHaveBeenCalled();
  });
});

describe("start/stop guards", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const mod = await import("../../src/sse/services/backgroundTokenRefresh.js");
    mod.stopBackgroundTokenRefresh();
    vi.resetModules();
  });

  it("honors DISABLE_BACKGROUND_TOKEN_REFRESH kill-switch", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "1");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    expect(startBackgroundTokenRefresh()).toBe(false);
    stopBackgroundTokenRefresh();
  });

  it("is idempotent: second start is no-op", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const first = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    const second = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    stopBackgroundTokenRefresh();
  });
});

describe("re-authentication state (YAN-1038)", () => {
  const flagged = () =>
    conn({
      id: "dead",
      provider: "codex",
      reauthRequired: {
        reason: "refresh_token_rejected",
        code: "refresh_token_reused",
        at: new Date(NOW).toISOString(),
      },
      expiresAt: new Date(NOW - 60 * 1000).toISOString(),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not select a due codex oauth row flagged reauthRequired", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const healthy = { ...flagged(), id: "ok", reauthRequired: undefined };
    const list = selectConnectionsNeedingRefresh([flagged(), healthy], NOW);
    expect(list.map((c) => c.id)).toEqual(["ok"]);
  });

  it("a tick never refreshes the flagged row", async () => {
    const refreshConnection = vi.fn(async (c) => c);
    const loadConnections = vi.fn(async () => [flagged()]);
    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    await runBackgroundTokenRefreshTick({ loadConnections, refreshConnection });
    expect(refreshConnection).not.toHaveBeenCalled();
  });
});

describe("expired access-token-only rows are flagged by the tick (YAN-1038 H1)", () => {
  const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  const row = (id, extra = {}) => ({
    id,
    provider: "codex",
    authType: "access_token",
    accessToken: fakeJwt({ exp: Math.floor((NOW - 3600 * 1000) / 1000) }),
    isActive: true,
    ...extra,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flags only unflagged expired access-token-only rows, with no refresh", async () => {
    const live = row("live", {
      accessToken: fakeJwt({ exp: Math.floor((NOW + 3600 * 1000) / 1000) }),
    });
    const flaggedAlready = row("flagged", {
      reauthRequired: { reason: "access_token_expired", code: "token_expired", at: "x" },
    });
    const withRt = row("with-rt", { authType: "oauth", refreshToken: "rt" });
    const flagExpired = vi.fn(async () => true);
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => [row("dead"), live, flaggedAlready, withRt]);
    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    await runBackgroundTokenRefreshTick({
      loadConnections,
      refreshConnection,
      flagExpired,
    });
    expect(flagExpired.mock.calls.map((c) => c[0].id)).toEqual(["dead"]);
    // Only the refreshable oauth row is refreshed; the flagged-only passes make no refresh call.
    expect(refreshConnection.mock.calls.map((c) => c[0].id)).toEqual(["with-rt"]);
  });

  it("a flag failure never kills the tick", async () => {
    const flagExpired = vi.fn(async () => {
      throw new Error("db down");
    });
    const refreshConnection = vi.fn(async (c) => c);
    const due = conn({ id: "due" });
    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [row("dead"), due],
      refreshConnection,
      flagExpired,
    });
    expect(refreshConnection).toHaveBeenCalledTimes(1);
  });
});
