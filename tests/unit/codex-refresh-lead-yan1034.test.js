// YAN-1034: the Codex refresh lead scales with the token's real lifetime and
// proactive refreshes are rate-limited, so a 1h token refreshes about once per
// lifetime instead of on every request / every 5-minute background tick.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

/** Credentials as stored: token issued `ageMs` ago with `lifetimeMs` total lifetime. */
function creds(lifetimeMs, ageMs, over = {}) {
  const issued = NOW - ageMs;
  return {
    connectionId: "c1",
    refreshToken: "rt",
    accessToken: fakeJwt({
      iat: Math.floor(issued / 1000),
      exp: Math.floor((issued + lifetimeMs) / 1000),
    }),
    expiresAt: new Date(issued + lifetimeMs).toISOString(),
    lastRefreshAt: new Date(issued).toISOString(),
    ...over,
  };
}

let mgr;
let bg;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  mgr = await import("../../open-sse/services/oauthCredentialManager.js");
  bg = await import("../../src/sse/services/backgroundTokenRefresh.js");
});
const originalFetch = global.fetch;
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
});

describe("getEffectiveRefreshLeadMs (codex)", () => {
  it("10-day token keeps the declared 5-day lead", () => {
    expect(mgr.getEffectiveRefreshLeadMs("codex", creds(10 * DAY, DAY), NOW)).toBe(5 * DAY);
  });

  it("24h token: half of its lifetime (12h)", () => {
    expect(mgr.getEffectiveRefreshLeadMs("codex", creds(DAY, HOUR), NOW)).toBe(12 * HOUR);
  });

  it("1h token: 30 min, floored at 5 min for very short ones", () => {
    expect(mgr.getEffectiveRefreshLeadMs("codex", creds(HOUR, 0), NOW)).toBe(30 * MIN);
    expect(mgr.getEffectiveRefreshLeadMs("codex", creds(8 * MIN, 0), NOW)).toBe(5 * MIN);
  });

  it("unknown lifetime falls back to the declared lead", () => {
    expect(mgr.getEffectiveRefreshLeadMs("codex", { refreshToken: "rt" }, NOW)).toBe(5 * DAY);
  });

  it("other providers keep their declared lead untouched", () => {
    const c = creds(HOUR, 0);
    expect(mgr.getEffectiveRefreshLeadMs("claude", c, NOW)).toBe(4 * HOUR);
    expect(mgr.getEffectiveRefreshLeadMs("kimi", c, NOW)).toBe(5 * MIN);
  });
});

describe("shouldRefreshCredentials (codex)", () => {
  it("10-day token behaves as before: due inside 5 days, not before", () => {
    expect(mgr.shouldRefreshCredentials("codex", creds(10 * DAY, 6 * DAY), NOW)).toBe(true);
    expect(mgr.shouldRefreshCredentials("codex", creds(10 * DAY, 4 * DAY), NOW)).toBe(false);
  });

  it("1h token is not due fresh, is due in the last half hour", () => {
    expect(mgr.shouldRefreshCredentials("codex", creds(HOUR, 10 * MIN), NOW)).toBe(false);
    expect(mgr.shouldRefreshCredentials("codex", creds(HOUR, 40 * MIN), NOW)).toBe(true);
  });

  it("24h token is not due after 2h, is due after 13h", () => {
    expect(mgr.shouldRefreshCredentials("codex", creds(DAY, 2 * HOUR), NOW)).toBe(false);
    expect(mgr.shouldRefreshCredentials("codex", creds(DAY, 13 * HOUR), NOW)).toBe(true);
  });

  it("a 1h token is not refreshed per request: one refresh per lifetime", () => {
    // Walk a 1h token through a request every minute, refreshing when due.
    let c = creds(HOUR, 0);
    let refreshes = 0;
    for (let t = 0; t < 3 * 60; t++) {
      const now = NOW + t * MIN;
      if (mgr.shouldRefreshCredentials("codex", c, now)) {
        refreshes++;
        c = {
          ...c,
          accessToken: fakeJwt({
            iat: Math.floor(now / 1000),
            exp: Math.floor((now + HOUR) / 1000),
          }),
          expiresAt: new Date(now + HOUR).toISOString(),
          lastRefreshAt: new Date(now).toISOString(),
        };
      }
    }
    expect(refreshes).toBeLessThanOrEqual(7);
    expect(refreshes).toBeGreaterThanOrEqual(5);
  });

  it("max-age fallback cannot fire on a fresh short-lived token", () => {
    // Legacy bug: declared max age (8d) never fires, but a token whose lifetime is
    // 1h must be treated as stale at 80% of it and not earlier.
    const c = creds(HOUR, 20 * MIN, { expiresAt: undefined });
    expect(mgr.shouldRefreshCredentials("codex", c, NOW)).toBe(false);
    expect(mgr.shouldRefreshCredentials("codex", creds(HOUR, 55 * MIN), NOW)).toBe(true);
  });

  it("max-age for a 10-day token is capped at the declared 8 days", () => {
    const c = creds(30 * DAY, 9 * DAY);
    expect(mgr.shouldRefreshCredentials("codex", c, NOW)).toBe(true);
    expect(mgr.shouldRefreshCredentials("codex", creds(30 * DAY, 7 * DAY), NOW)).toBe(false);
  });
});

