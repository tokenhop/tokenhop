import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSsr } from "../helpers/renderSsr.js";

const api = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("../../src/app/(dashboard)/dashboard/token-saver/tokenSaverApi", () => api);

let slots;
let index;
let effectRan;
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal()),
  useState(initial) {
    const slot = index++;
    slots[slot] ??= { value: initial };
    return [
      slots[slot].value,
      (value) => {
        slots[slot].value = typeof value === "function" ? value(slots[slot].value) : value;
      },
    ];
  },
  useEffect(fn) {
    if (!effectRan) {
      effectRan = true;
      fn();
    }
  },
}));

import { useSavingsWithFallback } from "../../src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js";

const renderHook = (period) => {
  index = 0;
  return useSavingsWithFallback(period);
};

beforeEach(() => {
  slots = [];
  index = 0;
  effectRan = false;
  api.fetchJson.mockReset();
});

describe("empty savings verdict", () => {
  it.each([false, true])("empty all with prunedBeforeTracking=%s", async (pruned) => {
    api.fetchJson.mockResolvedValue({ tokensSavedEst: 0, prunedBeforeTracking: pruned });
    renderHook("all");
    // The resolved fetch and the hook's async continuation finish in this microtask turn.
    await Promise.resolve();
    expect(renderHook("all")).toMatchObject({
      loading: false,
      neverSaved: !pruned,
      prunedBeforeTracking: pruned,
    });
  });

  it("does not claim never saved when the empty widest probe has pruned history", async () => {
    api.fetchJson
      .mockResolvedValueOnce({ tokensSavedEst: 0, prunedBeforeTracking: false })
      .mockResolvedValueOnce({ tokensSavedEst: 0, prunedBeforeTracking: true });
    renderHook("7d");
    await Promise.resolve();
    await Promise.resolve();
    expect(renderHook("7d")).toMatchObject({
      loading: false,
      neverSaved: false,
      prunedBeforeTracking: true,
    });
    expect(api.fetchJson.mock.calls.map(([url]) => url)).toEqual([
      "/api/usage/savings?period=7d&compare=previous",
      "/api/usage/savings?period=all",
    ]);
  });
});

describe("savings coverage note rendering", () => {
  const note = "May not include savings from history pruned before this version tracked them.";
  let ssr;
  let SavingsHero;
  beforeAll(async () => {
    ssr = await createSsr();
    ({ SavingsHero } = await ssr.load("/src/app/(dashboard)/dashboard/token-saver/SavingsHero.js"));
  });
  afterAll(async () => {
    await ssr.close();
  });

  const render = (props) =>
    renderToStaticMarkup(
      createElement(SavingsHero, {
        period: "all",
        loading: false,
        error: null,
        onRetry: () => {},
        ...props,
      }),
    );

  it.each([false, true])("empty state with prunedBeforeTracking=%s", (pruned) => {
    const html = render({
      savings: { tokensSavedEst: 0 },
      neverSaved: !pruned,
      prunedBeforeTracking: pruned,
    });
    expect(html.includes(note)).toBe(pruned);
    expect(html).toContain(pruned ? "No savings in this period" : "No savings recorded yet");
  });

  it.each([false, true])("filled state with savings.prunedBeforeTracking=%s", (pruned) => {
    const html = render({ savings: { tokensSavedEst: 100, prunedBeforeTracking: pruned } });
    expect(html.includes(note)).toBe(pruned);
    expect(html).toContain("Saved all time");
  });

  const costSavings = (current, previous, previousPriced = 4) => ({
    tokensSavedEst: 100,
    currentTotals: {
      tokensSavedEst: 100,
      costSavedEst: current,
      requestsWithSavings: 5,
      pricedRequests: 5,
    },
    previous: {
      tokensSavedEst: 80,
      costSavedEst: previous,
      requestsWithSavings: 4,
      pricedRequests: previousPriced,
    },
  });

  it("renders the cost-saved trend when both windows are priced", () => {
    const html = render({ period: "7d", savings: costSavings(1.5, 1) });
    expect(html).toContain("Cost saved");
    expect(html).toContain("+50%");
    expect(html).toContain("vs prior 7d");
  });

  it.each([
    ["all", 1.5, 1],
    ["7d", null, 1],
    ["7d", 1.5, null],
    ["7d", 1.5, 0],
  ])("hides the cost-saved trend for period=%s current=%s previous=%s", (period, cur, prev) => {
    expect(render({ period, savings: costSavings(cur, prev) })).not.toContain("Cost saved");
  });

  it("hides the cost-saved trend when the windows' priced shares differ (YAN-1788)", () => {
    // Current fully priced, previous 1 of 4 priced: 75 points apart.
    expect(render({ period: "7d", savings: costSavings(1.5, 1, 1) })).not.toContain("Cost saved");
  });
});
