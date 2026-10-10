// YAN-1041 billing-lock recovery probe. One minimal REAL inference through the
// shared executor path per locked API-key connection (a models list, auth check
// or count_tokens does not prove billable inference works). The lock clears
// only on a response that carries a valid completion with token usage; every
// ambiguous result (network, timeout, 5xx, 401, model-specific 4xx, empty or
// malformed 200) keeps the lock and records an allowlisted error code.
//
// Concurrency: an in-process Set is the fast path; the cross-process guarantee
// is the conditional DB claim (one transaction: row exists + active + SAME lock
// generation + due (scheduler: nextProbeAt <= now; manual: lastProbeAt older
// than manualMinIntervalMs)) which atomically writes nextProbeAt = now +
// interval(+jitter) and lastProbeAt = now. A concurrent claim in another
// process therefore always loses. Completion is conditional the same way, so a
// concurrent disable / re-lock / delete always wins.
import "open-sse/index.js";

import {
  getPricingForModel,
  getProviderConnectionByIdUnscoped,
  getProviderConnectionsMetadataUnscoped,
} from "@/lib/localDb";
import { mutateBillingLockUnscoped } from "@/lib/db/repos/connectionsRepo.js";
import { saveRequestDetailUnscoped } from "@/lib/usageDb.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getExecutor } from "open-sse/executors/index.js";
import { BILLING_PROBE_CONFIG } from "open-sse/config/errorConfig.js";
import {
  getBillingLock,
  getBillingProbeSpec,
  isBillingExhausted,
  nextBillingProbeAt,
} from "open-sse/services/accountFallback.js";
import { parseUpstreamError } from "open-sse/utils/error.js";
import { canonicalizeUsage } from "open-sse/utils/usageTracking.js";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";

const C = BILLING_PROBE_CONFIG;

// Survive Next.js hot reload; one scheduler / in-flight set per server process.
const g = (global.__billingProbe ??= { interval: null, running: false, inFlight: new Set() });

export const PROBE_RESULT = {
  cleared: "cleared",
  stillLocked: "still_locked",
  error: "error",
  notLocked: "not_locked",
  notFound: "not_found", // route maps it to 404
  inFlight: "in_flight",
  disabled: "disabled", // route maps it to 409
  rateLimited: "rate_limited", // route maps it to 429
};

const log = (msg) => console.log(`[BillingProbe] ${msg}`);

/** Minimal valid request for the provider's format (no stream/thinking/tools). */
export function buildProbeBody(spec) {
  const body = {
    model: spec.upstreamModelId || spec.model,
    [spec.maxTokensField]: spec.maxTokens,
    messages: [{ role: "user", content: C.prompt }],
    stream: false,
  };
  // DeepSeek chat: disable thinking on the wire so no hidden reasoning tokens
  // are spent (the pro/max thinking-only models are excluded from selection).
  // Registry providers only inject reasoning_content into assistant messages —
  // this body has none — so nothing else to drop.
  if (spec.disableThinking) body.thinking = { type: "disabled" };
  return body;
}

/**
 * Does a parsed 200 body prove billable inference? Requires a real completion
 * (non-empty text, not a refusal) AND reported token usage. Anything else,
 * including HTTP 200 with an empty/malformed/error-shaped body, is NOT proof.
 */
export function validateProbeResponse(format, json) {
  if (!json || typeof json !== "object" || json.error) {
    return { ok: false, usage: null };
  }
  let text = "";
  let refused = false;
  if (format === "claude") {
    if (json.type !== "message" || !Array.isArray(json.content)) return { ok: false, usage: null };
    text = json.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    refused = json.stop_reason === "refusal";
  } else {
    const choice = json.choices?.[0];
    if (!choice) return { ok: false, usage: null };
    text = typeof choice.message?.content === "string" ? choice.message.content : "";
    refused = choice.finish_reason === "content_filter" || !!choice.message?.refusal;
  }
  const usage = canonicalizeUsage(json.usage);
  const tokens = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  if (!text.trim() || refused || tokens <= 0) {
    return { ok: false, usage: tokens > 0 ? usage : null };
  }
  return { ok: true, usage };
}

/** Map a probe failure to the allowlisted code (never upstream free text). */
function probeErrorCode(outcome) {
  if (outcome.kind === "billing") return "billing";
  const st = outcome.status;
  if (st === 401 || st === 403) return "auth";
  if (st === 429) return "rate_limited";
  if (st >= 500) return "server_error";
  if (st === 404 || st === 400 || outcome.unavailable) return "probe_model_unavailable";
  if (outcome.message === "timeout") return "timeout";
  if (outcome.message === "invalid_response") return "invalid_response";
  if (outcome.message === "network") return "network";
  return "unknown";
}

