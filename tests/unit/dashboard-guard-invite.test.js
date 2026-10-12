// YAN-373: /invite is a public page prefix (exact segment); look-alikes and
// the dashboard stay guarded.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { next: vi.fn(), json: vi.fn(), redirect: vi.fn() },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(), validateApiKey: vi.fn() }));
vi.mock("@/lib/users/featureSwitch", () => ({
  isMultiUserEnabled: async () => false,
  requireMultiUser: async () => null,
}));

const { __test__ } = await import("../../src/dashboardGuard.js");

describe("dashboardGuard public /invite prefix", () => {
  it("makes /invite and /invite/<token> public", () => {
    expect(__test__.isPublicPage("/invite")).toBe(true);
    expect(__test__.isPublicPage("/invite/abc")).toBe(true);
  });

  it("keeps look-alikes and the dashboard guarded", () => {
    for (const p of ["/invitex", "/invitexyz/abc", "/dashboard", "/dashboard/invite", "/"]) {
      expect(__test__.isPublicPage(p), p).toBe(false);
    }
  });
});
