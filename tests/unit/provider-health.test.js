import { describe, expect, it } from "vitest";
import {
  connectionHealth,
  providerHealth,
  summarizeProviders,
} from "@/shared/utils/providerHealth.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const connection = (provider, fields = {}) => ({
  provider,
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
    [{ testStatus: "expired" }, "err", "Token expired · reconnect"],
    [{ lastErrorType: "token_refresh_failed" }, "err", "Token refresh failed · reconnect"],
    [{ testStatus: "error", errorCode: 401 }, "err", "Test failed · 401"],
    [{ testStatus: "unavailable" }, "ok", null],
    [{ testStatus: "unavailable", modelLock_x: "2026-09-27T12:02:14Z" }, "warn", "Cooling down"],
    [{ testStatus: "active", modelLock_x: "2026-09-27T12:02:14Z" }, "warn", "Cooling down"],
    [{ testStatus: "cooldown" }, "warn", "Cooling down"],
    [{ testStatus: "pending" }, "warn", "Test pending"],
    [{ isActive: false, testStatus: "error" }, "off", "Disabled"],
  ])("classifies %o as %s", (fields, status, reason) => {
    expect(connectionHealth(connection("a", fields), NOW)).toMatchObject({ status, reason });
  });

  it("treats expired OAuth tokens as failed but not expired API keys", () => {
    const expiresAt = "2026-09-27T11:59:00Z";
    expect(connectionHealth(connection("a", { authType: "oauth", expiresAt }), NOW).status).toBe(
      "err",
    );
    expect(connectionHealth(connection("a", { authType: "apikey", expiresAt }), NOW).status).toBe(
      "ok",
    );
  });

  it("ignores expired locks and disabled failures; worst active connection wins", () => {
    const health = providerHealth(
      [
        connection("a", { modelLock_x: "2026-09-27T11:59:00Z" }),
        connection("a", { isActive: false, testStatus: "expired" }),
        connection("a", { testStatus: "error", errorCode: 403 }),
      ],
      NOW,
    );
    expect(health).toMatchObject({
      status: "err",
      connected: true,
      needsAttention: true,
      counts: { ok: 1, err: 1, off: 1 },
    });
    expect(health.reason).toBe("Test failed · 403");
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
