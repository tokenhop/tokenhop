// YAN-1833: the Home budget tile reads the same GET as Usage > Budgets, only
// when the viewer may read it, and orders budgets closest to their cap first.
import { describe, expect, it } from "vitest";
import { homeBudgetsUrl } from "@/app/(dashboard)/dashboard/home/useHomeData.js";
import {
  budgetResetAt,
  budgetUsedFraction,
  isOverCap,
  pickTightestBudgets,
} from "@/app/(dashboard)/dashboard/usage/lib/budgetMeter.js";

const onStatus = (workspaceRole, role = "user") => ({
  requireLogin: true,
  multiUserActive: true,
  principal: {
    role,
    user: { id: "u1" },
    workspaces: [{ id: "w1", name: "W", kind: "shared", role: workspaceRole }],
    activeWorkspaceId: "w1",
  },
});

describe("homeBudgetsUrl", () => {
  it("waits while the switch or auth status is unknown", () => {
    expect(homeBudgetsUrl({}, null)).toBeNull();
    expect(homeBudgetsUrl({}, false)).toBeNull();
    expect(homeBudgetsUrl(onStatus("owner"), undefined)).toBeNull();
  });

  it("switch on: active workspace list for every role holding workspace.budgets.read", () => {
    for (const role of ["owner", "manager", "member", "viewer"]) {
      expect(homeBudgetsUrl(onStatus(role), true)).toBe("/api/workspaces/w1/budgets");
    }
  });

  it("switch on: nothing without an active workspace or an active account view", () => {
    const status = onStatus("owner");
    status.principal.activeWorkspaceId = null;
    expect(homeBudgetsUrl(status, true)).toBeNull();
    expect(homeBudgetsUrl({ requireLogin: false, multiUserActive: false }, true)).toBeNull();
  });

  it("switch off: Default workspace for the dashboard admin only", () => {
    expect(homeBudgetsUrl({ requireLogin: false, multiUserActive: false }, false)).toBe(
      "/api/workspaces/default/budgets",
    );
    expect(homeBudgetsUrl(onStatus("owner", "admin"), false)).toBe(
      "/api/workspaces/default/budgets",
    );
    expect(homeBudgetsUrl(onStatus("owner", "user"), false)).toBeNull();
  });
});

describe("pickTightestBudgets", () => {
  const b = (id, spent, limits) => ({ id, spent, ...limits });

  it("uses the highest used fraction across limited units", () => {
    expect(
      budgetUsedFraction(b("a", { usd: 1, tokens: 900 }, { limitUsd: 10, limitTokens: 1000 })),
    ).toBeCloseTo(0.9);
    expect(budgetUsedFraction(b("z", { requests: 1 }, { limitRequests: 0 }))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(budgetUsedFraction(b("n", {}, {}))).toBe(0);
  });

  it("returns up to 3, closest to the cap first, ties in list order", () => {
    const rows = [
      b("low", { usd: 1 }, { limitUsd: 10 }),
      b("over", { usd: 12 }, { limitUsd: 10 }),
      b("tie1", { requests: 5 }, { limitRequests: 10 }),
      b("tie2", { tokens: 50 }, { limitTokens: 100 }),
    ];
    expect(pickTightestBudgets(rows).map((r) => r.id)).toEqual(["over", "tie1", "tie2"]);
    expect(pickTightestBudgets(null)).toEqual([]);
  });
});

describe("isOverCap / budgetResetAt", () => {
  it("is exact and treats a zero cap as over once anything is spent", () => {
    expect(isOverCap({ spent: 100.4, limit: 100 })).toBe(true);
    expect(isOverCap({ spent: 100, limit: 100 })).toBe(false);
    expect(isOverCap({ spent: 1, limit: 0 })).toBe(true);
    expect(isOverCap({ spent: undefined, limit: 0 })).toBe(false);
  });

  it("derives the reset from the current window, not a stale stored resetAt", () => {
    const now = Date.UTC(2026, 10, 9, 15, 30);
    const stale = "2026-09-01T00:00:00.000Z";
    expect(budgetResetAt({ window: "day", resetAt: stale }, now)).toBe("2026-11-10T00:00:00.000Z");
    expect(budgetResetAt({ window: "week", resetAt: stale }, now)).toBe("2026-11-16T00:00:00.000Z");
    expect(budgetResetAt({ window: "month", resetAt: stale }, now)).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(budgetResetAt({ window: "total", resetAt: stale }, now)).toBeNull();
  });
});
