// User/workspace lifecycle transport uses the same host-local owner proof as client.
const client = require("./client");
const id = encodeURIComponent;
const membersPath = (workspaceId) => `/api/workspaces/${id(workspaceId)}/members`;

module.exports = {
  listUsers(filters = {}) {
    const query = new URLSearchParams(filters).toString();
    return client.makeRequest("GET", `/api/users${query ? `?${query}` : ""}`);
  },
  getUser(userId) {
    return client.makeRequest("GET", `/api/users/${id(userId)}`);
  },
  updateUser(userId, body) {
    return client.makeRequest("PATCH", `/api/users/${id(userId)}`, body);
  },
  resetUserPassword(userId, password) {
    return client.makeRequest("POST", `/api/users/${id(userId)}/password`, { password });
  },
  transferOwner(toUserId, currentPassword) {
    return client.makeRequest("POST", "/api/users/ownership-transfer", {
      toUserId,
      currentPassword,
    });
  },
  listWorkspaces() {
    return client.makeRequest("GET", "/api/workspaces");
  },
  listMembers(workspaceId) {
    return client.makeRequest("GET", membersPath(workspaceId));
  },
  addMember(workspaceId, userId, role = "member") {
    return client.makeRequest("POST", membersPath(workspaceId), { userId, role });
  },
  removeMember(workspaceId, userId) {
    return client.makeRequest("DELETE", `${membersPath(workspaceId)}/${id(userId)}`);
  },
};
