/**
 * Live-routes flow model for the Home command center (YAN-293).
 *
 * Derives { clients, providers, edges, fallbacks } from recorded requests in a
 * rolling 5-minute window. Pure function, no IO — unit testable without a DB.
 *
 * Inputs (all recorded, nothing synthesized):
 * - usageRows: successful requests (usageHistory) with keyName/userAgent/comboName
 * - errorRows: failed attempts (requestDetails status "error") with the upstream status
 * - connections: provider connections (active model locks = cooling)
 * - fallbackHops: recorded failed combo steps ({ timestamp, provider, comboName, status })
 */

/** Rolling window for live routes: the last 5 minutes. */
export const WINDOW_MS = 5 * 60 * 1000;

/** Human labels for the four edge states. */
export const EDGE_STATE_LABEL = {
  error: "Error",
  cooling: "Cooling down",
  flowing: "Flowing",
  idle: "Idle",
};

/** User-agent family matchers, checked in order. */
const UA_FAMILIES = [
  [/claude-code|claude-cli/i, "Claude Code"],
  [/codex/i, "Codex CLI"],
  [/cursor/i, "Cursor"],
  [/gemini-cli/i, "Gemini CLI"],
  [/antigravity/i, "Antigravity"],
  [/githubcopilot|copilot/i, "GitHub Copilot"],
  [/cline/i, "Cline"],
  [/kilo/i, "Kilo Code"],
  [/opencode/i, "OpenCode"],
  [/droid/i, "Droid"],
  [/aider/i, "Aider"],
  [/openai-python|openai\/python/i, "OpenAI SDK (Python)"],
  [/openai\/js|openai-node/i, "OpenAI SDK (JS)"],
  [/python-requests|python-httpx|aiohttp/i, "Python"],
  [/curl\//i, "curl"],
];

/**
 * Identify the client column label for one request: API key name, else the
 * user-agent family, else "Unknown client".
 * @param {{ keyName?: string|null, userAgent?: string|null }} row
 * @returns {string} plain English literal
 */
export function identifyClient(row) {
  if (row?.keyName) return row.keyName;
  const ua = typeof row?.userAgent === "string" ? row.userAgent : "";
  for (const [pattern, family] of UA_FAMILIES) {
    if (pattern.test(ua)) return family;
  }
  return "Unknown client";
}

function inWindow(timestamp, now) {
  const then = new Date(timestamp).getTime();
  return !Number.isNaN(then) && then > now - WINDOW_MS && then <= now;
}

/** Latest active lock expiry across a provider's connections (ISO) or null. */
function activeLockUntil(connections, now) {
  let latest = 0;
  for (const connection of connections) {
    for (const [key, value] of Object.entries(connection || {})) {
      if (!key.startsWith("modelLock_") || !value) continue;
      const then = new Date(value).getTime();
      if (then > now && then > latest) latest = then;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

/**
 * Build the live-routes flow model from recorded requests.
 *
 * State precedence per provider: error > cooling > flowing > idle.
 * - error: a non-429 failed attempt in the window
 * - cooling: a 429 in the window, or an active cooldown lock
 * - flowing: successful requests in the window
 *
 * @param {object} options
 * @param {Array<object>} [options.usageRows] { timestamp, provider, model, keyName, userAgent, comboName }
 * @param {Array<object>} [options.errorRows] { timestamp, provider, model, status }
 * @param {Array<object>} [options.connections] provider connections
 * @param {Array<object>} [options.fallbackHops] recorded failed combo steps
 * @param {Record<string,string>} [options.providerNames] provider id -> display name
 * @param {number} [options.now] epoch ms
 */
export function buildLiveRoutes({
  usageRows = [],
  errorRows = [],
  connections = [],
  fallbackHops = [],
  providerNames = {},
  now = Date.now(),
} = {}) {
  const ok = (usageRows || []).filter((row) => row?.provider && inWindow(row.timestamp, now));
  const failed = (errorRows || []).filter((row) => row?.provider && inWindow(row.timestamp, now));

  const byProvider = new Map();
  const touch = (id) => {
    if (!byProvider.has(id)) {
      byProvider.set(id, { ok: 0, errors: 0, rateLimited: 0, lastCode: null, conns: [] });
    }
    return byProvider.get(id);
  };
  for (const connection of connections || []) {
    if (connection?.provider && connection.isActive !== false) {
      touch(connection.provider).conns.push(connection);
    }
  }
  for (const row of ok) touch(row.provider).ok += 1;
  for (const row of failed) {
    const entry = touch(row.provider);
    const code = Number(row.status) || null;
    if (code === 429) entry.rateLimited += 1;
    else entry.errors += 1;
    entry.lastCode = code ? String(code) : "ERR";
  }

  const providers = [...byProvider.entries()]
    .map(([id, entry]) => {
      const cooldownUntil = activeLockUntil(entry.conns, now);
      let state = "idle";
      if (entry.errors > 0) state = "error";
      else if (entry.rateLimited > 0 || cooldownUntil) state = "cooling";
      else if (entry.ok > 0) state = "flowing";
      return {
        id,
        name: providerNames[id] || id,
        state,
        count: entry.ok + entry.errors + entry.rateLimited,
        code: state === "error" || state === "cooling" ? entry.lastCode : null,
        cooldownUntil,
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const providerState = new Map(providers.map((p) => [p.id, p.state]));

  const edgeGroups = new Map();
  const clientCounts = new Map();
  for (const row of ok) {
    const client = identifyClient(row);
    clientCounts.set(client, (clientCounts.get(client) || 0) + 1);
    const key = `${client}\u0000${row.provider}`;
    const group = edgeGroups.get(key) || { from: client, to: row.provider, count: 0, lastAt: null };
    group.count += 1;
    if (!group.lastAt || row.timestamp > group.lastAt) group.lastAt = row.timestamp;
    edgeGroups.set(key, group);
  }
  const edges = [...edgeGroups.values()]
    .map((group) => ({ ...group, state: providerState.get(group.to) || "flowing" }))
    .sort((a, b) => b.count - a.count);
  const clients = [...clientCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  // Fallback hop: a recorded failed combo step, paired with the winning provider
  // (the combo-model success nearest after it in the window). Failed hops that
  // never led anywhere stay out of the banner.
  const fallbacks = [];
  const seen = new Set();
  const wins = ok.filter((row) => row?.comboName);
  for (const hop of fallbackHops || []) {
    if (!inWindow(hop?.timestamp, now) || !hop?.provider) continue;
    const win = wins.find(
      (row) => row.comboName === hop.comboName && row.timestamp >= hop.timestamp,
    );
    if (!win || win.provider === hop.provider) continue;
    const key = `${hop.provider}|${win.provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = providers.find((p) => p.id === hop.provider);
    fallbacks.push({
      from: hop.provider,
      fromName: providerNames[hop.provider] || hop.provider,
      to: win.provider,
      toName: providerNames[win.provider] || win.provider,
      status: Number(hop.status) || null,
      cooldownUntil: from?.cooldownUntil || null,
    });
  }

  return { clients, providers, edges, fallbacks };
}
