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
import { getEffectivePreferences } from "@/lib/db/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { ACTIVE } from "@/shared/brand";
import { comboStrategyFor } from "@/lib/comboKeys.js";

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
 * Caller-derived probe principal: the dashboard session/CLI request already in
 * hand, mapped to the Default workspace with live membership and capability
 * re-read from the DB (workspace.combos.manage + workspace.connections.use).
 * Never widens the caller: credentials resolve inside that workspace only.
 * No request, or an unauthorized caller, means no principal — the hashed store
 * then refuses the probe instead of routing against someone else's authority.
 * ponytail: `via` is "local" for session callers too — gatewayResources'
 * GATEWAY_VIA tuple has no "session"/"dashboard" member yet; extend it there
 * when the auth lane lands and tag honestly.
 */
async function resolveProbeCaller(nextRequest) {
  const { resolvePrincipal } = await import("@/lib/users/session.js");
  const { can } = await import("@/lib/users/principal.js");
  if (!nextRequest) return null;
  let session = await resolvePrincipal(nextRequest).catch(() => null);
  if (!session) {
    // Switch-off session resolver deliberately yields null. Authenticate the
    // cookie here; do not turn a missing/invalid cookie into owner authority.
    const { getDashboardAuthSession } = await import("@/lib/auth/dashboardSession.js");
    const cookie =
      nextRequest.cookies?.get("auth_token")?.value ||
      nextRequest.headers
        ?.get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("auth_token="))
        ?.slice(11);
    const { isLiveSession } = await import("@/lib/users/session.js");
    const payload =
      cookie && (await isLiveSession(cookie)) ? await getDashboardAuthSession(cookie) : null;
    if (!payload) return null;
    const db = await getAdapter();
    if (payload.sub) {
      const user = db.get("SELECT id, status, sessionVersion FROM users WHERE id = ?", [
        payload.sub,
      ]);
      if (user?.status !== "active" || user.sessionVersion !== payload.sv) return null;
      session = { userId: user.id, via: "session" };
    } else {
      if (db.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n !== 1) return null;
      const owner = db.get(
        "SELECT id FROM users WHERE instanceRole = 'owner' AND status = 'active'",
      );
      if (!owner) return null;
      session = { userId: owner.id, via: "session" };
    }
  }
  if (!["session", "cli"].includes(session.via) || session.apiKeyId) return null;
  try {
    const db = await getAdapter();
    const workspaceId = db.get(
      `SELECT w.id AS id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = 'defaultWorkspaceId'`,
    )?.id;
    if (!workspaceId) return null;
    const live = await liveProbeAccess(db, session, workspaceId, can);
    if (!live.combosManage || !live.connectionsUse) return null;
    return Object.freeze({
      userId: session.userId ?? null,
      workspaceId,
      apiKeyId: null,
      scopes: Object.freeze({
        allowedModels: Object.freeze([]),
        allowedCombos: Object.freeze([]),
      }),
      via: "local",
    });
  } catch {
    return null;
  }
}

/** Live role/status snapshot for the probe caller in the Default workspace. */
async function liveProbeAccess(db, session, workspaceId, can) {
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [session.userId]);
  if (user?.status !== "active") return { combosManage: false, connectionsUse: false };
  const role = db.get(`SELECT role FROM memberships WHERE workspaceId = ? AND userId = ?`, [
    workspaceId,
    session.userId,
  ])?.role;
  const principal = {
    userId: session.userId,
    instanceRole: user.instanceRole,
    workspaceIds: [workspaceId],
    workspaceRoles: role ? { [workspaceId]: role } : {},
    activeWorkspaceId: workspaceId,
    via: "session",
  };
  return {
    combosManage: can(principal, "workspace.combos.manage", { workspaceId }),
    connectionsUse: can(principal, "workspace.connections.use", { workspaceId }),
  };
}

/**
 * Run a dry-run probe through the real combo pipeline.
 *
 * @param {object} options
 * @param {object|null} [options.combo] - Authorized combo, already loaded and
 *   IDOR-checked by the route (YAN-364) — the probe never re-looks-up a
 *   caller-supplied id when this is present.
 * @param {string} [options.comboId] - Legacy lookup (tests / in-process
 *   callers without authorization context): unscoped fetch by id.
 * @param {object|null} [options.principal] - Authorized caller principal; when
 *   absent the resolver derives the management principal above.
 * @param {object|null} [options.request] - Dashboard request for caller context
 *   (session/CLI); passed by the API route. Tests pass neither; probe then
 *   behaves legacy-only unless the store permits.
 * @returns {Promise<{ attempts: Array, served: object|null, totalMs: number, summary: string, strategy: string, comboName: string }>}
 */
export async function runComboProbe({
  combo = null,
  comboId = null,
  principal = null,
  request = null,
}) {
  if (!combo) {
    if (!comboId) {
      const error = new Error("Combo not found");
      error.status = 404;
      throw error;
    }
    combo = await getComboById(comboId);
    if (!combo) {
      const error = new Error("Combo not found");
      error.status = 404;
      throw error;
    }
  }
  if (!Array.isArray(combo.models) || combo.models.length === 0) {
    const error = new Error("Combo has no models");
    error.status = 400;
    throw error;
  }

  // Dashboard callers pass their own session/CLI principal; anything reaching
  // here without one is trusted only on the legacy store. On the hashed store
  // a principal-less probe answers as nobody — it must refuse in-process
  // rather than route against all connections/install default.
  const management = principal || (await resolveProbeCaller(request));
  const settings = await getEffectivePreferences(management);
  // YAN-364: workspace prefs key strategies by combo id (renames preserve
  // them); the legacy blob keys by name. comboStrategyFor follows the marker
  // getEffectivePreferences sets, so an OFF probe principal resolves by name,
  // exactly like the real routing path in the handlers.
  const { strategy } = comboStrategyFor(settings, management, combo);
  if (!management) {
    let storage = "legacy";
    try {
      storage = readApiKeyStorageState(await getAdapter()).storage;
    } catch {
      storage = "unknown";
    }
    if (storage !== "legacy") {
      const error = new Error("Probe failed (gateway storage unavailable)");
      error.status = 503;
      throw error;
    }
  }

  const probeBody = buildProbeBody(combo.name);

  const attempts = [];
  const onAttempt = (a) => attempts.push(a);

  // Probe side effects (shared with real traffic by design): the dry run
  // advances round-robin/weighted rotation counters, and leaf account
  // fallback may set/clear per-account cooldowns and strikes. Only quota
  // impact is the tiny probe body itself; probes never persist usage/cost.
  const probeRequest = {
    url: `http://localhost${COMBO_PROBE_ENDPOINT}`,
    headers: {
      get: (name) => {
        const n = String(name || "").toLowerCase();
        if (n === "user-agent") return `${ACTIVE.slug}-combo-probe/1.0`;
        return null;
      },
      entries: () => [["user-agent", `${ACTIVE.slug}-combo-probe/1.0`]][Symbol.iterator](),
    },
    json: async () => ({ ...probeBody }),
  };

  const t0 = Date.now();
  // Dashboard auth already enforced at the API route; the probe carries no
  // client API key, so the engine gate is skipped via an explicit in-process
  // option (unreachable from request content).
  // YAN-363: a probe runs as an explicit authorized principal when the caller
  // supplies one; skipApiKeyCheck alone is accepted only while storage is
  // legacy (handleChat enforces that — hashed storage rejects a principal-less
  // probe instead of escalating to owner/all connections).
  const response = await handleChat(probeRequest, null, {
    onAttempt,
    skipApiKeyCheck: true,
    ...(management ? { principal: management } : {}),
  });
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
