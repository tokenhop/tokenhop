import { createContext } from "react";
import { classifyKey } from "@/lib/settings/settingsScope";

// Client-side settings I/O (YAN-371). `scope = null` (single-user / inactive)
// always means /api/settings, byte-identical to the legacy behaviour. When
// active the page provides `{ workspaceId }` and keys route by classifyKey.

const INSTANCE_ENDPOINT = "/api/settings";

/** `{ workspaceId } | null`, provided by the settings page when multi-user is active. */
export const SettingsScopeContext = createContext(null);

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
    if (!res.ok) throw new Error(data.error || "Failed to save setting");
    Object.assign(accepted, url === INSTANCE_ENDPOINT ? data : (data.data ?? {}));
  }
  return accepted;
}

/**
 * Fresh server value of one key (for read-modify-write saves).
 * Scoped workspace reads prefer `effective` (instance + workspace).
 * @param {string} key
 * @param {{ workspaceId?: string } | null} [scope=null]
 * @returns {Promise<*>} Throws when the GET fails.
 */
export async function loadSettingsValue(key, scope = null) {
  const url = settingsEndpoint(key, scope);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load current settings.");
  const body = await res.json();
  if (url === INSTANCE_ENDPOINT) return body[key];
  const values = body.effective ?? body.data ?? {};
  return values[key];
}
