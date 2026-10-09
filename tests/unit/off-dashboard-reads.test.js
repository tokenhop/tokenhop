import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  isConfirmedLegacyStatus,
  loadKeyContext,
} from "../../src/app/(dashboard)/dashboard/endpoint/hooks/keyApi.js";

const src = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

describe("OFF dashboard background reads", () => {
  it("skips key context only for confirmed pristine legacy status", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const legacy = { authenticated: true, hasPassword: true };
    expect(isConfirmedLegacyStatus(legacy)).toBe(true);
    expect((await loadKeyContext(legacy)).storage).toBe("legacy");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fails closed for missing, failed or secured status", () => {
    for (const status of [
      undefined,
      {},
      { authenticated: false, hasPassword: true },
      { authenticated: true, hasPassword: true, userSecurityEnforced: true },
      { authenticated: true, hasPassword: true, principal: { user: {} } },
    ]) {
      expect(isConfirmedLegacyStatus(status)).toBe(false);
    }
  });

  it("requests account preferences only for authenticated secured sessions", () => {
    const density = src("shared/components/DensityApplier.js");
    expect(density).toContain("useAuthStatusState");
    expect(density).toMatch(/status\.userSecurityEnforced !== true/);
    expect(density).toMatch(/status\.authenticated !== true/);
    expect(src("app/(dashboard)/dashboard/endpoint/hooks/useApiKeys.js")).toContain(
      "loadKeyContext(authStatus)",
    );
  });
});
