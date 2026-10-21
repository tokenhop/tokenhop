import { describe, expect, it } from "vitest";
import {
  billingLockOf,
  billingProbeFeedback,
  connectionHealth,
  providerHealth,
  probeTimes,
  summarizeProviders,
  tokenExpiryText,
} from "@/shared/utils/providerHealth.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const connection = (provider, fields = {}) => ({
  provider,
  authType: "oauth",
  isActive: true,
  testStatus: "active",
  ...fields,
});

describe("provider health", () => {
  it.each([
    [{ testStatus: "active" }, "ok", null],
    [{ testStatus: "success" }, "ok", null],
    [{ testStatus: "ok" }, "ok", null],
    [{ testStatus: null }, "ok", null],
    [
      { testStatus: "error", lastError: "Token expired and refresh failed" },
      "err",
      "Token refresh failed · reconnect",
    ],
    [{ testStatus: "error", lastError: "Token expired" }, "err", "Token expired · reconnect"],
    [
      { testStatus: "error", lastError: "Token invalid or revoked" },
      "err",
      "Token revoked · reconnect",
    ],
    [{ testStatus: "unavailable" }, "ok", null],
    [{ testStatus: "unavailable", modelLock_x: "2026-09-27T12:02:14Z" }, "warn", "Cooling down"],
    [{ testStatus: "active", modelLock_x: "2026-09-27T12:02:14Z" }, "warn", "Cooling down"],
    [{ testStatus: "unknown" }, "ok", null],
    [{ testStatus: "untested" }, "ok", null],
    [{ testStatus: "pending" }, "ok", null],
    [{ testStatus: "surprise" }, "warn", "Status unknown · test"],
    [{ isActive: false, testStatus: "error" }, "off", "Disabled"],
  ])("classifies %o as %s", (fields, status, reason) => {
    expect(connectionHealth(connection("a", fields), NOW)).toMatchObject({ status, reason });
  });

  it("classifies a billing lock as out of credit above cooldowns and other errors", () => {
    const lock = {
      reason: "credit_exhausted",
      code: "insufficient_quota",
      message: "No credit left",
      lockedAt: "2026-09-27T10:00:00Z",
      nextProbeAt: "2026-09-27T12:10:00Z",
      lastProbeAt: "2026-09-27T11:55:00Z",
      lastProbeError: null,
      generation: 3,
    };
    const row = connection("a", {
      billingLock: lock,
      testStatus: "error",
      lastError: "Token invalid or revoked",
      modelLock_x: "2026-09-27T12:02:14Z",
    });
    expect(connectionHealth(row, NOW)).toMatchObject({
      status: "err",
      state: "out_of_credit",
      reason: "Out of credit",
      action: "open",
      billingLock: lock,
    });
    // Disabled still wins.
    expect(
      connectionHealth(connection("a", { billingLock: lock, isActive: false }), NOW),
    ).toMatchObject({ status: "off", reason: "Disabled" });
    // Missing, null and non-object locks are ignored.
    expect(connectionHealth(connection("a", { billingLock: null }), NOW).status).toBe("ok");
    expect(connectionHealth(connection("a", { billingLock: "x" }), NOW).status).toBe("ok");
    // Backend contract: only reason "credit_exhausted" is a lock.
    expect(connectionHealth(connection("a", { billingLock: {} }), NOW).status).toBe("ok");
    expect(
      connectionHealth(connection("a", { billingLock: { ...lock, reason: "other" } }), NOW).status,
    ).toBe("ok");
    // Provider roll-up counts it like any other error.
    expect(providerHealth([connection("a", { billingLock: lock })], NOW)).toMatchObject({
      status: "err",
      connected: true,
      needsAttention: true,
      counts: { err: 1 },
    });
    expect(billingLockOf(row)).toBe(lock);
    expect(billingLockOf(connection("a"))).toBeNull();
  });

  it("maps probe endpoint results to short grounded feedback", () => {
    expect(billingProbeFeedback("cleared")).toMatchObject({
      variant: "ok",
      text: "Credit is back. Connection is active again.",
    });
    expect(billingProbeFeedback("still_locked").variant).toBe("warn");
    expect(billingProbeFeedback("error").variant).toBe("err");
    expect(billingProbeFeedback("in_flight").variant).toBe("info");
    expect(billingProbeFeedback("not_locked").variant).toBe("info");
    expect(billingProbeFeedback(null)).toEqual(billingProbeFeedback("error"));
  });

  it("formats probe times for display, including never-probed locks", () => {
    expect(
      probeTimes(
        {
          lastProbeAt: "2026-09-27T11:55:00Z",
          nextProbeAt: "2026-09-27T12:10:00Z",
        },
        NOW,
      ),
    ).toEqual({ last: "Last probe 5m ago", next: "Next probe in 10m" });
    expect(probeTimes({ lastProbeAt: null, nextProbeAt: null }, NOW)).toEqual({
      last: "Not probed yet",
      next: "",
    });
    expect(
      probeTimes({ lastProbeAt: "2026-09-27T11:55:00Z", nextProbeAt: "2026-09-27T11:59:00Z" }, NOW),
    ).toEqual({ last: "Last probe 5m ago", next: "Next probe due" });
  });

  it("does not infer failure from an expired access token the gateway can refresh", () => {
    const expiresAt = "2026-09-27T11:59:00Z";
    expect(connectionHealth(connection("a", { authType: "oauth", expiresAt }), NOW).status).toBe(
      "ok",
    );
  });

  it("classifies real persisted writer shapes", () => {
    // testSingleConnection: testStatus/lastError/lastErrorAt, no errorCode.
    expect(
      connectionHealth(
        connection("a", {
          testStatus: "error",
          lastError: "Token invalid or revoked",
          lastErrorAt: "2026-09-27T11:00:00Z",
        }),
        NOW,
      ),
    ).toMatchObject({ status: "err", action: "reconnect" });
    expect(
      connectionHealth(
        connection("a", { testStatus: "error", lastError: "API returned 500" }),
        NOW,
      ),
    ).toMatchObject({ status: "err", action: "test" });
    // markAccountUnavailable: lock + unavailable + errorCode.
    expect(
      connectionHealth(
        connection("a", {
          testStatus: "unavailable",
          errorCode: 429,
          lastError: "rate",
          modelLock___all: "2026-09-27T12:05:00Z",
        }),
        NOW,
      ),
    ).toMatchObject({ status: "warn", until: "2026-09-27T12:05:00Z" });
    // Background refresh failures are only logged, so a stored healthy row stays healthy.
    expect(
      connectionHealth(
        connection("a", {
          testStatus: "active",
          authType: "oauth",
          expiresAt: "2026-09-27T11:00:00Z",
        }),
        NOW,
      ).status,
    ).toBe("ok");
  });

  it("uses only persisted provider-test auth failures for the repair action", () => {
    for (const lastError of [
      "Token invalid or revoked",
      "Access denied",
      "No access token",
      "Invalid API key",
      "Invalid session cookie",
      "Invalid SSO cookie",
      "Session expired — re-paste cookie",
    ]) {
      expect(
        connectionHealth(connection("a", { testStatus: "error", lastError }), NOW),
      ).toMatchObject({
        status: "err",
        action: "reconnect",
      });
    }
    // Only markAccountUnavailable writes errorCode; it also writes unavailable + a lock.
    expect(
      connectionHealth(connection("a", { testStatus: "error", errorCode: 401 }), NOW).action,
    ).toBe("test");
    expect(
      connectionHealth(connection("a", { testStatus: "error", lastError: "API returned 500" }), NOW)
        .action,
    ).toBe("test");
    expect(
      connectionHealth(
        connection("iflow", {
          authType: "cookie",
          testStatus: "error",
          lastError: "Invalid session cookie",
        }),
        NOW,
      ).action,
    ).toBe("open");
    expect(
      connectionHealth(
        connection("web", {
          authType: "cookie",
          testStatus: "error",
          lastError: "Invalid session cookie",
        }),
        NOW,
      ).action,
    ).toBe("reconnect");
  });

  it("ignores expired locks and disabled failures; worst active connection wins", () => {
    const health = providerHealth(
      [
        connection("a", { modelLock_x: "2026-09-27T11:59:00Z" }),
        connection("a", { isActive: false, testStatus: "expired" }),
        connection("a", { testStatus: "error", lastError: "Access denied" }),
      ],
      NOW,
    );
    expect(health).toMatchObject({
      status: "err",
      connected: true,
      needsAttention: true,
      counts: { ok: 1, err: 1, off: 1 },
    });
    expect(health.reason).toBe("Access denied · reconnect");
    expect(providerHealth([], NOW)).toMatchObject({
      status: "off",
      connected: false,
      needsAttention: false,
    });
  });

  it("counts distinct connected providers; no-auth ready is separate", () => {
    const result = summarizeProviders(
      [{ id: "a" }, { id: "b" }, { id: "ready", isNoAuth: true }, { id: "empty" }],
      [
        connection("a"),
        connection("a", { testStatus: "error" }),
        connection("b", { isActive: false }),
        connection("orphan"),
      ],
      NOW,
    );
    expect(result).toMatchObject({ connected: 2, needsAttention: 1, noAuthReady: 1 });
    expect(result.providers.find((p) => p.id === "a")).toMatchObject({
      status: "err",
      connected: true,
    });
    expect(result.providers.find((p) => p.id === "ready")).toMatchObject({
      status: "off",
      connected: false,
    });
    expect(summarizeProviders([], [], NOW)).toMatchObject({
      connected: 0,
      needsAttention: 0,
      noAuthReady: 0,
      providers: [],
    });
  });
});