/** One inference attempt. Never throws; returns { kind, status?, message?, usage? }. */
async function dispatchProbe(conn, spec, deps) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), C.timeoutMs);
  try {
    const proxy = await deps.resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const executor = deps.getExecutor(conn.provider);
    const { response } = await executor.execute({
      model: spec.upstreamModelId || spec.model,
      body: buildProbeBody(spec),
      stream: false,
      credentials: {
        apiKey: conn.apiKey,
        providerSpecificData: conn.providerSpecificData,
        connectionId: conn.id,
      },
      signal: ctrl.signal,
      log: null,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
        connectionProxyPoolId: proxy.proxyPoolId || null,
      },
    });
    if (!response.ok) {
      const { statusCode, message } = await parseUpstreamError(response, executor);
      if (isBillingExhausted(statusCode, message, conn.provider)) {
        return { kind: "billing", status: statusCode };
      }
      return { kind: "error", status: statusCode };
    }
    let json = null;
    try {
      json = JSON.parse(await response.text());
    } catch {
      /* falls to validation below */
    }
    const verdict = validateProbeResponse(spec.format, json);
    if (!verdict.ok) return { kind: "error", message: "invalid_response", usage: verdict.usage };
    return { kind: "success", usage: verdict.usage };
  } catch (e) {
    const msg = String(e?.message || "");
    const name = e?.name || "";
    const isTimeout =
      name === "AbortError" || /timed? ?out|timeout/i.test(msg) || ctrl.signal.aborted;
    const isNetwork =
      name === "TypeError" || /network|fetch|socket|econn|enotfound|reset/i.test(msg);
    return { kind: "error", message: isTimeout ? "timeout" : isNetwork ? "network" : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

const sameLock = (live, generation) =>
  !!live && live.isActive !== false && getBillingLock(live)?.generation === generation;

/**
 * Probe one connection. Returns { result, billingLock, retryAfterMs? }.
 * @param {string} id connection id
 * @param {{ deps?: object, manual?: boolean }} [options] manual = "probe now" route
 */
export async function probeBillingConnection(
  id,
  { deps = createDefaultDeps(), manual = false } = {},
) {
  if (g.inFlight.has(id)) {
    const conn = await deps.getMetadata(id).catch(() => null);
    return { result: PROBE_RESULT.inFlight, billingLock: getBillingLock(conn) };
  }
  g.inFlight.add(id);
  try {
    return await runProbe(id, deps, manual);
  } finally {
    g.inFlight.delete(id);
  }
}

async function runProbe(id, deps, manual) {
  const conn = await deps.getConnection(id);
  if (!conn) return { result: PROBE_RESULT.notFound, billingLock: null };
  const lock = getBillingLock(conn);
  if (conn.isActive === false) return { result: PROBE_RESULT.disabled, billingLock: lock };
  if (!lock) return { result: PROBE_RESULT.notLocked, billingLock: null };
  const generation = lock.generation;

  // Claim: cross-process single-flight lease, one transaction. Scheduler claims
  // only when nextProbeAt is due; manual claims only when the last probe is
  // older than manualMinIntervalMs (a first-ever probe has lastProbeAt null).
  const claim = await deps.mutate(id, (live) => {
    if (!live) return null;
    const cur = getBillingLock(live);
    if (!cur || !sameLock(live, generation)) return null;
    if (manual) {
      const last = Date.parse(cur.lastProbeAt);
      if (Number.isFinite(last) && Date.now() - last < C.manualMinIntervalMs) return null;
    } else if ((Date.parse(cur.nextProbeAt) || 0) > Date.now()) return null;
    return {
      billingLock: {
        ...cur,
        lastProbeAt: new Date().toISOString(),
        nextProbeAt: nextBillingProbeAt(),
      },
    };
  });
  if (!claim.applied) {
    const liveLock = claim.missing ? null : claim.billingLock;
    if (claim.missing) return { result: PROBE_RESULT.notFound, billingLock: null };
    if (claim.disabled) return { result: PROBE_RESULT.disabled, billingLock: liveLock };
    if (!liveLock) return { result: PROBE_RESULT.notLocked, billingLock: null };
    if (liveLock.generation !== generation) {
      return { result: PROBE_RESULT.stillLocked, billingLock: liveLock };
    }
    // Scheduler lost the lease (not due / another process claimed): not an error.
    if (!manual) return { result: PROBE_RESULT.stillLocked, billingLock: liveLock };
    const waitMs = Date.parse(liveLock.lastProbeAt) + C.manualMinIntervalMs - Date.now();
    return {
      result: PROBE_RESULT.rateLimited,
      billingLock: liveLock,
      retryAfterMs: Math.max(0, waitMs),
    };
  }

  const spec = getBillingProbeSpec(conn.provider);
  const pricing = spec ? await deps.getPricing(conn.provider, spec.model) : null;
  let outcome;
  if (!spec) {
    outcome = { kind: "error", unavailable: "unsupported-provider" };
  } else if (!pricing) {
    // Never spend on an unpriced model: spend must stay accountable.
    outcome = { kind: "error", unavailable: "unpriced" };
  } else {
    outcome = await dispatchProbe(conn, spec, deps);
  }

  const tokens = outcome.usage || null;
  const cost = tokens && pricing ? calculateCostFromTokens(tokens, pricing) : 0;
  const code = outcome.kind === "success" ? null : probeErrorCode(outcome);
  const completion = await deps.mutate(id, (live) => {
    if (!live || !sameLock(live, generation)) return null;
    const cur = getBillingLock(live);
    if (outcome.kind === "success") return { billingLock: null };
    return {
      billingLock: {
        ...cur,
        lastProbeAt: new Date().toISOString(),
        lastProbeError: code,
        nextProbeAt: nextBillingProbeAt(),
      },
    };
  });

  // Internal accounting only (never a usageHistory/rollup row, so probe spend
  // cannot land in user-request stats or budgets): a request-detail row tagged
  // /internal/billing-probe. Real tokens + computed cost are retained here.
  deps
    .saveDetail(
      buildRequestDetail(
        {
          provider: conn.provider,
          model: spec?.model,
          connectionId: conn.id,
          tokens: tokens || { prompt_tokens: 0, completion_tokens: 0 },
          request: { probe: "billing", endpoint: C.usageEndpoint, maxTokens: spec?.maxTokens },
          response: { probe: "billing", kind: outcome.kind, code, cost },
          status: outcome.kind === "success" ? "success" : "error",
        },
        { endpoint: C.usageEndpoint },
      ),
    )
    .catch(() => {});

  // The completion transaction reports the LIVE lock after it ran (null when
  // cleared or the row is gone): a concurrent disable/re-lock/delete wins.
  const liveLock = completion.missing ? null : completion.billingLock;
  if (completion.missing) return { result: PROBE_RESULT.notFound, billingLock: null };
  // Disabled while the probe ran: never clear, never re-enable (the user's
  // disable wins); the spend is already in the internal detail row above.
  if (completion.disabled) return { result: PROBE_RESULT.disabled, billingLock: liveLock };
  if (outcome.kind === "success" && liveLock === null) {
    log(`${id.slice(0, 8)} cleared`);
    return { result: PROBE_RESULT.cleared, billingLock: null };
  }
  if (liveLock?.generation !== generation) {
    return {
      result: liveLock ? PROBE_RESULT.stillLocked : PROBE_RESULT.notLocked,
      billingLock: liveLock,
    };
  }
  log(`${id.slice(0, 8)} ${outcome.kind} ${code ?? ""}`.trim());
  // A success that did not clear (connection disabled under the probe) is
  // reported as still locked; only a genuinely failed probe is an "error".
  return {
    result: outcome.kind === "error" ? PROBE_RESULT.error : PROBE_RESULT.stillLocked,
    billingLock: liveLock,
  };
}

function createDefaultDeps() {
  return {
    getConnection: getProviderConnectionByIdUnscoped,
    getMetadata: async (id) =>
      (await getProviderConnectionsMetadataUnscoped()).find((c) => c.id === id) ?? null,
    listActive: () => getProviderConnectionsMetadataUnscoped({ isActive: true }),
    mutate: mutateBillingLockUnscoped,
    getPricing: getPricingForModel,
    getExecutor,
    resolveConnectionProxyConfig,
    saveDetail: saveRequestDetailUnscoped,
  };
}

/** Scheduler tick: due locks (persisted nextProbeAt), at most `concurrency` per tick. */
export async function runBillingProbeTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const now = Date.now();
    const due = (await deps.listActive())
      .filter((c) => {
        const lock = getBillingLock(c);
        return lock && (Date.parse(lock.nextProbeAt) || 0) <= now;
      })
      .sort(
        (a, b) =>
          Date.parse(getBillingLock(a).nextProbeAt) - Date.parse(getBillingLock(b).nextProbeAt),
      )
      .slice(0, C.concurrency);
    const settled = await Promise.allSettled(
      due.map((c) => probeBillingConnection(c.id, { deps })),
    );
    for (const r of settled) {
      if (r.status === "rejected") log(`probe threw: ${r.reason?.message ?? r.reason}`);
    }
  } catch (e) {
    console.warn("[BillingProbe] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startBillingProbe() {
  if (g.interval) return;
  log("scheduler started");
  runBillingProbeTick().catch(() => {});
  g.interval = setInterval(() => {
    runBillingProbeTick().catch(() => {});
  }, C.tickMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopBillingProbe() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
}
