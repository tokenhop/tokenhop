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
