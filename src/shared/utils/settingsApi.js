import { classifyKey } from "@/lib/settings/settingsScope";

// Client-side settings I/O (YAN-371). `scope = null` (single-user / inactive)
// always means /api/settings, byte-identical to the legacy behaviour. When
// active the page provides `{ workspaceId }` and keys route by classifyKey.

const INSTANCE_ENDPOINT = "/api/settings";

/**
 * Endpoint that owns `key`.
 * @param {string} key Settings key.
 * @param {{ workspaceId?: string } | null} [scope=null]
 * @returns {string}
 */
export function settingsEndpoint(key, scope = null) {
  if (!scope) return INSTANCE_ENDPOINT;
  const kind = classifyKey(key);
  if (kind === "workspace" && scope.workspaceId) {
    return `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/settings`;
  }
  if (kind === "user") return "/api/me/preferences";
  return INSTANCE_ENDPOINT;
}

/**
 * PATCH keys to their owning endpoints (one request per endpoint).
 * Resolves with the flat accepted values; throws the server's message.
 * @param {Record<string, *>} patch
 * @param {{ workspaceId?: string } | null} [scope=null]
 * @returns {Promise<Record<string, *>>}
 */
export async function patchSettings(patch, scope = null) {
  const groups = new Map();
  for (const [key, value] of Object.entries(patch)) {
    const url = settingsEndpoint(key, scope);
    groups.set(url, { ...groups.get(url), [key]: value });
  }
  const accepted = {};
  for (const [url, body] of groups) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Earlier endpoints may already have committed (no cross-endpoint
      // transaction): expose what was accepted so callers can reconcile.
      const err = new Error(data.error || "Failed to save setting");
      err.accepted = accepted;
      throw err;
    }
    Object.assign(accepted, url === INSTANCE_ENDPOINT ? data : (data.data ?? {}));
  }
  return accepted;
}

// Same `HTTP <status>: <message>` text the pages built before YAN-749.
// `status` marks an HTTP error, as opposed to a network failure.
async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data.message || data.error || data.code || res.statusText || "Request failed";
    const err = new Error(`HTTP ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * `.catch` handler for callers that treated a non-OK settings GET as empty:
 * HTTP errors resolve to `value`, network failures still reject.
 * @param {*} value
 */
export const onHttpError = (value) => (err) => {
  if (err?.status) return value;
  throw err;
};

/**
 * Settings values a page reads (YAN-749). `scope` null: the legacy GET
 * /api/settings, unchanged. Scoped: instance values (only when the viewer may
 * manage the instance, so members never hit a 403), then the workspace's
 * effective values, then (`withPreferences`) the user's preferences.
 * @param {{ workspaceId?: string } | null} [scope=null]
 * @param {{ canManageInstance?: boolean, withPreferences?: boolean }} [opts]
 * @returns {Promise<Record<string, *>>} Throws when a GET fails.
 */
export async function loadSettings(scope = null, opts = {}) {
  if (!scope) return getJson(INSTANCE_ENDPOINT);
  const { canManageInstance = false, withPreferences = false } = opts;
  const [instance, workspace, prefs] = await Promise.all([
    canManageInstance ? getJson(INSTANCE_ENDPOINT) : {},
    scope.workspaceId
      ? getJson(`/api/workspaces/${encodeURIComponent(scope.workspaceId)}/settings`)
      : { effective: {} },
    withPreferences ? getJson("/api/me/preferences") : { data: {} },
  ]);
  return { ...instance, ...(workspace.effective ?? {}), ...(prefs.data ?? {}) };
}

/**
 * Key of a combo's entry in `comboStrategies`: workspace maps are keyed by
 * combo id (YAN-364), the legacy instance blob by name.
 * @param {{ workspaceId?: string } | null} scope
 * @param {{ id?: string, name: string }} combo
 * @returns {string}
 */
export function comboStrategyKeyFor(scope, combo) {
  return scope?.workspaceId ? combo.id : combo.name;
}

/**
 * Fresh server value of one key (for read-modify-write saves).
 * Scoped workspace reads prefer `effective` (instance + workspace).
 * @param {string} key
 * @param {{ workspaceId?: string } | null} [scope=null]
 * @param {string} [fallback] Error text when the server sends none.
 * @returns {Promise<*>} Throws the server's message when the GET fails.
 */
export async function loadSettingsValue(
  key,
  scope = null,
  fallback = "Could not load current settings.",
) {
  const url = settingsEndpoint(key, scope);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || fallback);
  }
  const body = await res.json();
  if (url === INSTANCE_ENDPOINT) return body[key];
  const values = body.effective ?? body.data ?? {};
  return values[key];
}
