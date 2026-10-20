import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { decodeRequestCredentialRows, requestScopeOf } from "../security/requestCredentialScope.js";
import { TABLE_NAMES } from "../security/envelope.js";
import { getProviderConnectionsUnscoped } from "../db/repos/connectionsRepo.js";
import {
  getProviderNodesUnscoped,
  getProviderNodesRoutingUnscoped,
} from "../db/repos/nodesRepo.js";
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

// Per-request memo for the scoped reads below (nodes metadata, combos, aliases,
// custom models, disabled map). They live on the minted principal's RequestScope,
// so they die with the request and never cross requests or principals; a forged,
// plain or aged principal reads live. Results are deep-frozen because every
// consumer of one request shares them. Connections and grants are NOT memoized
// (grant revocation must stay live), and `live: true` bypasses the memo for
// rechecks that must observe a change made since the first read.
const memoKeys = new Map(); // read name → Symbol (private slot, finite set of names)
const memoKeyFor = (name) => {
  let key = memoKeys.get(name);
  if (!key) {
    key = Symbol(`tokenhop.gateway.${name}`);
    memoKeys.set(name, key);
  }
  return key;
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// These are plain config reads: they need the scope only for memoization, never
// for credentials. A dead scope (rotation/poison mid-request) therefore degrades
// to a live read instead of failing the request; credential reads keep the typed
// KEY_MISMATCH. Any other error (including a loader failure) propagates.
const scopeDied = (error) => error?.code === "KEY_MISMATCH";

async function scopedRead(principal, db, name, live, load) {
  if (live) return load();
  let scope;
  try {
    scope = requestScopeOf(principal, db);
  } catch (error) {
    if (scopeDied(error)) return load();
    throw error;
  }
  if (!scope) return load();
  try {
    return await scope.memo(memoKeyFor(name), async () => deepFreeze(await load()));
  } catch (error) {
    if (scopeDied(error)) return load();
    throw error;
  }
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

// YAN-365/YAN-378: raw gateway reads bypass the repos, so decrypt here — after
// SQL has already selected the principal's workspace. Decryption goes through
// the request credential scope (rows in, row data out): the runtime ctx and
// the root never reach this layer. Coordinates come from the stored SQL row
// (never the principal or caller), and a typed integrity/key failure
// propagates instead of yielding an empty credential.
function withColumns(rows, decoded) {
  return rows.map((row, i) => {
    const { data: _data, ...columns } = row;
    return { ...decoded[i], ...columns };
  });
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
  const ownRows = db
    .all(`SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`, params)
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  const granted = grantedConnections(db, principal, filter, ownRows);
  const decoded = await decodeRequestCredentialRows(
    db,
    principal,
    [...ownRows, ...granted.map((g) => g.row)],
    { table: TABLE_NAMES.providerConnections },
  );
  const own = withColumns(ownRows, decoded).map((c) => ({
    ...c,
    isActive: c.isActive === 1 || c.isActive === true,
  }));
  const grantedOut = withColumns(
    granted.map((g) => g.row),
    decoded.slice(ownRows.length),
  ).map((c, i) => ({
    ...c,
    isActive: c.isActive === 1 || c.isActive === true,
    grantId: granted[i].grantId,
    grantAllowedModels: granted[i].allowedModels ?? null,
    grantRpm: granted[i].rpm ?? null,
    grantTpm: granted[i].tpm ?? null,
  }));
  return [...own, ...grantedOut];
}

// YAN-369 (ADR-0006): connections granted to the principal's workspace or user,
// appended AFTER the own rows (own wins on duplicate id; never re-sorted across
// the union). Re-read on every call — no cache, so revocation is immediate.
// Defense in depth: a "personal" connection without a recorded ToS
// acknowledgement never resolves, whatever the grant row says.
function grantedConnections(db, principal, filter, own) {
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
    out.push({ row, grantId: g.grantId, allowedModels: g.allowedModels, rpm: g.rpm, tpm: g.tpm });
  }
  return out.sort((a, b) => (a.row.priority || 999) - (b.row.priority || 999));
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
  const rows = db.all(sql, params);
  const decoded = await decodeRequestCredentialRows(db, principal, rows, {
    table: TABLE_NAMES.providerNodes,
  });
  return withColumns(rows, decoded);
}

// Secret-free allowlisted node read for routing (prefix/type/workspace): never
// decrypts, never loads the root key. Workspace comes only from the validated
// principal (a caller-supplied workspaceId is ignored), so
// this keeps its own requireGatewayWorkspace as the trust boundary. Upstream
// credentials still come from getGatewayNodes/connection decrypt.
export async function getGatewayNodesMetadata(principal, { types } = {}) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  const load = () => getProviderNodesRoutingUnscoped({ types, workspaceId });
  if (!workspaceId) return load();
  // `undefined` (every type) and `[]` (no type) are different queries: key them apart.
  const typesKey = JSON.stringify(types == null ? null : [...types].sort());
  return scopedRead(principal, db, `nodes:${typesKey}`, false, load);
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
  return scopedRead(principal, db, "combos", false, async () =>
    db
      .all(`SELECT * FROM combos WHERE workspaceId = ? ORDER BY ${COMBO_ORDER_BY}`, [workspaceId])
      .map(rowToGatewayCombo),
  );
}

export async function getGatewayAliases(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = aliasRepo.getModelAliasesUnscoped;
    return getAll();
  }
  return scopedRead(principal, db, "aliases", false, async () => {
    const raw = getScopedKvMap(db, "modelAliases", workspaceId);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = parseJson(v);
    return out;
  });
}

export async function getGatewayCustomModels(principal) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = aliasRepo.getCustomModelsUnscoped;
    return getAll();
  }
  return scopedRead(principal, db, "customModels", false, async () =>
    Object.values(getScopedKvMap(db, "customModels", workspaceId)).map((v) => parseJson(v)),
  );
}

export async function getGatewayDisabled(principal, { live = false } = {}) {
  const { db, workspaceId } = await requireGatewayWorkspace(principal);
  if (!workspaceId) {
    const getAll = disabledModelsRepo.getDisabledModelsUnscoped;
    return getAll();
  }
  return scopedRead(principal, db, "disabled", live, async () => {
    const raw = getScopedKvMap(db, "disabledModels", workspaceId);
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = parseJson(v, []);
    return out;
  });
}
