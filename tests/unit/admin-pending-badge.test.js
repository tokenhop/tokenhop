// YAN-373: pending-approval badge. The count is `totalItems` from the
// server-filtered page — no user data is read, so members (403) and
// switch-off (404) both mean "no badge", never a failure.
import { describe, expect, it, vi } from "vitest";
import { pendingCountFrom } from "@/shared/hooks/usePendingUsers.js";

describe("pendingCountFrom", () => {
  it("reads totalItems", () => {
    expect(pendingCountFrom({ pagination: { totalItems: 3 } })).toBe(3);
    expect(pendingCountFrom({ pagination: { totalItems: 0 } })).toBe(0);
  });
  it("rejects garbage so the badge keeps its old value", () => {
    expect(pendingCountFrom(null)).toBeNull();
    expect(pendingCountFrom({})).toBeNull();
    expect(pendingCountFrom({ pagination: { totalItems: -1 } })).toBeNull();
    expect(pendingCountFrom({ pagination: { totalItems: "3" } })).toBeNull();
  });
});

describe("badge contract", () => {
  it("has a warn tint and readable screen-reader nouns", async () => {
    const [{ badgeTint }, { badgeAriaLabel, formatBadge }] = await Promise.all([
      import("@/shared/utils/shell.js"),
      import("@/shared/constants/navigation.js"),
    ]);
    expect(badgeTint("pendingUsers", 4)).toBe("warn");
    expect(formatBadge(120)).toBe("99+");
    expect(badgeAriaLabel("pendingUsers", 1)).toBe("1 user awaiting approval");
    expect(badgeAriaLabel("pendingUsers", 5)).toBe("5 users awaiting approval");
    expect(badgeAriaLabel("pendingUsers", 0)).toBeNull();
  });
  it("refreshes after each list load and role mutation", async () => {
    const { default: fs } = await import("node:fs/promises");
    const users = await fs.readFile(
      new URL("../../src/app/(dashboard)/dashboard/admin/users/page.js", import.meta.url),
      "utf8",
    );
    const detail = await fs.readFile(
      new URL("../../src/app/(dashboard)/dashboard/admin/users/[id]/page.js", import.meta.url),
      "utf8",
    );
    expect(users).toContain("refreshPendingUsers()");
    expect(detail).toContain("refreshPendingUsers()");
  });
});

describe("visibility still holds", () => {
  it("members cannot see the Users nav item, so the badge never surfaces", async () => {
    vi.resetModules();
    const { accountView } = await import("@/shared/utils/account");
    const { visibleGroups } = await import("@/shared/constants/navigation.js");
    const status = {
      multiUserActive: true,
      principal: {
        user: { id: "u", email: "a@x.test" },
        role: "user",
        activeWorkspaceId: "w",
        workspaces: [{ id: "w", name: "W", kind: "shared", role: "member" }],
      },
    };
    const view = accountView(status);
    expect(view.can("instance.users.manage")).toBe(false);
    const ids = visibleGroups({ multiUser: true, can: view.can }).flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(ids).not.toContain("users");
  });
});
