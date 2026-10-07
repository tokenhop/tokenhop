import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { decodeCredentialRowSync } from "../db/helpers/credentialStorage.js";
import { TABLE_NAMES } from "../security/envelope.js";
import {
  getProviderConnectionsUnscoped,
  prepareCredentialCtx,
} from "../db/repos/connectionsRepo.js";
import { getProviderNodesUnscoped } from "../db/repos/nodesRepo.js";
import { listActiveGrantsForPrincipal } from "../db/repos/connectionGrantsRepo.js";
import { resolveSharing } from "../users/grants.js";
import * as combosRepo from "../db/repos/combosRepo.js";
import * as aliasRepo from "../db/repos/aliasRepo.js";
import * as disabledModelsRepo from "../db/repos/disabledModelsRepo.js";

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

// YAN-365: raw gateway reads bypass the repos, so decrypt here — after SQL has
// already selected the principal's workspace. Coordinates come from the stored
// SQL row (never the principal or caller), and a typed integrity/key failure
// propagates instead of yielding an empty credential.
function decodeRow(db, ctx, table, row) {
  const { data: _data, ...columns } = row;
  return { ...decodeCredentialRowSync(db, row, ctx, { table }), ...columns };
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
  const ctx = await prepareCredentialCtx(db);
  const decode = (row) => ({
    ...decodeRow(db, ctx, TABLE_NAMES.providerConnections, row),
    isActive: row.isActive === 1 || row.isActive === true,
  });
  const own = db
    .all(`SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`, params)
    .map(decode)
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return [...own, ...grantedConnections(db, principal, filter, own, decode)];
}

// YAN-369 (ADR-0006): connections granted to the principal's workspace or user,
// appended AFTER the own rows (own wins on duplicate id; never re-sorted across
// the union). Re-read on every call — no cache, so revocation is immediate.
// Defense in depth: a "personal" connection without a recorded ToS
// acknowledgement never resolves, whatever the grant row says.
function grantedConnections(db, principal, filter, own, decode) {
  const seen = new Set(own.map((c) => c.id));
  const out = [];
  const grants = listActiveGrantsForPrincipal(db, {
    workspaceId: principal.workspaceId,
    userId: principal.userId ?? null,
  });
  for (const g of grants) {
    const row = g.connection;
    if (!row || seen.has(row.id)) continue;
    if (filter.provider && row.provider !== filter.provider) continue;
    if (
      filter.isActive !== undefined &&
      (row.isActive === 1 || row.isActive === true) !== !!filter.isActive
    )
      continue;
    if (resolveSharing(row.provider, row.authType) === "personal" && !g.tosAcknowledgedAt) continue;
    seen.add(row.id);
    out.push({
      ...decode(row),
      grantId: g.grantId,
      grantAllowedModels: g.allowedModels ?? null,
      grantRpm: g.rpm ?? null,
      grantTpm: g.tpm ?? null,
    });
  }
  return out.sort((a, b) => (a.priority || 999) - (b.priority || 999));
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
  const ctx = await prepareCredentialCtx(db);
  return db.all(sql, params).map((row) => decodeRow(db, ctx, TABLE_NAMES.providerNodes, row));
}

// YAN-364: principal-scoped combo/model reads. Scoped miss (or empty) never
// falls back to global reads — resolution falls through to built-ins only.
// Legacy storage (workspaceId null) keeps the global path byte-identical.
const COMBO_ORDER_BY = `sortOrder IS NULL, sortOrder ASC, createdAt ASC, id ASC`;

function rowToGatewayCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Equivalent of makeKv(scope, { workspaceId }) prefix reads (Task 2.1) via a
// substr query — never LIKE (alias keys may contain %/_). Strips the prefix.
function getScopedKvMap(db, scope, workspaceId) {
  const prefix = `ws:${workspaceId}/`;
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
    scope,
    prefix.length,
    prefix,
  ]);
  const out = {};
  for (const r of rows) out[r.key.slice(prefix.length)] = r.value;
  return out;
}

export async function getGatewayCombos(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = combosRepo.getCombosUnscoped;
    return getAll();
  }
  return db
    .all(`SELECT * FROM combos WHERE workspaceId = ? ORDER BY ${COMBO_ORDER_BY}`, [workspaceId])
    .map(rowToGatewayCombo);
}

export async function getGatewayAliases(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = aliasRepo.getModelAliasesUnscoped;
    return getAll();
  }
  const raw = getScopedKvMap(db, "modelAliases", workspaceId);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseJson(v);
  return out;
}

export async function getGatewayCustomModels(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = aliasRepo.getCustomModelsUnscoped;
    return getAll();
  }
  return Object.values(getScopedKvMap(db, "customModels", workspaceId)).map((v) => parseJson(v));
}

export async function getGatewayDisabled(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = disabledModelsRepo.getDisabledModelsUnscoped;
    return getAll();
  }
  const raw = getScopedKvMap(db, "disabledModels", workspaceId);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseJson(v, []);
  return out;
}
