// Settings key classification (YAN-362). Pure: no imports, safe in any bundle.
// - workspace: routing/prompt/ping behaviour, one value set per workspace.
// - user: personal UI preferences.
// - removed: `password` moved to users.passwordHash.
// - instance: everything else (default).
// Stored `settings` blob keeps every key as the instance default; a workspace
// or user row holds explicit overrides only.

export const WORKSPACE_KEYS = new Set([
  "fallbackStrategy",
  "stickyRoundRobinLimit",
  "providerStrategies",
  "comboStrategy",
  "comboStickyRoundRobinLimit",
  "comboStrategies",
  "capacityAdapter",
  "quotaVisibility",
  "providerThinking",
  "ccFilterNaming",
  "rtkEnabled",
  "cavemanEnabled",
  "cavemanLevel",
  "ponytailEnabled",
  "ponytailLevel",
  "claudeAutoPing",
  "codexAutoPing",
]);

export const USER_KEYS = new Set(["startPage", "uiDensity", "lastWorkspaceId"]);

// Workspace map keys whose entries inherit per id (YAN-770): a workspace
// override entry beats the instance entry, every other id keeps inheriting
// the instance one. comboStrategies is excluded (id-keyed, YAN-364 special
// case: the workspace map replaces the instance blob wholesale).
export const MAP_KEYS = new Set([
  "providerStrategies",
  "quotaVisibility",
  "providerThinking",
  "claudeAutoPing",
  "codexAutoPing",
]);

// Auto-ping maps nest their per-id entries under `connections`.
const NESTED_MAP_KEYS = new Set(["claudeAutoPing", "codexAutoPing"]);

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function mergeEntries(key, base, value) {
  const out = { ...base, ...value };
  if (NESTED_MAP_KEYS.has(key) && isPlain(base.connections) && isPlain(value.connections)) {
    out.connections = { ...base.connections, ...value.connections };
  }
  return out;
}

/**
 * Spread one workspace's overrides over `merged` (YAN-362). MAP_KEYS merge
 * per entry instead of replacing the whole map (YAN-770); auto-ping merges
 * per connection id. A non-object on either side keeps today's whole-key
 * replace. Mutates and returns `merged`.
 * @param {object} merged Instance values (the object getSettings returned).
 * @param {object} wsData The workspace's own overrides (already picked).
 * @returns {object}
 */
export function mergeWorkspaceLayer(merged, wsData) {
  for (const [key, value] of Object.entries(wsData || {})) {
    const base = merged[key];
    merged[key] =
      MAP_KEYS.has(key) && isPlain(value) && isPlain(base) ? mergeEntries(key, base, value) : value;
  }
  return merged;
}

const REMOVED_KEYS = new Set(["password"]);

/** Subset of `obj` whose own keys are in `set`. */
export function pickKeys(obj, set) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) if (set.has(k)) out[k] = obj[k];
  return out;
}

/** @returns {"workspace"|"user"|"instance"|"removed"} */
export function classifyKey(key) {
  if (WORKSPACE_KEYS.has(key)) return "workspace";
  if (USER_KEYS.has(key)) return "user";
  if (REMOVED_KEYS.has(key)) return "removed";
  return "instance";
}
