import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSsr } from "../helpers/renderSsr.js";
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

describe("CombosTop pruned-before-tracking note (YAN-1701)", () => {
  const note =
    "May not include combo requests from history pruned before this version tracked them.";
  let ssr;
  let CombosTop;
  beforeAll(async () => {
    ssr = await createSsr();
    ({ default: CombosTop } = await ssr.load("/src/app/(dashboard)/dashboard/home/CombosTop.js"));
  });
  afterAll(async () => {
    await ssr.close();
  });

  const render = (props) =>
    renderToStaticMarkup(
      createElement(CombosTop, {
        combos: [{ name: "alpha", models: ["openai/gpt-5"] }],
        strategies: {},
        globalStrategy: "fallback",
        usageByCombo: new Map([["alpha", 3]]),
        loading: false,
        error: null,
        onRetry: () => {},
        ...props,
      }),
    );

  it("shows the note when combos render and the flag is on", () => {
    const html = render({ prunedBeforeTracking: true });
    expect(html).toContain("alpha");
    expect(html).toContain(note);
  });

  it("hides the note when the flag is off", () => {
    const html = render({ prunedBeforeTracking: false });
    expect(html).toContain("alpha");
    expect(html).not.toContain(note);
  });

  it("hides the note when there are no combos, even with the flag on", () => {
    const html = render({ combos: [], prunedBeforeTracking: true });
    expect(html).toContain("No combos yet");
    expect(html).not.toContain(note);
  });
});
