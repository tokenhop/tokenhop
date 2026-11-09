// Budget primitives shared by the budget repo/routes and the gateway guard
// (YAN-372, ADR-0007). Pure: UTC calendar windows, raise/lower diff, the
// membership scope id, and a change counter the gateway cache keys on.

// UTC window math lives in a pure shared module so client bundles (Home and
// Usage budget meters) use the same calendar without importing this file.
import { windowEnd, windowStart } from "../../shared/utils/budgetWindow.js";

export { windowEnd, windowStart };

export const SCOPE_TYPES = ["key", "user", "membership", "workspace", "grant"];
export const WINDOWS = ["day", "week", "month", "total"];
export const LIMIT_FIELDS = ["limitUsd", "limitTokens", "limitRequests"];

/** membership scopeId: "<workspaceId>:<userId>". */
export const membershipScopeId = (workspaceId, userId) => `${workspaceId}:${userId}`;

/**
 * Limit rules shared by the budget API and imports: each limit is null or a
 * finite non-negative number (tokens/requests integers), at least one is
 * set, and softLimitPct is null or an integer 1..100.
 * @param {object} row Budget row or definition (missing fields read as null).
 * @returns {string|null} The error message, else null.
 */
export function budgetLimitsError(row) {
  for (const field of LIMIT_FIELDS) {
    const value = row[field] ?? null;
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (field !== "limitUsd" && !Number.isInteger(value)))
    )
      return "Invalid budget limit";
  }
  if (LIMIT_FIELDS.every((field) => (row[field] ?? null) === null)) return "A limit is required";
  const soft = row.softLimitPct ?? null;
  if (soft !== null && (!Number.isInteger(soft) || soft < 1 || soft > 100))
    return "Invalid soft limit";
  return null;
}

/**
 * Value rules of a portable budget definition (already projected onto its
 * fields): a known scope type and window, a string-or-null scopeId, then
 * budgetLimitsError.
 * @param {object} entry
 * @returns {string|null}
 */
export function budgetDefinitionError(entry) {
  if (!SCOPE_TYPES.includes(entry.scopeType) || !WINDOWS.includes(entry.window))
    return "Invalid budget scope or window";
  const scopeId = entry.scopeId ?? null;
  if (entry.scopeType === "workspace" ? scopeId !== null : typeof scopeId !== "string" || !scopeId)
    return "Invalid budget scopeId";
  return budgetLimitsError(entry);
}

/** ISO string of the next reset (budgets.resetAt), null for `total`. */
export function resetAtIso(window, now = Date.now()) {
  const end = windowEnd(window, now);
  return end == null ? null : new Date(end).toISOString();
}

/**
 * Does `after` loosen `before`? A limit raised, or a limit removed (set to
 * NULL = unlimited), is a raise. Deleting a budget is a raise too (callers pass
 * after = null). Raises need instance.budgets.raise (ADR-0007).
 */
export function isRaise(before, after) {
  if (!before) return false; // creating a budget only adds limits
  if (!after) return true;
  return LIMIT_FIELDS.some((f) => {
    if (before[f] == null) return false; // was unlimited: anything is a lowering
    return after[f] == null || Number(after[f]) > Number(before[f]);
  });
}

// Change counter: the budget repo bumps it after every committed write; the
// gateway guard reloads its cache when it moves. Process-wide (single instance).
if (global.__budgetsGeneration === undefined) global.__budgetsGeneration = 0;
export const budgetsGeneration = () => global.__budgetsGeneration;
export const bumpBudgetsGeneration = () => {
  global.__budgetsGeneration += 1;
};

// Switch-cache epoch (YAN-1829): the switch writer bumps it after the stored
// switch commits, so the gateway guard drops its cached switch value at once
// instead of after its TTL. Process-wide like the generation above.
if (global.__budgetSwitchEpoch === undefined) global.__budgetSwitchEpoch = 0;
export const budgetSwitchEpoch = () => global.__budgetSwitchEpoch;
export const expireBudgetSwitchCache = () => {
  global.__budgetSwitchEpoch += 1;
};

// Self-check: UTC boundaries (run: node src/lib/users/budgets.js).
if (process.argv[1]?.endsWith("lib/users/budgets.js")) {
  const assert = (await import("node:assert")).strict;
  const t = Date.UTC(2026, 9, 7, 23, 59); // Wed 2026-10-07 23:59Z
  assert.equal(new Date(windowStart("day", t)).toISOString(), "2026-10-07T00:00:00.000Z");
  assert.equal(new Date(windowStart("week", t)).toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(resetAtIso("month", Date.UTC(2026, 11, 31, 12)), "2027-01-01T00:00:00.000Z");
  assert.equal(isRaise({ limitUsd: 5 }, { limitUsd: 4 }), false);
  assert.equal(isRaise({ limitUsd: 5 }, { limitUsd: null }), true);
  assert.equal(isRaise({ limitUsd: null, limitTokens: 9 }, { limitUsd: 1, limitTokens: 9 }), false);
  console.log("budgets.js ok");
}
