/**
 * Regression: the xiaomi-mimo OAuth session store must not retain sessions
 * once the callback listener is down.
 *
 * Each /authorize registers a session holding an X25519 private key, keyed by a
 * fresh state. Unlike trae/windsurf/zed (singleton session) this is a Map, so
 * without an explicit clear every login attempt would leak a private key for
 * the whole process lifetime.
 */
import { describe, it, expect, vi } from "vitest";
import {
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
} from "../../src/lib/oauth/utils/server.js";

const KEY = Buffer.from("x25519-private-key-material");

describe("xiaomi-mimo OAuth session store", () => {
  it("drops pending sessions when the proxy stops", () => {
    registerXiaomiMimoSession({ state: "s1", privateKeyDer: KEY });
    expect(getXiaomiMimoSessionStatus("s1")).not.toBeNull();

    stopXiaomiMimoProxy();

    expect(getXiaomiMimoSessionStatus("s1")).toBeNull();
  });

  it("drops every session, not just the last one", () => {
    registerXiaomiMimoSession({ state: "a", privateKeyDer: KEY });
    registerXiaomiMimoSession({ state: "b", privateKeyDer: KEY });
    registerXiaomiMimoSession({ state: "c", privateKeyDer: KEY });

    stopXiaomiMimoProxy();

    for (const s of ["a", "b", "c"]) {
      expect(getXiaomiMimoSessionStatus(s)).toBeNull();
    }
  });

  it("ignores registrations with a missing state or key", () => {
    expect(registerXiaomiMimoSession({ state: "", privateKeyDer: KEY })).toBe(false);
    expect(registerXiaomiMimoSession({ state: "s", privateKeyDer: null })).toBe(false);
  });

  it("never exposes the private key to callers", () => {
    registerXiaomiMimoSession({ state: "s1", privateKeyDer: KEY });
    const view = getXiaomiMimoSessionStatus("s1");
    expect(view).toEqual({ status: "pending", result: null, error: null });
    expect(JSON.stringify(view)).not.toContain("privateKeyDer");
    clearXiaomiMimoSession("s1");
  });

  // YAN-113: reusing the live listener must renew its 5-minute timeout.
  it("gives a login that reuses the listener a full timeout window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = await startXiaomiMimoProxy();
      expect(first.success).toBe(true);
      registerXiaomiMimoSession({ state: "a", privateKeyDer: KEY });

      vi.advanceTimersByTime(4 * 60_000 + 50_000);
      const second = await startXiaomiMimoProxy();
      expect(second.port).toBe(first.port);
      registerXiaomiMimoSession({ state: "b", privateKeyDer: KEY });

      vi.advanceTimersByTime(60_000);
      expect(getXiaomiMimoSessionStatus("b")).not.toBeNull();

      vi.advanceTimersByTime(4 * 60_000);
      expect(getXiaomiMimoSessionStatus("b")).toBeNull();
    } finally {
      stopXiaomiMimoProxy();
      vi.useRealTimers();
    }
  });
});
