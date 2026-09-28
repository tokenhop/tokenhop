/**
 * Fetch JSON with no-store; throws Error(message) on non-2xx.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
