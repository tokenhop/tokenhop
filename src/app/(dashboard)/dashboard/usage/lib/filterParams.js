/**
 * Shared usage-scope query helper (YAN-376): appends only non-empty
 * workspace/view/user/api-key scope values to a usage URL.
 * @param {string} url base URL, with or without an existing query string
 * @param {{workspaceId?: string, view?: string, userId?: string, apiKeyId?: string}|null|undefined} filters scope values
 * @returns {string} url unchanged when filters is null/{} / all empty
 */
const FILTER_KEYS = ["workspaceId", "view", "userId", "apiKeyId"];

export function appendUsageFilters(url, filters) {
  if (!filters) return url;
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, String(value));
    }
  }
  if ([...params].length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${params}`;
}
