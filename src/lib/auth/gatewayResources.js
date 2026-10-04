import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { getProviderConnectionsUnscoped } from "../db/repos/connectionsRepo.js";
import { getProviderNodesUnscoped } from "../db/repos/nodesRepo.js";

// Gateway principals are not dashboard principals. Service keys have no userId;
// their resolved workspace is authority, never an owner/admin impersonation.
// "mitm" is the internal local-child credential: owner+Default, gateway-only.
const GATEWAY_VIA = new Set(["apiKey", "cli", "local", "mitm"]);

function assertGatewayPrincipal(principal) {
  if (
    typeof principal.workspaceId !== "string" ||
    !principal.workspaceId ||
    !GATEWAY_VIA.has(principal.via) ||
    (principal.via === "apiKey" && typeof principal.apiKeyId !== "string") ||
    !Object.isFrozen(principal)
  ) {
    throw new Error("Invalid gateway principal");
  }
  return principal.workspaceId;
}

export async function requireGatewayWorkspace(principal) {
  const db = await getAdapter();
  if (principal) {
    return { db, workspaceId: assertGatewayPrincipal(principal) };
  }
  if (readApiKeyStorageState(db).storage !== "legacy") {
    throw new Error("Hashed gateway routing requires a principal");
  }
  return { db, workspaceId: null };
}

function decodeRow({ data, ...row }) {
  return { ...parseJson(data, {}), ...row };
}

export async function getGatewayConnections(principal, filter = {}) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) return getProviderConnectionsUnscoped(filter);
  const where = ["workspaceId = ?"];
  const params = [workspaceId];
  if (filter.provider) {
    where.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  return db
    .all(`SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`, params)
    .map((row) => ({ ...decodeRow(row), isActive: row.isActive === 1 || row.isActive === true }))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

export async function getGatewayNodes(principal, filter = {}) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) return getProviderNodesUnscoped(filter);
  const params = [workspaceId];
  let sql = "SELECT * FROM providerNodes WHERE workspaceId = ?";
  if (filter.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  return db.all(sql, params).map(decodeRow);
}
