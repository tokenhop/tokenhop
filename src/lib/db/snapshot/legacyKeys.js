// Workspace-scoped legacy key helpers shared by the snapshot export/import
// modules. Pure; no driver/barrel imports.

export const WS_KEY_PREFIX_RE = /^ws:[^/]+\//;

export function stripWsKey(key) {
  return key.replace(WS_KEY_PREFIX_RE, "");
}

export function isLegacyDefaultKey(key, defaultWs) {
  return !WS_KEY_PREFIX_RE.test(key) || (defaultWs != null && key.startsWith(`ws:${defaultWs}/`));
}
