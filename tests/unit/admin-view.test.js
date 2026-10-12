// YAN-373: pure admin helpers + nav gating. Server statuses map to the hidden/denied
// states with no client-side authorization; invite links live in workspaceView.
import { describe, expect, it } from "vitest";
import {
  adminLoadCopy,
  adminLoadState,
  formatWhen,
  statusVariant,
  suggestPassword,
} from "@/app/(dashboard)/dashboard/admin/adminView.js";
import { accountView } from "@/shared/utils/account";
import { visibleGroups } from "@/shared/constants/navigation.js";

describe("server-driven states", () => {
  it("maps statuses without inspecting capabilities", () => {
    expect(adminLoadState(404)).toBe("hidden");
    expect(adminLoadState(403)).toBe("denied");
    expect(adminLoadState(500)).toBe("error");
    expect(adminLoadState(undefined)).toBeNull();
  });
  it("has distinct copy for hidden and denied", () => {
    expect(adminLoadCopy("hidden").body).toMatch(/switched off/);
    expect(adminLoadCopy("denied").body).toMatch(/owners and admins/);
  });
  it("status and date helpers are defensive", () => {
    expect(statusVariant("active")).toBe("ok");
    expect(statusVariant("???")).toBe("neutral");
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });
  it("suggests a 16-char password from a readable alphabet", () => {
    const pw = suggestPassword();
    expect(pw).toMatch(/^[a-hjkmnp-z2-9]{16}$/);
    expect(suggestPassword()).not.toBe(pw);
  });
});

describe("Admin nav group", () => {
  const status = (role) => ({
    multiUserActive: true,
    principal: {
      user: { id: "u", email: "a@x.test" },
      role,
      activeWorkspaceId: "w",
      workspaces: [{ id: "w", name: "W", kind: "shared", role: "member" }],
    },
  });
  const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id));

  it("is hidden while Users & teams is off, whatever the principal", () => {
    const view = accountView(status("owner"));
    expect(ids(visibleGroups({ multiUser: false, can: view.can }))).not.toContain("users");
    expect(ids(visibleGroups({}))).not.toContain("workspaces");
    expect(visibleGroups({}).some((g) => g.id === "admin" && g.items.length)).toBe(false);
  });
  it("shows users and workspaces to admins, nothing to plain users", () => {
    const admin = accountView(status("admin"));
    const adminIds = ids(visibleGroups({ multiUser: true, can: admin.can }));
    expect(adminIds).toEqual(expect.arrayContaining(["users", "workspaces", "provisioning"]));
    const user = accountView(status("user"));
    const userIds = ids(visibleGroups({ multiUser: true, can: user.can }));
    expect(userIds).not.toContain("users");
    expect(userIds).not.toContain("provisioning");
  });
});
