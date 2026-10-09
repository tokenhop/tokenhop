/**
 * Client helper: POST one budget row onto the workspace budgets API (YAN-376,
 * ADR-0007). Used after a key/grant is already created — the second POST must
 * never lose the first result, so callers treat a throw as "partial success,
 * retry me" and keep whatever the first POST returned.
 *
 * Errors are `Error(message)` with `.status`; the message comes from the
 * server body or a fixed fallback, never from echoing the payload (no secret
 * output). "retry caller can invoke same helper only after known created id":
 * the scopeId passed here is that created id, so a retry re-posts the exact
 * same row against a scope that already exists — never creates a second
 * key/grant.
 */

const SCOPE_TYPES = ["key", "grant"];
const WINDOWS = ["day", "week", "month", "total"];

/** Read one JSON body without throwing (empty/HTML error bodies → null). */
const readJson = (res) => res.json().catch(() => null);

const invalid = (message) => {
  const err = new Error(message);
  err.status = 0; // client-side: request never sent
  return err;
};

const toLimit = (limitUsd) =>
  typeof limitUsd === "number" ? limitUsd : Number(String(limitUsd).trim());

/**
 * Create a budget for an already-created key or grant scope.
 *
 * @param {object} input
 * @param {string} input.workspaceId Owning (source) workspace id.
 * @param {"key"|"grant"} input.scopeType
 * @param {string} input.scopeId The created key/grant id.
 * @param {"day"|"week"|"month"|"total"} input.window
 * @param {number|string} input.limitUsd Positive finite USD limit.
 * @returns {Promise<object>} `{ budget }` from a 2xx response.
 * @throws {Error} `.status === 0` for invalid input (no fetch); `.status` is
 *   the HTTP status on server failure. Message is safe to display.
 */
export async function createBudget({ workspaceId, scopeType, scopeId, window, limitUsd }) {
  if (!SCOPE_TYPES.includes(scopeType)) throw invalid("Unsupported budget scope type.");
  if (!WINDOWS.includes(window)) throw invalid("Unsupported budget window.");
  if (typeof workspaceId !== "string" || workspaceId.trim() === "")
    throw invalid("A workspace is required for the budget.");
  if (typeof scopeId !== "string" || scopeId.trim() === "")
    throw invalid("The created key or connection is required for the budget.");
  const limit = toLimit(limitUsd);
  if (!Number.isFinite(limit) || limit <= 0) throw invalid("Enter a spend limit greater than 0.");

  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/budgets`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scopeType, scopeId, window, limitUsd: limit }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    const err = new Error(data?.error || "Could not save the budget. Try again.");
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}
