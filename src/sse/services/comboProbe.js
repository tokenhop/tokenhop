/**
 * Combo route dry-run probe (YAN-299).
 *
 * The probe reuses the REAL combo/account fallback path: it builds one minimal
 * non-streaming OpenAI-chat body (tiny prompt, capped max tokens) and drives it
 * through `handleChat` with a fail-open attempt observer. Routing, translation,
 * executors, account fallback, cooldowns all run exactly as for /v1 traffic.
 *
 * Probes differ from normal traffic only in bookkeeping:
 * - synthetic request (url + headers + json()) tagged with a probe user-agent.
 * - usage accounting: probes are excluded from persisted usage/cost stats via
 *   the probe endpoint tag. Request detail rows still record the probe path;
 *   console request log lines remain visible for debugging.
 */

import { getComboById } from "@/lib/localDb";
import { getSettings } from "@/lib/localDb";
import { handleChat } from "@/sse/handlers/chat.js";

import { resolveComboStrategy } from "open-sse/services/comboStrategy.js";
import { COMBO_PROBE_ENDPOINT } from "open-sse/config/runtimeConfig.js";

/** Minimal probe body: tiny prompt, capped tokens, forced non-streaming. */
export const PROBE_MAX_TOKENS = 16;
export const PROBE_PROMPT = "Reply with exactly: ok";
export const PROBE_TIMEOUT_MS = 60_000;

/** Probe endpoint tag — excluded from dashboard usage stats. */
export { COMBO_PROBE_ENDPOINT as PROBE_ENDPOINT };

/** Rate limit: one probe per combo per 10s (server-side, in-memory). */
export const PROBE_RATE_LIMIT_MS = 10_000;

/** In-memory per-combo last-run timestamps. Single-process only (no fan-out
 * across instances, reset on restart); keyed by combo id so parallel probes
 * of different combos each get their own budget. */
const lastRunByCombo = new Map();

/**
 * Check (and record) the probe rate limit for a combo.
 * @param {string} key - Rate-limit key (combo id).
 * @param {number} [now] - Now in ms (injectable for tests).
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function checkProbeRateLimit(key, now = Date.now()) {
  const last = lastRunByCombo.get(key) || 0;
  const elapsed = now - last;
  if (elapsed < PROBE_RATE_LIMIT_MS) {
    return { allowed: false, retryAfterMs: PROBE_RATE_LIMIT_MS - elapsed };
  }
  lastRunByCombo.set(key, now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Clear probe rate-limit state (tests). */
export function resetProbeRateLimit(key) {
  if (key) lastRunByCombo.delete(key);
  else lastRunByCombo.clear();
}

/**
 * Build the minimal probe body. Always OpenAI-chat shape (the engine's pivot
 * format) with a tiny prompt, capped tokens, no tools, non-streaming.
 * @param {string} comboName - Combo name used as the model.
 * @returns {{ model: string, messages: Array, max_tokens: number, stream: boolean }}
 */
export function buildProbeBody(comboName) {
  return {
    model: comboName,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
  };
}

/**
 * Plain-language summary of a probe run, e.g.
 * "Fell back once and answered in 1.38s. Your client never saw the 429."
 * @param {Array} attempts - Recorded step attempts.
 * @param {number} totalMs - Wall-clock total.
 * @returns {string} Summary line.
 */
export function summarizeProbe(attempts, totalMs) {
  const steps = Array.isArray(attempts) ? attempts : [];
  const totalSec = (totalMs / 1000).toFixed(2);
  const served = steps.find((a) => a.outcome === "served");
  if (!served) {
    return `All ${steps.length} step${steps.length === 1 ? "" : "s"} failed after ${totalSec}s. Nothing was served.`;
  }
  const fallbacks = steps.indexOf(served);
  if (fallbacks === 0) {
    return `Answered in ${totalSec}s on the first step. No fallback needed.`;
  }
  const first = steps[0] || {};
  const firstErr = first.status != null ? String(first.status) : first.errorType || "error";
  const noun = fallbacks === 1 ? "once" : `${fallbacks} times`;
  return `Fell back ${noun} and answered in ${totalSec}s. Your client never saw the ${firstErr}.`;
}

/**
 * Run a dry-run probe through the real combo pipeline.
 *
 * @param {object} options
 * @param {string} options.comboId - Combo id (validated by the API route).
 * @returns {Promise<{ attempts: Array, served: object|null, totalMs: number, summary: string, strategy: string, comboName: string }>}
 */
export async function runComboProbe({ comboId }) {
  const combo = await getComboById(comboId);
  if (!combo) {
    const error = new Error("Combo not found");
    error.status = 404;
    throw error;
  }
  if (!Array.isArray(combo.models) || combo.models.length === 0) {
    const error = new Error("Combo has no models");
    error.status = 400;
    throw error;
  }

  const settings = await getSettings();
  const { strategy } = resolveComboStrategy(settings, combo.name);

  const probeBody = buildProbeBody(combo.name);

  const attempts = [];
  const onAttempt = (a) => attempts.push(a);

  // Probe side effects (shared with real traffic by design): the dry run
  // advances round-robin/weighted rotation counters, and leaf account
  // fallback may set/clear per-account cooldowns and strikes. Only quota
  // impact is the tiny probe body itself; probes never persist usage/cost.
  const request = {
    url: `http://localhost${COMBO_PROBE_ENDPOINT}`,
    headers: {
      get: (name) => {
        const n = String(name || "").toLowerCase();
        if (n === "user-agent") return "9router-combo-probe/1.0";
        return null;
      },
      entries: () => [["user-agent", "9router-combo-probe/1.0"]][Symbol.iterator](),
    },
    json: async () => ({ ...probeBody }),
  };

  const t0 = Date.now();
  // Dashboard auth already enforced at the API route; the probe carries no
  // client API key, so the engine gate is skipped via an explicit in-process
  // option (unreachable from request content).
  const response = await handleChat(request, null, { onAttempt, skipApiKeyCheck: true });
  const totalMs = Date.now() - t0;

  if (!response?.ok) {
    // Surface pre-routing failures (missing credentials, API-key gate, empty
    // combo) as probe errors instead of a 200 with an empty timeline.
    let message = `Probe failed (${response?.status ?? "unknown"})`;
    try {
      const errJson = await response?.clone().json();
      message = errJson?.error?.message || errJson?.error || message;
    } catch {
      // keep default
    }
    const error = new Error(message);
    error.status =
      Number.isInteger(response?.status) && response.status >= 400 && response.status < 600
        ? response.status
        : 500;
    throw error;
  }

  let servedBody = null;
  try {
    servedBody = await response.clone().json();
  } catch {
    servedBody = null;
  }

  const timeline = attempts.map((a) => ({
    model: a.model,
    provider:
      typeof a.model === "string" && a.model.includes("/")
        ? a.model.slice(0, a.model.indexOf("/"))
        : null,
    account: a.account || null,
    status: a.status,
    latencyMs: a.latencyMs,
    errorType: a.errorType,
    outcome: a.outcome,
    role: a.role || undefined,
    // Nested combo steps carry the inner combo name so the timeline can show
    // them distinctly from the outer route's own steps.
    via: a.via || undefined,
  }));
  const served = timeline.find((a) => a.outcome === "served") || null;
  return {
    attempts: timeline,
    served,
    servedBody,
    totalMs,
    summary: summarizeProbe(timeline, totalMs),
    strategy,
    comboName: combo.name,
  };
}
