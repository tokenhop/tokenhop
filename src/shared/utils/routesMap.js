/**
 * Shared routes-map model helpers (YAN-412). Pure functions, no IO — they
 * shape the client → 9router → provider flow model from
 * `/api/home/live-routes` (see `src/lib/home/liveRoutes.js`) for the shared
 * RoutesMap component on Home and Usage.
 *
 * The window model already lists every active connection as an idle provider;
 * `mergeRoutes` adds the rest of the connected universe (Usage parity: the old
 * topology also listed no-auth free providers) and `overlayLiveSignal` layers
 * the in-flight SSE frames on top so Usage lights up between polls.
 */

import { EDGE_STATE_LABEL } from "@/lib/home/liveRoutes";
import { formatRelativeFromNow } from "@/shared/utils/period";
import { formatReset, timeAgo } from "./format";

export { EDGE_STATE_LABEL };

const EDGE_STYLE = {
  flowing: { stroke: "var(--signal-lime-ink)", dash: "6 8", animated: true },
  cooling: { stroke: "var(--signal-warn)", dash: "3 6", animated: false },
  idle: { stroke: "var(--signal-line)", dash: null, animated: false },
  error: { stroke: "var(--signal-err)", dash: null, animated: false },
};

/**
 * Stroke spec for one edge state. Signal tokens only (design-system §8):
 * lime dashed flow when live, warn dashes while cooling, line color when idle.
 * @param {string} state
 * @returns {{ stroke: string, dash: string|null, animated: boolean }}
 */
export function edgeStyle(state) {
  return EDGE_STYLE[state] || EDGE_STYLE.idle;
}

/**
 * Screen-reader description of one edge.
 * @param {{ from: string|null, to: string, state: string, count?: number, lastAt?: string|null }} edge
 * @param {number} [nowMs]
 * @returns {string} plain English literal
 */
export function edgeLabel(edge, nowMs = Date.now()) {
  const state = EDGE_STATE_LABEL[edge?.state] || edge?.state || "Idle";
  if (!edge?.from) return `${edge?.to}: ${state}.`;
  const last = edge.lastAt ? `, last ${timeAgo(edge.lastAt, nowMs)}` : "";
  return `${edge.from} to ${edge.to}: ${state}, ${edge.count || 0} requests${last}.`;
}

/**
 * Plain-language fallback banner text.
 * @param {{ fromName: string, toName: string, cooldownUntil: string|null }} fallback
 * @param {number} [nowMs]
 * @returns {string} plain English literal
 */
export function fallbackText(fallback, nowMs = Date.now()) {
  const left = formatReset(fallback?.cooldownUntil, nowMs);
  const tail = left ? ` (${left.charAt(0).toLowerCase()}${left.slice(1)})` : " while it cools down";
  return `${fallback.fromName} hit a rate limit. Its traffic is falling back to ${fallback.toName}${tail}.`;
}

/**
 * Merge the 5-minute window model with the full connected-provider list.
 * Providers the window does not know become muted idle nodes; any provider
 * without a client edge gets a hub-side edge in its own state (idle for
 * quiet connections, warn dashes while a cooldown lock holds). The map never
 * invents traffic — hub-side edges only say the provider is connected.
 * @param {object|null} routes window model from `buildLiveRoutes`
 * @param {Array<{ provider?: string, id?: string, name?: string, nodeName?: string }>} [extraProviders]
 * @returns {{ clients: Array, providers: Array, edges: Array, fallbacks: Array }}
 */
export function mergeRoutes(routes, extraProviders = []) {
  const model = routes || {};
  const providers = (model.providers || []).map((p) => ({ ...p }));
  const edges = (model.edges || []).map((e) => ({ ...e }));
  const seen = new Set(providers.map((p) => String(p.id).toLowerCase()));

  for (const extra of extraProviders || []) {
    const id = extra?.provider || extra?.id;
    if (!id || seen.has(String(id).toLowerCase())) continue;
    seen.add(String(id).toLowerCase());
    providers.push({
      id,
      name: extra.nodeName || extra.name || id,
      state: "idle",
      count: 0,
      code: null,
      cooldownUntil: null,
    });
  }

  // Every provider is reachable from the hub, traffic or not.
  const edged = new Set(edges.map((edge) => String(edge.to).toLowerCase()));
  for (const provider of providers) {
    if (edged.has(String(provider.id).toLowerCase())) continue;
    edges.push({ from: null, to: provider.id, count: 0, lastAt: null, state: provider.state });
  }

  return {
    clients: (model.clients || []).map((c) => ({ ...c })),
    providers,
    edges,
    fallbacks: (model.fallbacks || []).map((f) => ({ ...f })),
  };
}

