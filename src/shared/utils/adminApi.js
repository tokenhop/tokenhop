/**
 * Client helpers for the admin routes (YAN-373): users, workspaces, members,
 * invitations. Same contract as accountApi.js: each throws
 * `Error(body.error)` with `.code` and `.status` on any non-2xx response, so
 * pages render what the server said (403 -> not authorized, 404 -> hidden).
 */

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // 204 has no JSON to parse; other successful responses must contain JSON.
  if (res.status === 204) return {};
  let data = {};
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw new Error(`Invalid response (${res.status})`);
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    err.retryAfter = data.retryAfter;
    throw err;
  }
  return data;
}

const seg = encodeURIComponent;

/**
 * Server-side filtered page: search/role/status go to the API (YAN-373).
 * @param {{ page?: number, pageSize?: number, search?: string, role?: string, status?: string }} [opts]
 */
export function listUsers({ page = 1, pageSize = 50, search, role, status } = {}) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search) q.set("search", search);
  if (role && role !== "all") q.set("role", role);
  if (status && status !== "all") q.set("status", status);
  return request(`/api/users?${q}`, "GET");
}

/** One user with `identities` (no subject) and `workspaceCount`. */
export const getUser = (id) => request(`/api/users/${seg(id)}`, "GET");

/** Ends every session of another user; their API keys keep working. */
export const signOutUserEverywhere = (id) => request(`/api/users/${seg(id)}/logout-all`, "POST");

/** @param {string} id @param {{ instanceRole?: string, status?: string }} patch */
export const updateUser = (id, patch) => request(`/api/users/${seg(id)}`, "PATCH", patch);

export const deleteUser = (id) => request(`/api/users/${seg(id)}`, "DELETE");

/** Sets a temporary password; the user must change it at next sign-in. */
export const setTemporaryPassword = (id, password) =>
  request(`/api/users/${seg(id)}/password`, "POST", { password });

/** Owner transfer with the current password as proof. */
export const transferOwnership = (toUserId, currentPassword) =>
  request("/api/users/ownership-transfer", "POST", { toUserId, currentPassword });

/** Owner transfer for SSO owners: returns `{ authorizeUrl }` to navigate to. */
export const startSsoOwnershipTransfer = (toUserId, provider) =>
  request("/api/users/ownership-transfer/sso", "POST", { toUserId, provider });

export const listWorkspaces = () => request("/api/workspaces", "GET");

export const listMembers = (workspaceId) =>
  request(`/api/workspaces/${seg(workspaceId)}/members`, "GET");

/** @param {string} workspaceId @param {{ userId: string, role: string }} member */
export const addMember = (workspaceId, member) =>
  request(`/api/workspaces/${seg(workspaceId)}/members`, "POST", member);

export const setMemberRole = (workspaceId, userId, role) =>
  request(`/api/workspaces/${seg(workspaceId)}/members/${seg(userId)}`, "PATCH", { role });

export const removeMember = (workspaceId, userId) =>
  request(`/api/workspaces/${seg(workspaceId)}/members/${seg(userId)}`, "DELETE");

export const listInvitations = (workspaceId) =>
  request(`/api/workspaces/${seg(workspaceId)}/invitations`, "GET");

/**
 * Mint an invitation. The raw `token` in the response is shown once; callers
 * must not store or log it.
 * @param {string} workspaceId
 * @param {{ role: string, email?: string }} input
 */
export const createInvitation = (workspaceId, input) =>
  request(`/api/workspaces/${seg(workspaceId)}/invitations`, "POST", input);

export const revokeInvitation = (workspaceId, inviteId) =>
  request(`/api/workspaces/${seg(workspaceId)}/invitations/${seg(inviteId)}`, "DELETE");