describe("re-authentication required (YAN-1038)", () => {
  const flag = (reason = "refresh_token_rejected") => ({
    reason,
    code: "refresh_token_reused",
    at: "2026-09-27T11:00:00Z",
  });

  it("outranks a cooldown and an unavailable overwrite for a flagged oauth row", () => {
    const row = connection("codex", {
      reauthRequired: flag(),
      testStatus: "unavailable",
      modelLock___all: "2026-09-27T12:02:14Z",
    });
    expect(connectionHealth(row, NOW)).toMatchObject({
      status: "err",
      state: "reauth_required",
      reason: "Token refresh failed · reconnect",
      action: "reconnect",
    });
  });

  it("points a flagged access_token row at the provider, not a reconnect", () => {
    const row = connection("codex", {
      authType: "access_token",
      reauthRequired: flag("access_token_expired"),
    });
    expect(connectionHealth(row, NOW)).toMatchObject({
      status: "err",
      state: "reauth_required",
      reason: "Token expired · open provider",
      action: "open",
    });
  });

  it("treats an unflagged access_token row past its expiry the same way", () => {
    const row = connection("codex", {
      authType: "access_token",
      expiresAt: "2026-09-27T11:59:00Z",
    });
    expect(connectionHealth(row, NOW)).toMatchObject({
      status: "err",
      state: "reauth_required",
      reason: "Token expired · open provider",
      action: "open",
    });
    const future = connection("codex", {
      authType: "access_token",
      expiresAt: "2026-09-27T13:00:00Z",
    });
    expect(connectionHealth(future, NOW).status).toBe("ok");
  });

  it("lets disabled and billing locks win over it", () => {
    expect(
      connectionHealth(connection("codex", { reauthRequired: flag(), isActive: false }), NOW),
    ).toMatchObject({ status: "off", reason: "Disabled" });
    const lock = { reason: "credit_exhausted" };
    expect(
      connectionHealth(connection("codex", { reauthRequired: flag(), billingLock: lock }), NOW),
    ).toMatchObject({ state: "out_of_credit", reason: "Out of credit" });
  });

  it("ignores a malformed reauthRequired", () => {
    for (const reauthRequired of [null, "x", {}, { reason: "other" }, { reason: 5 }]) {
      expect(connectionHealth(connection("codex", { reauthRequired }), NOW).status).toBe("ok");
    }
  });

  it("does not apply to access_token rows of providers that are not lifetime-aware", () => {
    const expired = { authType: "access_token", expiresAt: "2026-09-27T11:59:00Z" };
    expect(connectionHealth(connection("claude", expired), NOW).status).toBe("ok");
    expect(tokenExpiryText(connection("claude", expired), NOW)).toBe("");
  });

  it("formats the access-token expiry text", () => {
    const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
    const row = (fields) => connection("codex", { authType: "access_token", ...fields });
    expect(tokenExpiryText(row({ expiresAt: at(3 * 3600e3 + 60e3) }), NOW)).toBe(
      "Token expires in 3h",
    );
    expect(tokenExpiryText(row({ expiresAt: at(-(2 * 86400e3 + 60e3)) }), NOW)).toBe(
      "Token expired 2d ago",
    );
    expect(tokenExpiryText(connection("claude", { expiresAt: at(3600e3) }), NOW)).toBe("");
    expect(tokenExpiryText(row({ expiresAt: "not a date" }), NOW)).toBe("");
    expect(tokenExpiryText(row({}), NOW)).toBe("");
  });
});
