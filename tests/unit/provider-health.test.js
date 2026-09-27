import { describe, expect, it } from "vitest";
import {
  connectionHealth,
  providerHealth,
  summarizeProviders,
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
