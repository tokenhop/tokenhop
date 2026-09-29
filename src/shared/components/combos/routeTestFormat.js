/**
 * Pure formatters for the Test-this-route panel (YAN-299). Kept JSX-free so
 * vitest can import them without a DOM transform; the component lives in
 * RouteTestPanel.js.
 */

/** Replay pacing: how long each step stays in the "attempted" (sky) state. */
export const PROBE_STEP_MS = 250;

/**
 * Format a latency in ms the way the board shows it: "180ms" under a second,
 * "1.20s" / "1.38s" above.
 * @param {number} ms - Latency in milliseconds.
 * @returns {string} Formatted latency.
 */
export function formatProbeLatency(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

/**
 * "Last run 2 min ago" relative label for a probe timestamp.
 * @param {string|null} iso - ISO timestamp of the last run.
 * @param {number} [now] - Now in ms (injectable for tests).
 * @returns {string|null} Relative label, or null when never run.
 */
export function probeLastRunLabel(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 10) return "Last run just now";
  if (diffSec < 60) return `Last run ${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Last run ${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Last run ${diffH}h ago`;
  return `Last run ${Math.floor(diffH / 24)}d ago`;
}

/** Outcome → replay display state ("answered" is lime, "failed"/"skipped" warn). */
function outcomeState(outcome) {
  if (outcome === "served" || outcome === "answered") return "answered";
  if (outcome === "failed") return "failed";
  return "skipped";
}

/**
 * Map probe attempts onto the route track for replay (YAN-411).
 *
 * Each attempt becomes one replay event: `state` drives the step colors
 * (answered = lime, failed/skipped = warn with `reason`), `index` is the
 * matching route-track step (nth occurrence of the model, so duplicates map
 * to distinct steps; null when the model isn't on the track — e.g. nested
 * combo members), and `text` is the plain-English line for the live-region
 * timeline.
 * @param {string[]} models - Ordered combo member models (the route track).
 * @param {Array<{model: string,
 *   status?: number, latencyMs?: number, outcome?: string,
 *   errorType?: string|null, account?: string|null,
 *   role?: string, via?: string}>} attempts - Probe timeline in attempt order.
 * @returns {Array<{index: number|null, model: string, state: string,
 *   tone: "live"|"warn", reason: string, latency: string, status: number|null,
 *   outcome?: string, account: string|null,
 *   role?: string, via?: string, text: string}>}
 */
export function probeTrackEvents(models, attempts) {
  const route = Array.isArray(models) ? models : [];
  const occurrences = new Map();
  const stepFor = (name) => {
    // The nth attempt for a name maps to the track's nth occurrence, so
    // duplicate rows each get their own attempt and one attempt never
    // lights two steps.
    const occurrence = occurrences.get(name) || 0;
    occurrences.set(name, occurrence + 1);
    let from = 0;
    for (let k = 0; k <= occurrence; k++) {
      const found = route.indexOf(name, from);
      if (found === -1) return null;
      if (k === occurrence) return found;
      from = found + 1;
    }
    return null;
  };
  return (Array.isArray(attempts) ? attempts : []).map((step) => {
    const model = typeof step?.model === "string" ? step.model : "";
    // A nested attempt (via = inner combo name that is itself a track step)
    // lights that outer step; otherwise map by model. Attempts that match
    // neither (e.g. a judge that isn't a member) stay timeline-only.
    const via = typeof step?.via === "string" && route.includes(step.via) ? step.via : null;
    const index = model ? stepFor(via || model) : null;
    const state = outcomeState(step?.outcome);
    const answered = state === "answered";
    const reason = answered
      ? "answered"
      : (step?.errorType ?? `error ${step?.status ?? "unknown"}`);
    const latency = formatProbeLatency(step?.latencyMs);
    const status = typeof step?.status === "number" ? step.status : null;
    const text = answered
      ? `${model || "unknown model"} answered in ${latency}.`
      : `${model || "unknown model"}: ${reason} in ${latency} — ${state}.`;
    return {
      index,
      model,
      state,
      tone: answered ? "live" : "warn",
      reason,
      latency,
      status,
      outcome: step?.outcome,
      account: step?.account || null,
      role: step?.role,
      via: step?.via,
      text,
    };
  });
}
