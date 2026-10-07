// Per-grant rpm/tpm (ADR-0006/0007): rolling 60s in-memory window keyed by
// grantId. Null rpm/tpm = unlimited and zero overhead (no state is created).
// Callers run inside the per-workspace:provider selection mutex and every call
// here is synchronous, so check+reserve is atomic.
// ponytail: single-process window (matches the single-instance assumption) and
// tpm counts the pre-flight estimate (prompt chars/4 + max_tokens), not settled
// actuals; a reservation leaked by a crash self-expires after WINDOW_MS.
// Upgrade path: settle to actual tokens when YAN-372 budgets add settlement,
// shared store if the gateway ever scales out.
import { boundedMap } from "open-sse/utils/boundedMap.js";

const WINDOW_MS = 60_000;
const states = boundedMap(5000);

function windowState(grantId, now) {
  let s = states.get(grantId);
  if (!s) {
    s = { req: [], tok: [] };
    states.set(grantId, s);
  }
  const cutoff = now - WINDOW_MS;
  s.req = s.req.filter((e) => e.ts > cutoff);
  s.tok = s.tok.filter((e) => e.ts > cutoff);
  return s;
}

const limited = (grant) => grant.grantRpm != null || grant.grantTpm != null;

// Which limit would this request exceed? null = within limits.
function exceeded(s, grant, estimateTokens) {
  if (grant.grantRpm != null && s.req.length >= grant.grantRpm) return "rpm";
  if (grant.grantTpm != null) {
    const used = s.tok.reduce((n, e) => n + e.tokens, 0);
    if (used + estimateTokens > grant.grantTpm) return "tpm";
  }
  return null;
}

/** Non-reserving peek used by the candidate filter. @returns {"rpm"|"tpm"|null} */
export function grantLimitHit(grant, estimateTokens = 0) {
  if (!limited(grant)) return null;
  return exceeded(windowState(grant.grantId, Date.now()), grant, estimateTokens);
}

/**
 * Atomic check + reserve.
 * @returns {object|null|false} reservation handle, null when the grant has no
 *   limits (nothing to release), false when a limit would be exceeded.
 */
export function checkAndReserveGrant(grant, estimateTokens = 0) {
  if (!limited(grant)) return null;
  const now = Date.now();
  const s = windowState(grant.grantId, now);
  if (exceeded(s, grant, estimateTokens)) return false;
  const handle = { grantId: grant.grantId, req: null, tok: null };
  if (grant.grantRpm != null) s.req.push((handle.req = { ts: now }));
  if (grant.grantTpm != null) s.tok.push((handle.tok = { ts: now, tokens: estimateTokens }));
  return handle;
}

/** Drop exactly this reservation: failed attempts cost nothing. Idempotent. */
export function releaseGrantReservation(handle) {
  if (!handle) return;
  const s = states.get(handle.grantId);
  if (!s) return;
  if (handle.req) s.req = s.req.filter((e) => e !== handle.req);
  if (handle.tok) s.tok = s.tok.filter((e) => e !== handle.tok);
  handle.req = handle.tok = null;
}

// Canonical `provider/model` match, same form the key allowedModels check uses.
export function grantAllowsModel(grant, providerId, model, pinned = false) {
  const list = grant.grantAllowedModels;
  if (!Array.isArray(list)) return true;
  if (!model) return pinned; // unknown model can't be verified; pins (video polling) pass
  return list.includes(`${providerId}/${model}`);
}

// Rough prompt+completion estimate, only evaluated when a granted candidate has tpm.
// Legacy completions carry prompt/suffix instead of messages/input/contents.
export function estimateBodyTokens(body) {
  const payload = body?.messages ?? body?.input ?? body?.contents ?? "";
  // FIM fields always count: a decoy `messages: []` must not hide a huge prefix.
  const chars =
    (typeof payload === "string" ? payload.length : JSON.stringify(payload).length) +
    (fallbackPromptChars(body)?.length ?? 0);
  const maxOut =
    body?.max_tokens ??
    body?.max_completion_tokens ??
    (Number(body?.n_predict) > 0 ? Math.min(Number(body.n_predict), 4096) : undefined);
  return Math.ceil(chars / 4) + Math.max(0, Number(maxOut) || 0);
}

// Chars from FIM fields: legacy/Codestral prompt (string | string[]) + suffix,
// and llama.cpp /infill input_prefix, input_suffix and input_extra[].text.
function fallbackPromptChars(body) {
  const parts = [];
  const { prompt, suffix, input_prefix, input_suffix, input_extra } = body || {};
  for (const s of [input_prefix, input_suffix]) if (typeof s === "string") parts.push(s);
  if (Array.isArray(input_extra)) {
    for (const e of input_extra) if (typeof e?.text === "string") parts.push(e.text);
  }
  if (typeof prompt === "string") parts.push(prompt);
  else if (Array.isArray(prompt)) {
    for (const p of prompt) if (typeof p === "string") parts.push(p);
  }
  if (typeof suffix === "string") parts.push(suffix);
  return parts.length > 0 ? parts.join("") : null;
}

/** Memoized estimator from the caller's `options.estimateTokens` (number | fn). */
export function grantEstimator(source) {
  let n;
  return () => {
    if (n === undefined) n = Number(typeof source === "function" ? source() : source) || 0;
    return n;
  };
}

/**
 * All-candidates-skipped-by-grant-limit result. Rides the allRateLimited shape
 * so handlers that don't know grants still answer gracefully; chat/embeddings
 * check `grantRateLimit` first and return the ADR-0007 429 instead.
 */
export function grantLimitedResult(limit) {
  return {
    allRateLimited: true,
    retryAfter: new Date(Date.now() + WINDOW_MS).toISOString(),
    retryAfterHuman: "reset in 1m",
    lastError: "Grant rate limit exceeded",
    lastErrorCode: 429,
    grantRateLimit: { limit },
  };
}

/** ADR-0007 429 for a grant-level rate limit. */
export function grantRateLimitResponse({ limit }) {
  const res = new Response(
    JSON.stringify({
      error: {
        message: `Rate limit exceeded at grant level: ${limit} per minute.`,
        type: "rate_limit_exceeded",
        param: null,
        code: "rate_limit_exceeded",
        level: "grant",
        window: "minute",
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": "60",
      },
    },
  );
  res.localError = true; // request-scoped: combos advance, no account cooldown
  return res;
}
