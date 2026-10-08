/**
 * Client helpers for the account routes (YAN-371). Each throws
 * `Error(body.error)` with `.code` set on any non-2xx response.
 */

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** @param {string} workspaceId */
export const switchWorkspace = (workspaceId) =>
  request("/api/me/workspace", "POST", { workspaceId });

export const fetchIdentities = () => request("/api/me/identities", "GET");

/** @param {string} id */
export const unlinkIdentity = (id) =>
  request(`/api/me/identities/${encodeURIComponent(id)}`, "DELETE");

export const signOut = () => request("/api/auth/logout", "POST");

export const signOutEverywhere = () => request("/api/auth/logout-all", "POST");
