// Shared pieces of the per-tool config builders. Each builder is pure (no fs,
// no node imports) so the Apply route and the manual snippet in the browser
// build the same values.
import { stringifyTOML } from "confbox/toml";
import { ACTIVE } from "@/shared/brand";

/** Shown in manual snippets when no API key is known. */
export const API_KEY_PLACEHOLDER = "<API_KEY_FROM_DASHBOARD>";

export const withV1 = (url) => (url.endsWith("/v1") ? url : `${url}/v1`);
export const withoutV1 = (url) => (url.endsWith("/v1") ? url.slice(0, -3) : url);

/** Key Apply sends: selected key, first key, or the brand default key when not cloud. */
export const resolveApiKey = (selectedApiKey, apiKeys, cloudEnabled) =>
  selectedApiKey?.trim() || apiKeys?.[0]?.key || (!cloudEnabled ? ACTIVE.defaultApiKey : null);

/** Key a manual snippet shows: the same key Apply would send, else the placeholder. */
export const manualApiKey = (selectedApiKey, apiKeys, cloudEnabled) =>
  resolveApiKey(selectedApiKey, apiKeys, cloudEnabled) ?? API_KEY_PLACEHOLDER;

/**
 * A builder fragment: `{ file, format: "json" | "toml" | "text", merge: boolean, value }`; merge
 * means "merge into the existing file", otherwise the fragment replaces it.
 * `value` is an object for json/toml and a string for text; it is exactly what
 * Apply writes to `file` when the file does not exist yet.
 */
export const renderFragment = ({ format, value }) => {
  if (format === "json") return JSON.stringify(value, null, 2);
  if (format === "toml" && typeof value !== "string") return stringifyTOML(value);
  return value;
};

/**
 * ManualConfigList entries for a builder result; `null` (missing input) → `[]`.
 * An optional fragment note replaces the default "merge into existing" hint.
 */
export const toManualConfigs = (fragments) =>
  (fragments || []).map((fragment) => {
    const note = fragment.note || (fragment.merge ? "merge into existing" : "");
    return {
      filename: note ? `${fragment.file} (${note})` : fragment.file,
      content: renderFragment(fragment),
    };
  });

/** Best guess of the browser user's OS, for snippets whose paths differ per OS. */
export const browserPlatform = () => {
  if (typeof navigator === "undefined") return "linux";
  if (navigator.userAgent.includes("Mac")) return "darwin";
  if (navigator.userAgent.includes("Win")) return "win32";
  return "linux";
};
