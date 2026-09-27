import { describe, expect, it, vi } from "vitest";
import {
  clearConsoleLog,
  readTunnelEnabled,
  setTunnel,
  signOut,
  testAllProviders,
} from "@/shared/utils/paletteVerbs.js";

const response = (body = {}, ok = true) => ({ ok, json: async () => body });

describe("palette verbs", () => {
  it("uses existing provider-test and console-log API contracts", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ summary: { passed: 2, failed: 0, total: 2 } }));
    expect(await testAllProviders(request)).toEqual({
      level: "success",
      message: "All 2 tests passed",
    });
    expect(request).toHaveBeenCalledWith("/api/providers/test-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "all" }),
    });
    expect(await clearConsoleLog(request)).toEqual({
      level: "success",
      message: "Console log cleared",
    });
    expect(request).toHaveBeenCalledWith("/api/translator/console-logs", { method: "DELETE" });
    expect(await signOut(request)).toEqual({ level: "success", message: "Signed out" });
    expect(request).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
  });

  it("refuses tunnel start when security settings cannot be loaded or are unsafe", async () => {
    const unavailable = vi.fn().mockResolvedValue(response({}, false));
    expect((await setTunnel(true, unavailable)).level).toBe("error");
    expect(unavailable).toHaveBeenCalledTimes(1);
    const unsafe = vi
      .fn()
      .mockResolvedValue(response({ requireLogin: false, hasPassword: true, requireApiKey: true }));
    expect((await setTunnel(true, unsafe)).level).toBe("error");
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it("reflects tunnel state and reports API failures honestly", async () => {
    expect(
      await readTunnelEnabled(
        vi.fn().mockResolvedValue(response({ tunnel: { settingsEnabled: true } })),
      ),
    ).toBe(true);
    expect(await readTunnelEnabled(vi.fn().mockResolvedValue(response({}, false)))).toBeNull();
    const api = vi.fn().mockResolvedValue(response({ error: "denied" }, false));
    expect(await setTunnel(false, api)).toEqual({ level: "error", message: "denied" });
    expect(api).toHaveBeenCalledWith("/api/tunnel/disable", { method: "POST" });
    expect((await clearConsoleLog(api)).level).toBe("error");
  });
});
