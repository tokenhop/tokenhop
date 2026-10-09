// Live usage feed state (YAN-370, plan D9): in-flight counters, the recent
// ring and the stats emitter, process-wide but keyed by workspace so a scoped
// subscriber only sees its own workspace. YAN-376: counters are additionally
// keyed by identity (workspace/user/key), and a scope carrying `userId` /
// `apiKeyId` narrows pending, ring and last-error to that identity.
// `ctx` null (switch off / one user) merges every workspace: today's payload.
import { EventEmitter } from "node:events";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const EMPTY = () => ({ byModel: {}, byAccount: {} });

// In-memory state shared across Next.js modules.
if (!global._pendingByWorkspace) global._pendingByWorkspace = {};
if (!global._pendingByIdentity) global._pendingByIdentity = {};
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingByWorkspace = global._pendingByWorkspace;
const pendingByIdentity = global._pendingByIdentity;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

export function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

const inScope = (entry, ctx) =>
  !ctx ||
  (entry?.workspaceId === ctx.workspaceId &&
    (!ctx.userId || entry?.userId === ctx.userId) &&
    (!ctx.apiKeyId || entry?.apiKeyId === ctx.apiKeyId));

const mergeBucket = (out, b) => {
  for (const [k, n] of Object.entries(b.byModel)) out.byModel[k] = (out.byModel[k] || 0) + n;
  for (const [conn, models] of Object.entries(b.byAccount)) {
    out.byAccount[conn] ||= {};
    const acc = out.byAccount[conn];
    for (const [k, n] of Object.entries(models)) acc[k] = (acc[k] || 0) + n;
  }
};

/**
 * In-flight counts `{ byModel, byAccount }` for a scope:
 * - `null`: every workspace merged (today's unscoped view).
 * - workspace id string: that workspace's bucket, every identity inside it.
 * - scope object: identity-filtered when `userId`/`apiKeyId` are set
 *   (matching identity buckets only), else the workspace bucket.
 */
export function pendingView(scope = null) {
  if (typeof scope === "string") return pendingByWorkspace[scope] || EMPTY();
  if (scope && (scope.userId || scope.apiKeyId)) {
    const out = EMPTY();
    for (const b of Object.values(pendingByIdentity)) {
      if (inScope(b, scope)) mergeBucket(out, b);
    }
    return out;
  }
  if (scope) return pendingByWorkspace[scope.workspaceId] || EMPTY();
  const out = EMPTY();
  for (const b of Object.values(pendingByWorkspace)) mergeBucket(out, b);
  return out;
}

/** Provider that failed in the last 10s, visible only inside its scope. */
export function lastErrorFor(ctx) {
  if (Date.now() - lastErrorProvider.ts >= 10000) return "";
  if (ctx && !inScope(lastErrorProvider, ctx)) return "";
  return lastErrorProvider.provider;
}

function bump(pending, connectionId, modelKey, delta) {
  pending.byModel[modelKey] = Math.max(0, (pending.byModel[modelKey] || 0) + delta);
  if (pending.byModel[modelKey] === 0) delete pending.byModel[modelKey];
  if (!connectionId) return;
  pending.byAccount[connectionId] ||= {};
  const acc = pending.byAccount[connectionId];
  acc[modelKey] = Math.max(0, (acc[modelKey] || 0) + delta);
  if (acc[modelKey] === 0) {
    delete acc[modelKey];
    if (Object.keys(acc).length === 0) delete pending.byAccount[connectionId];
  }
}

const str = (v) => (typeof v === "string" ? v : "");

/**
 * Count one in-flight request start/stop. Start and stop must pass the same
 * workspace/user/key identity so they hit the same counters (connection/model
 * alone is not unique across concurrent users). Unscoped callers (no ids)
 * keep today's workspace-only shape.
 */