/**
 * Overlay the in-flight SSE frames (`/api/usage/stream`) onto the window
 * model. Conservative: an in-flight provider promotes only an idle node to
 * flowing, a reported error wins outright, and cooling is never masked by a
 * retry in flight. Returns the same object when nothing changes so callers
 * skip a re-render.
 * @param {{ providers: Array, edges: Array }} routes
 * @param {{ activeRequests?: Array<{ provider: string, count: number }>, lastProvider?: string, errorProvider?: string }} [live]
 * @returns {{ providers: Array, edges: Array }}
 */
export function overlayLiveSignal(routes, live) {
  const active = new Set(
    (live?.activeRequests || []).map((r) => r.provider?.toLowerCase()).filter(Boolean),
  );
  const errorKey = live?.errorProvider?.toLowerCase() || "";
  let changed = false;

  const providers = routes.providers.map((provider) => {
    const key = String(provider.id).toLowerCase();
    let state = provider.state;
    if (errorKey && key === errorKey) state = "error";
    else if (state === "idle" && active.has(key)) state = "flowing";
    if (state === provider.state) return provider;
    changed = true;
    return { ...provider, state };
  });
  // Keep the input object when the stream changes nothing — memoized callers
  // skip a re-render.
  if (!changed) return routes;

  const stateById = new Map(providers.map((p) => [String(p.id).toLowerCase(), p.state]));
  const edges = routes.edges.map((edge) => {
    const state = stateById.get(String(edge.to).toLowerCase()) || edge.state;
    return state === edge.state ? edge : { ...edge, state };
  });
  return { ...routes, providers, edges };
}

/**
 * Is the whole map idle? True when nothing flowed in the window and every
 * provider is in the muted idle state (cooldowns and errors are not idle).
 * @param {{ providers?: Array, edges?: Array }} routes
 * @returns {boolean}
 */
export function isIdle(routes) {
  if (!routes) return true;
  const providers = routes.providers || [];
  const edges = routes.edges || [];
  if (edges.some((edge) => edge.from)) return false;
  return providers.every((provider) => provider.state === "idle");
}

/**
 * Truncate a tall provider column for the compact Home variant. Busy or
 * cooling providers always stay; only surplus idle providers are hidden and
 * counted, and their edges go with them.
 * @param {{ providers: Array, edges: Array }} routes
 * @param {number} max maximum visible provider rows
 * @returns {{ providers: Array, edges: Array, hiddenProviders: number }}
 */
export function capProviders(routes, max) {
  const providers = routes.providers || [];
  const limit = Math.max(0, Number(max) || 0);
  const hot = providers.filter((p) => p.state !== "idle");
  const idle = providers.filter((p) => p.state === "idle");
  const room = Math.max(limit - hot.length, 0);
  const keep = new Set([...hot, ...idle.slice(0, room)].map((p) => String(p.id)));
  return {
    ...routes,
    providers: providers.filter((p) => keep.has(String(p.id))),
    edges: (routes.edges || []).filter((e) => keep.has(String(e.to))),
    hiddenProviders: idle.length - Math.min(idle.length, room),
  };
}

/**
 * One-line caption under the idle map. "" until the last-activity time is
 * known or when there was never a request (the Guided empties speak for that
 * case); the relative part follows the same localisation as QuietPeriod.
 * @param {string|null|undefined} lastRequestAt
 * @param {string} [locale]
 * @param {number} [nowMs]
 * @returns {string} plain English literal
 */
export function idleCaption(lastRequestAt, locale = "en", nowMs = Date.now()) {
  if (lastRequestAt === undefined || lastRequestAt === null) return "";
  const relative = formatRelativeFromNow(lastRequestAt, locale, nowMs);
  return relative ? `Idle — last request ${relative}.` : "";
}
