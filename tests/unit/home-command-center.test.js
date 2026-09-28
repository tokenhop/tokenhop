import { describe, it, expect } from "vitest";
import {
  deriveCommandCenterStatus,
  pickLowestQuotaAccounts,
  pickTopCombos,
  periodDelta,
} from "@/shared/utils/commandCenter.js";

describe("deriveCommandCenterStatus", () => {
  it("guides a fresh install", () => {
    expect(deriveCommandCenterStatus([])).toBe("Connect your first provider");
    expect(deriveCommandCenterStatus(null)).toBe("Connect your first provider");
  });

  it("reports all healthy", () => {
    expect(deriveCommandCenterStatus([{ status: "ok" }, { status: "ok" }])).toBe(
      "All routes humming",
    );
  });

  it("counts cooling-down providers", () => {
    expect(deriveCommandCenterStatus([{ status: "ok" }, { status: "warn" }])).toBe(
      "All routes humming · 1 provider cooling down",
    );
    expect(deriveCommandCenterStatus([{ status: "warn" }, { status: "warn" }])).toBe(
      "All routes humming · 2 providers cooling down",
    );
  });

  it("errors outrank cooldowns and the count matches the cards (err + warn)", () => {
    expect(deriveCommandCenterStatus([{ status: "warn" }, { status: "err" }])).toBe(
      "2 providers need attention",
    );
    expect(deriveCommandCenterStatus([{ status: "ok" }, { status: "err" }])).toBe(
      "1 provider needs attention",
    );
    expect(deriveCommandCenterStatus([{ status: "err" }, { status: "err" }])).toBe(
      "2 providers need attention",
    );
  });
});

describe("pickLowestQuotaAccounts", () => {
  it("returns the 3 lowest, ascending", () => {
    const accounts = [80, 10, 50, 5, 30].map((remaining, i) => ({ id: `c${i}`, remaining }));
    expect(pickLowestQuotaAccounts(accounts).map((a) => a.id)).toEqual(["c3", "c1", "c4"]);
  });

  it("puts unknown remaining last and tolerates bad input", () => {
    const accounts = [
      { id: "a", remaining: null },
      { id: "b", remaining: 40 },
    ];
    expect(pickLowestQuotaAccounts(accounts).map((a) => a.id)).toEqual(["b", "a"]);
    expect(pickLowestQuotaAccounts(undefined)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const accounts = [
      { id: "a", remaining: 9 },
      { id: "b", remaining: 1 },
    ];
    pickLowestQuotaAccounts(accounts);
    expect(accounts.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("pickTopCombos", () => {
  it("returns the 2 most used", () => {
    const combos = [
      { name: "a", requests: 3 },
      { name: "b", requests: 9 },
      { name: "c", requests: 7 },
    ];
    expect(pickTopCombos(combos).map((c) => c.name)).toEqual(["b", "c"]);
  });

  it("treats missing counts as zero", () => {
    expect(pickTopCombos([{ name: "a" }, { name: "b", requests: 1 }]).map((c) => c.name)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("periodDelta", () => {
  it("computes delta and percent vs previous period", () => {
    expect(periodDelta(120, 100)).toEqual({ delta: 20, pct: 20 });
    expect(periodDelta(50, 100)).toEqual({ delta: -50, pct: -50 });
  });

  it("returns null percent when there is no previous data", () => {
    expect(periodDelta(100, 0)).toEqual({ delta: 100, pct: null });
  });
});
