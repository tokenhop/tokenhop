// Live usage feed state (YAN-370, plan D9): in-flight counters, the recent
// ring and the stats emitter, process-wide but keyed by workspace so a scoped
// subscriber only sees its own workspace. `ctx` null (switch off / one user)
// merges every workspace: today's payload.
import { EventEmitter } from "node:events";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const EMPTY = () => ({ byModel: {}, byAccount: {} });

// In-memory state shared across Next.js modules.
if (!global._pendingByWorkspace) global._pendingByWorkspace = {};
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingByWorkspace = global._pendingByWorkspace;
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
  !ctx || (entry?.workspaceId === ctx.workspaceId && (!ctx.userId || entry?.userId === ctx.userId));

/** In-flight counts `{ byModel, byAccount }` for one workspace, or all merged (null). */
export function pendingView(workspaceId = null) {
  if (workspaceId !== null) return pendingByWorkspace[workspaceId] || EMPTY();
  const out = EMPTY();
  for (const b of Object.values(pendingByWorkspace)) {
    for (const [k, n] of Object.entries(b.byModel)) out.byModel[k] = (out.byModel[k] || 0) + n;
    for (const [conn, models] of Object.entries(b.byAccount)) {
      out.byAccount[conn] ||= {};
      const acc = out.byAccount[conn];
      for (const [k, n] of Object.entries(models)) acc[k] = (acc[k] || 0) + n;
    }
  }
  return out;
}

/** Provider that failed in the last 10s, visible only inside its workspace when scoped. */
export function lastErrorFor(ctx) {
  if (Date.now() - lastErrorProvider.ts >= 10000) return "";
  if (ctx && lastErrorProvider.workspaceId !== ctx.workspaceId) return "";
  return lastErrorProvider.provider;
}

export function trackPendingRequest(
  model,
  provider,
  connectionId,
  started,
  error = false,
  workspaceId = "",
) {
  const ws = typeof workspaceId === "string" ? workspaceId : "";
  pendingByWorkspace[ws] ||= EMPTY();
  const pending = pendingByWorkspace[ws];
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${ws}|${connectionId}|${modelKey}`;
  const delta = started ? 1 : -1;

  pending.byModel[modelKey] = Math.max(0, (pending.byModel[modelKey] || 0) + delta);
  if (pending.byModel[modelKey] === 0) delete pending.byModel[modelKey];

  if (connectionId) {
    pending.byAccount[connectionId] ||= {};
    const acc = pending.byAccount[connectionId];
    acc[modelKey] = Math.max(0, (acc[modelKey] || 0) + delta);
    if (acc[modelKey] === 0) {
      delete acc[modelKey];
      if (Object.keys(acc).length === 0) delete pending.byAccount[connectionId];
    }
  }

  clearTimeout(pendingTimers[timerKey]);
  delete pendingTimers[timerKey];
  if (started) {
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pending.byModel[modelKey] > 0) pending.byModel[modelKey] = 0;
      if (connectionId && pending.byAccount[connectionId]?.[modelKey] > 0) {
        pending.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.workspaceId = ws;
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
 * telemetry; narrowed to one user only if `ctx.userId` is passed).
 * @returns {Promise<{activeRequests: {provider: string, count: number}[], lastProvider: string, errorProvider: string}>}
 */
export async function getLiveSnapshot(ctx = null) {
  const counts = new Map();
  for (const models of Object.values(pendingView(ctx ? ctx.workspaceId : null).byAccount)) {
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
