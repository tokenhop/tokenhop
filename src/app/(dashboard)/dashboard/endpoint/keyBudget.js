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

/**
 * Whether key create can offer the spend-limit fields (YAN-1829): hashed
 * storage only, and the budget POST must be able to succeed. With the Users &
 * teams switch on any workspace works; with it off only the Default
 * workspace's budget routes exist, so another workspace hides the fields
 * instead of failing after the key is created.
 *
 * @param {object} input
 * @param {boolean} input.hashedMode Key storage is hashed.
 * @param {string|null|undefined} input.workspaceId Key context workspace.
 * @param {boolean} input.multiUser Users & teams switch (shell summary).
 * @param {Array<{id: string, isDefault?: boolean}>|undefined} input.workspaces
 *   `/api/auth/status` principal workspaces.
 * @returns {boolean}
 */
export function keyBudgetsAvailable({ hashedMode, workspaceId, multiUser, workspaces }) {
  if (!hashedMode || !workspaceId) return false;
  if (multiUser === true) return true;
  return Array.isArray(workspaces)
    ? workspaces.some((w) => w?.isDefault === true && w.id === workspaceId)
    : false;
}
