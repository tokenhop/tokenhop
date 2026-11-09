// Budget UTC calendar windows (YAN-372, ADR-0007), shared by the gateway
// guard, the budget routes and the dashboard meters (YAN-1833). Pure, no
// imports, so it is safe in client bundles.

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
