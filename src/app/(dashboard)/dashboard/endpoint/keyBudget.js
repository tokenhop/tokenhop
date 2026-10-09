/**
 * Key-create budget fields (YAN-376): parse the optional USD limit + spend
 * window into the payload shape for shared/utils/createBudget. An empty
 * limit means no budget POST at all. Error literals mirror createBudget so
 * the create form shows the same copy the helper would throw.
 */

const WINDOWS = ["day", "week", "month", "total"];

/**
 * @param {string|number|null} usd Raw spend-limit input ("" or null = off).
 * @param {string} window One of day/week/month/total.
 * @returns {{ budget: { limitUsd: number, window: string } | null, error: string | null }}
 */
export function parseKeyBudget(usd, window) {
  if (usd === "" || usd == null) return { budget: null, error: null };
  const limit = Number(String(usd).trim());
  if (!Number.isFinite(limit) || limit <= 0)
    return { budget: null, error: "Enter a spend limit greater than 0." };
  if (!WINDOWS.includes(window)) return { budget: null, error: "Unsupported budget window." };
  return { budget: { limitUsd: limit, window }, error: null };
}
