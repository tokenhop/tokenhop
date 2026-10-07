// Budget primitives shared by the budget repo/routes and the gateway guard
// (YAN-372, ADR-0007). Pure: UTC calendar windows, raise/lower diff, the
// membership scope id, and a change counter the gateway cache keys on.

export const SCOPE_TYPES = ["key", "user", "membership", "workspace", "grant"];
export const WINDOWS = ["day", "week", "month", "total"];
export const LIMIT_FIELDS = ["limitUsd", "limitTokens", "limitRequests"];

/** membership scopeId: "<workspaceId>:<userId>". */
export const membershipScopeId = (workspaceId, userId) => `${workspaceId}:${userId}`;

/**
 * Start of the UTC calendar window containing `now`. Weeks start Monday 00:00
 * UTC. `total` starts at the epoch (never resets).
 * @param {"day"|"week"|"month"|"total"} window
 * @param {number} [now] epoch ms
 * @returns {number} epoch ms
 */
export function windowStart(window, now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (window === "day") return Date.UTC(y, m, day);
  if (window === "week") return Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7));
  if (window === "month") return Date.UTC(y, m, 1);
  if (window === "total") return 0;
  throw new Error(`unknown budget window ${window}`);
}

/** Next UTC boundary after `now`, or null for `total`. @returns {number|null} */
export function windowEnd(window, now = Date.now()) {
  const s = new Date(windowStart(window, now));
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const day = s.getUTCDate();
  if (window === "day") return Date.UTC(y, m, day + 1);
  if (window === "week") return Date.UTC(y, m, day + 7);
  if (window === "month") return Date.UTC(y, m + 1, 1);
  return null;
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