describe("codex access-token imports (no refresh token)", () => {
  it("is never proactively refreshed", () => {
    expect(
      mgr.shouldRefreshCredentials("codex", creds(HOUR, 50 * MIN, { refreshToken: null }), NOW),
    ).toBe(false);
  });
});

describe("minimum interval between proactive refreshes", () => {
  it("a token refreshed under 5 minutes ago is never proactively due", () => {
    const c = creds(10 * MIN, 0); // expires in 10 min, lead 5 min => due soon, but just refreshed
    expect(mgr.shouldRefreshCredentials("codex", c, NOW + 2 * MIN)).toBe(false);
    expect(mgr.shouldRefreshCredentials("codex", c, NOW + 6 * MIN)).toBe(true);
  });

  it("an expired token ignores the interval", () => {
    const c = creds(2 * MIN, 0);
    expect(mgr.shouldRefreshCredentials("codex", c, NOW + 3 * MIN)).toBe(true);
  });

  it("does not apply to other providers", () => {
    const c = {
      refreshToken: "rt",
      expiresAt: new Date(NOW + MIN).toISOString(),
      lastRefreshAt: new Date(NOW).toISOString(),
    };
    expect(mgr.shouldRefreshCredentials("kimi", c, NOW)).toBe(true);
  });
});

describe("background scheduler (codex)", () => {
  const conn = (c, id = "c1") => ({ id, provider: "codex", authType: "oauth", ...c });

  it("does not select a fresh 1h token on every tick", () => {
    const due = [];
    for (let t = 0; t <= 60; t += 5) {
      const now = NOW + t * MIN;
      const list = bg.selectConnectionsNeedingRefresh([conn(creds(HOUR, 0))], now);
      due.push(list.length);
    }
    // Inside the 30 min lead (t > 30) it is due, up to and including t = 30 never.
    expect(due.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(due[7]).toBe(1);
  });

  it("selects a 10-day token only inside its 5-day lead (not the old 30-minute floor)", () => {
    expect(bg.selectConnectionsNeedingRefresh([conn(creds(10 * DAY, 4 * DAY))], NOW)).toHaveLength(
      0,
    );
    expect(bg.selectConnectionsNeedingRefresh([conn(creds(10 * DAY, 6 * DAY))], NOW)).toHaveLength(
      1,
    );
  });

  it("skips a connection refreshed less than 5 minutes ago", () => {
    const c = conn(creds(10 * MIN, 0));
    expect(bg.selectConnectionsNeedingRefresh([c], NOW + 2 * MIN)).toHaveLength(0);
    expect(bg.selectConnectionsNeedingRefresh([c], NOW + 6 * MIN)).toHaveLength(1);
  });

  it("keeps the 30-minute floor for non-lifetime-aware providers", () => {
    const c = {
      id: "g",
      provider: "grok-cli",
      authType: "oauth",
      refreshToken: "rt",
      expiresAt: new Date(NOW + 20 * MIN).toISOString(),
      lastRefreshAt: new Date(NOW - MIN).toISOString(),
    };
    expect(bg.selectConnectionsNeedingRefresh([c], NOW)).toHaveLength(1);
  });
});

describe("reactive refresh is not rate limited", () => {
  it("executor.refreshCredentials refreshes even right after a refresh", async () => {
    vi.useRealTimers(); // the proxy-aware fetch schedules real timers
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-at", refresh_token: "rt2", expires_in: 3600 }),
    });
    vi.resetModules(); // proxyFetch patches global fetch at import: import after the mock
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    const result = await new CodexExecutor().refreshCredentials(
      creds(HOUR, MIN, { connectionId: "reactive-1", refreshToken: "rt-reactive" }),
      null,
    );
    expect(result.accessToken).toBe("new-at");
  });
});
