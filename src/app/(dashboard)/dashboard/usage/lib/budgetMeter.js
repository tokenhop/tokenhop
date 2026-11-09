// Budget meter math shared by Usage > Budgets and the Home budget tile
// (YAN-1833), so both surfaces show the same numbers for the same row. Pure:
// it reads only the GET /api/workspaces/:id/budgets row shape
// ({ limitUsd, limitTokens, limitRequests, spent: { usd, tokens, requests } }).

import { WINDOWS, windowEnd } from "@/lib/users/budgets.js";

/** Dollar amount, "—" when unknown. */
export const money = (n) =>
  n == null ? "—" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** Compact count (tokens, requests), "—" when unknown. */
export const count = (n) =>
  n == null ? "—" : Number(n).toLocaleString(undefined, { notation: "compact" });

/** Percentage of `limit` left (0..100), null without a positive limit. */
export const pctLeft = (spent, limit) =>
  limit > 0 ? Math.max(0, 100 - ((spent ?? 0) / limit) * 100) : null;

/** Rounded percentage of `limit` used (may exceed 100), 0 without a positive limit. */
export const pctUsed = (spent, limit) => (limit > 0 ? Math.round(((spent ?? 0) / limit) * 100) : 0);

/**
 * The budget's limited units in display order, each with its spend.
 * @param {object} budget GET budgets row
 * @returns {Array<{ unit: "usd"|"tokens"|"requests", label: string, spent: number|undefined, limit: number, format: (n: number|null|undefined) => string }>}
 */
export function budgetLimitRows(budget) {
  const spent = budget?.spent || {};
  return [
    { unit: "usd", label: "Cost", spent: spent.usd, limit: budget?.limitUsd, format: money },
    {
      unit: "tokens",
      label: "Tokens",
      spent: spent.tokens,
      limit: budget?.limitTokens,
      format: count,
    },
    {
      unit: "requests",
      label: "Requests",
      spent: spent.requests,
      limit: budget?.limitRequests,
      format: count,
    },
  ].filter((row) => row.limit != null);
}

/**
 * How close the budget is to its cap: the highest used fraction over its
 * limited units (a zero limit with no spend counts as 0, any spend as over).
 * @param {object} budget GET budgets row
 * @returns {number} 0 when nothing is limited
 */
export function budgetUsedFraction(budget) {
  let max = 0;
  for (const row of budgetLimitRows(budget)) {
    const spent = Number(row.spent) || 0;
    const fraction = row.limit > 0 ? spent / row.limit : spent > 0 ? Number.POSITIVE_INFINITY : 0;
    if (fraction > max) max = fraction;
  }
  return max;
}

/**
 * Up to `max` budgets closest to their cap first (ties keep list order).
 * @param {Array<object>} budgets GET budgets rows
 * @param {number} [max]
 * @returns {Array<object>}
 */
export function pickTightestBudgets(budgets, max = 3) {
  if (!Array.isArray(budgets)) return [];
  return budgets
    .map((budget, index) => ({ budget, index, used: budgetUsedFraction(budget) }))
    .sort((a, b) => b.used - a.used || a.index - b.index)
    .slice(0, max)
    .map((entry) => entry.budget);
}

/**
 * Is this unit past its cap? Exact (no rounding); a zero cap is over as soon
 * as anything is spent.
 * @param {{ spent?: number, limit: number }} row a budgetLimitRows row
 * @returns {boolean}
 */
export const isOverCap = (row) => {
  const spent = Number(row?.spent) || 0;
  return row?.limit > 0 ? spent > row.limit : spent > 0;
};

/**
 * Next reset of the budget's current window as ISO, null for `total`.
 * The stored `resetAt` is written on create/edit only and goes stale after
 * the first window, while `spent` always covers the current UTC window, so
 * the reset is derived from the window (same UTC calendar as the guard).
 * @param {object} budget GET budgets row
 * @param {number} [now] epoch ms
 * @returns {string|null}
 */
export function budgetResetAt(budget, now = Date.now()) {
  if (!WINDOWS.includes(budget?.window)) return budget?.resetAt ?? null;
  const end = windowEnd(budget.window, now);
  return end == null ? null : new Date(end).toISOString();
}