export function trackPendingRequest(
  model,
  provider,
  connectionId,
  started,
  error = false,
  workspaceId = "",
  userId = null,
  apiKeyId = null,
) {
  const ws = str(workspaceId);
  const uid = str(userId);
  const kid = str(apiKeyId);
  const modelKey = provider ? `${model} (${provider})` : model;

  pendingByWorkspace[ws] ||= EMPTY();
  const pending = pendingByWorkspace[ws];
  const idKey = `${ws}\0${uid}\0${kid}`;
  pendingByIdentity[idKey] ||= { workspaceId: ws, userId: uid, apiKeyId: kid, ...EMPTY() };
  const idPending = pendingByIdentity[idKey];
  const timerKey = `${idKey}|${connectionId}|${modelKey}`;

  bump(pending, connectionId, modelKey, started ? 1 : -1);
  bump(idPending, connectionId, modelKey, started ? 1 : -1);
  if (!Object.keys(idPending.byModel).length && !Object.keys(idPending.byAccount).length) {
    delete pendingByIdentity[idKey];
  }

  clearTimeout(pendingTimers[timerKey]);
  delete pendingTimers[timerKey];
  if (started) {
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      // Expire only this identity's share; other identities keep their counts.
      const own = pendingByIdentity[idKey];
      if (!own) return scheduleStatsEvent("pending");
      const modelN = own.byModel[modelKey] || 0;
      const accN = connectionId ? own.byAccount[connectionId]?.[modelKey] || 0 : 0;
      bump(pending, null, modelKey, -(connectionId ? accN : modelN));
      if (connectionId)
        bump({ byModel: {}, byAccount: pending.byAccount }, connectionId, modelKey, -accN);
      bump(own, connectionId, modelKey, -(connectionId ? accN : modelN));
      if (!Object.keys(own.byModel).length && !Object.keys(own.byAccount).length) {
        delete pendingByIdentity[idKey];
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.workspaceId = ws;
    lastErrorProvider.userId = uid;
    lastErrorProvider.apiKeyId = kid;
    lastErrorProvider.ts = Date.now();
  }
  scheduleStatsEvent("pending");
}

/** Append a saved usage entry (identity only, never a raw key) to the ring. */
export function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) recentRing.items = recentRing.items.slice(-RING_CAP);
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKeyId, endpoint, cost, status, tokens, workspaceId, userId FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [RING_CAP],
    );
    recentRing.items = rows.reverse().map((r) => ({ ...r, tokens: parseJson(r.tokens, {}) }));
  } catch {}
}

/**
 * Slim live snapshot for `/api/usage/stream`: in-flight counts per provider,
 * the newest ring entry with non-zero tokens, and a recently failing provider.
 * `ctx` null merges every workspace; a usage scope keeps the caller's own
 * workspace (plan D9: workspace-wide, also for members — aggregate ops
 * telemetry; YAN-376: narrowed to one user and/or gateway key when
 * `ctx.userId` / `ctx.apiKeyId` are passed — pending counters, ring and last
 * error all honour them).
 * @returns {Promise<{activeRequests: {provider: string, count: number}[], lastProvider: string, errorProvider: string}>}
 */
export async function getLiveSnapshot(ctx = null) {
  const counts = new Map();
  for (const models of Object.values(pendingView(ctx).byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (!(count > 0)) continue;
      const provider = modelKey.match(/^(.*) \((.*)\)$/)?.[2] || "unknown";
      counts.set(provider, (counts.get(provider) || 0) + count);
    }
  }

  await ensureRingInitialized();
  let lastProvider = "";
  for (let i = recentRing.items.length - 1; i >= 0; i--) {
    const entry = recentRing.items[i];
    if (!inScope(entry, ctx)) continue;
    const t = entry?.tokens || {};
    if (
      (t.prompt_tokens || t.input_tokens || 0) > 0 ||
      (t.completion_tokens || t.output_tokens || 0) > 0
    ) {
      lastProvider = entry.provider || "";
      break;
    }
  }

  return {
    activeRequests: [...counts].map(([provider, count]) => ({ provider, count })),
    lastProvider,
    errorProvider: lastErrorFor(ctx),
  };
}
