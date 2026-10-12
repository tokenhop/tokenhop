/**
 * Workspace detail + guarded delete client helpers (YAN-373). Local to this
 * folder; the shared admin API module belongs to the parent. Same error
 * contract as adminApi.js: non-2xx throws `Error(body.error)` with `.code`
 * and `.status`. Secrets (passwords, proofs) are only ever request bodies:
 * never logged, stored or put in a URL.
 */

async function call(url, method, body) {
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
    err.retryAfter = data.retryAfter;
    throw err;
  }
  return data;
}

const base = (id) => `/api/workspaces/${encodeURIComponent(id)}`;

/**
 * @typedef {object} WorkspaceDetail
 * @property {{ id: string, name: string, kind: string, createdAt: string, updatedAt: string, memberCount: number, isDefault: boolean }} workspace
 * @property {{ connections: number, nodes: number, combos: number, apiKeys: number|null, apiKeysLegacy?: boolean, invitations: number, budgets: number, grantsOut: number }} counts
 * @property {{ dekWrapped: boolean }} encryption
 */

/** @param {string} id @returns {Promise<WorkspaceDetail>} */
export const getWorkspace = (id) => call(base(id), "GET");

/**
 * Strict 3-key DELETE body: exactly one of `currentPassword` / `ssoProof`.
 * @param {string} id
 * @param {{ currentPassword?: string, ssoProof?: string }} proof
 */
export const deleteWorkspace = (id, proof) => {
  const body = { confirmWorkspaceId: id, acknowledgeDekDestruction: true };
  if (typeof proof.ssoProof === "string") body.ssoProof = proof.ssoProof;
  else body.currentPassword = proof.currentPassword ?? "";
  return call(base(id), "DELETE", body);
};

/**
 * Begin a fresh IdP login bound to this workspace.
 * @param {string} id @param {"oidc"|"saml"} provider
 * @returns {Promise<{ authorizeUrl: string }>}
 */
export const startWorkspaceReauth = (id, provider) =>
  call(`${base(id)}/reauth`, "POST", { provider });

/**
 * Consume the completed SSO re-auth ONCE; the server rejects a second call.
 * @param {string} id @returns {Promise<{ ssoProof: string }>}
 */
export const consumeWorkspaceReauth = (id) => call(`${base(id)}/reauth`, "GET");

/**
 * Only http(s) IdP URLs are navigated to; anything else (javascript:, data:)
 * is rejected before leaving the page.
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeAuthorizeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
