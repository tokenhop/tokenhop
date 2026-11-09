import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSsr } from "../helpers/renderSsr.js";

// YAN-1833: the Home budget tile shows the same spent / cap text as the
// Usage > Budgets LimitRow, because both use the shared budgetMeter helpers.

const budget = (over = {}) => ({
  id: "b1",
  scopeType: "workspace",
  scopeId: null,
  window: "month",
  limitUsd: 50,
  limitTokens: 2_000_000,
  limitRequests: null,
  softLimitPct: 80,
  resetAt: null,
  spent: { usd: 12.345, tokens: 1_500_000, requests: 40, notionalUsd: 12.345 },
  notices: { soft: false, hard: false },
  ...over,
});

describe("BudgetWatch", () => {
  let ssr;
  let BudgetWatchCard;
  let helpers;
  let labels;
  beforeAll(async () => {
    ssr = await createSsr();
    ({ BudgetWatchCard } = await ssr.load("/src/app/(dashboard)/dashboard/home/BudgetWatch.js"));
    helpers = await ssr.load("/src/app/(dashboard)/dashboard/usage/lib/budgetMeter.js");
    labels = await ssr.load("/src/app/(dashboard)/dashboard/usage/lib/budgetLabels.js");
  });
  afterAll(async () => {
    await ssr.close();
  });

  const render = (props) =>
    renderToStaticMarkup(
      createElement(BudgetWatchCard, { budgets: [], loading: false, error: null, ...props }),
    );

  it("renders nothing when empty, loading, or failed", () => {
    expect(render({ budgets: [] })).toBe("");
    expect(render({ budgets: undefined })).toBe("");
    expect(render({ budgets: [budget()], loading: true })).toBe("");
    expect(render({ budgets: [budget()], error: "boom" })).toBe("");
  });

  it("shows spent / cap text identical to the Usage > Budgets rows", () => {
    const row = budget();
    const html = render({ budgets: [row] });
    for (const limit of helpers.budgetLimitRows(row)) {
      expect(html).toContain(`${limit.format(limit.spent)} / ${limit.format(limit.limit)}`);
    }
    expect(html).toContain(labels.SCOPE_LABELS.workspace);
    expect(html).toContain(labels.WINDOW_LABELS.month);
    expect(html).toContain("Soft at 80%");
    expect(html).not.toContain("Requests");
  });

  it("links to Usage > Budgets", () => {
    expect(render({ budgets: [budget()] })).toContain('href="/dashboard/usage?tab=budgets"');
  });

  it("shows a derived reset for calendar windows and none for total", () => {
    for (const window of ["day", "week", "month"]) {
      const html = render({ budgets: [budget({ window, resetAt: "2020-01-01T00:00:00.000Z" })] });
      expect(html).not.toContain("Reset pending");
      expect(html).toMatch(/Resets (in )?[0-9A-Z]/);
    }
    expect(render({ budgets: [budget({ window: "total" })] })).toContain("Never resets");
  });

  it("marks over-cap and hit limits", () => {
    const over = render({ budgets: [budget({ spent: { usd: 60, tokens: 0, requests: 0 } })] });
    expect(over).toContain("Over");
    const hit = render({ budgets: [budget({ notices: { soft: true, hard: true } })] });
    expect(hit).toContain("Limit hit");
    expect(hit).not.toContain("Soft limit reached");
    const soft = render({ budgets: [budget({ notices: { soft: true, hard: false } })] });
    expect(soft).toContain("Soft limit reached");
    const zeroCap = render({
      budgets: [budget({ limitUsd: 0, limitTokens: null, spent: { usd: 0.01 } })],
    });
    expect(zeroCap).toContain("Over");
  });
});

describe("Usage > Budgets markers (shared BudgetMarker)", () => {
  let ssr;
  let BudgetMarker;
  let helpers;
  beforeAll(async () => {
    ssr = await createSsr();
    ({ default: BudgetMarker } = await ssr.load(
      "/src/app/(dashboard)/dashboard/usage/components/BudgetMarker.js",
    ));
    helpers = await ssr.load("/src/app/(dashboard)/dashboard/usage/lib/budgetMeter.js");
  });
  afterAll(async () => {
    await ssr.close();
  });

  const mark = (row) =>
    renderToStaticMarkup(
      createElement(BudgetMarker, { budget: row, limits: helpers.budgetLimitRows(row) }),
    );

  it("marks an exact overrun and a zero cap, and prefers the hard notice", () => {
    expect(mark(budget({ spent: { usd: 50.01 } }))).toContain("Over");
    expect(mark(budget({ spent: { usd: 50 }, limitTokens: null }))).toBe("");
    expect(mark(budget({ limitUsd: 0, limitTokens: null, spent: { usd: 0.01 } }))).toContain(
      "Over",
    );
    expect(mark(budget({ notices: { soft: true, hard: true } }))).toContain("Limit hit");
  });
});
