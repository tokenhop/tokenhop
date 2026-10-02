"use client";

import { useState, useSyncExternalStore } from "react";
import {
  readPresets,
  subscribePresets,
  readKeyPresets,
  subscribeKeyPresets,
} from "../components/cliEndpointPresets";
import { resolveSavedEndpoint } from "../lib/toolStatus";
import { useToolSettings } from "./useToolSettings";

// The API accepts nested objects and arrays; these cards only read strings.
const str = (v) => (typeof v === "string" ? v : "");
// Stable snapshot for useSyncExternalStore's SSR fallback.
const EMPTY = [];

/**
 * Saved endpoint resolved against the live options (also used by the Claude card).
 * Callers pass presets from their own useSyncExternalStore subscription so a
 * preset saved after mount re-renders them.
 */
export const savedEndpointUrl = (values, endpointContext, savedPresets = EMPTY) =>
  resolveSavedEndpoint(
    { endpoint: str(values.endpoint), endpointId: str(values.endpointId) },
    {
      ...endpointContext,
      localOrigin: typeof window === "undefined" ? "" : window.location.origin,
      savedPresets,
    },
  );

/** Type guards for saved values the API allows but a card must not trust. */
export const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
export const asMap = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string"))
    : {};
// Saved values are read back untrusted; plugin lists keep whole plain objects,
// filtered to entries with a string name and url.
export const asObjectList = (v) =>
  Array.isArray(v)
    ? v.filter(
        (p) =>
          p && typeof p === "object" && typeof p.name === "string" && typeof p.url === "string",
      )
    : [];

/**
 * API-key selection shared with the Claude card, which passes the on-disk token
 * as its fallback. Saved key id, else saved key preset, else the caller's
 * fallback (host: the key in the file), else the first key. A deleted key's id
 * matches nothing and falls through the same way.
 */
export const resolveSelectedApiKey = ({
  customKey,
  apiKeys = [],
  keyPresets = [],
  values,
  fallback = "",
}) =>
  customKey ??
  (apiKeys.find((k) => k.id === values.apiKeyId)?.key ||
    keyPresets.find((p) => p.name === values.apiKeyPreset)?.key ||
    fallback ||
    apiKeys[0]?.key ||
    "");

/**
 * Persisted patch for a picked key: a dashboard key by id, a raw key preset by
 * name, or null when the key is typed/custom (kept in memory only).
 */
export const apiKeyPatch = (key, apiKeys = [], keyPresets = []) => {
  const match = apiKeys.find((k) => k.key === key);
  if (match) return { apiKeyId: match.id, apiKeyPreset: undefined };
  const preset = keyPresets.find((p) => p.key === key);
  if (preset) return { apiKeyPreset: preset.name, apiKeyId: undefined };
  return null;
};

/**
 * Persisted model / endpoint / API key for a setup card (`useToolSettings`).
 * Saved values win, then `disk` (host only), then `defaults`. The API key is
 * saved by `apiKeyId`; the endpoint is saved as url + option id, so a saved
 * option follows its current URL (`resolveSavedEndpoint`). The endpoint the
 * picker picks at mount isn't a user edit, so it isn't saved.
 *
 * @param {{ toolId: string, apiKeys?: object[], defaults: object, disk?: ?object, endpointContext?: object }} opts
 *   `defaults`, `disk` and `endpointContext` must be memoized. `endpointContext`
 *   carries the picker's tunnel/tailscale/cloud/… options and is spread into
 *   `pickerProps`.
 */
export function useSetupSettings({
  toolId,
  apiKeys = [],
  defaults,
  disk = null,
  endpointContext = {},
}) {
  const [values, setField, settings] = useToolSettings(toolId, defaults, disk);
  const [initUrl, setInitUrl] = useState("");
  // ponytail: only typed, unsaved keys stay in memory; saved picks persist by
  // apiKeyId (dashboard key) or apiKeyPreset (raw key preset, YAN-642).
  const [customKey, setCustomKey] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);
  const keyPresets = useSyncExternalStore(subscribeKeyPresets, readKeyPresets, () => EMPTY);
  const endpointPresets = useSyncExternalStore(subscribePresets, readPresets, () => EMPTY);

  const selectedApiKey = resolveSelectedApiKey({ customKey, apiKeys, keyPresets, values });

  const onApiKeyChange = (key) => {
    const patch = apiKeyPatch(key, apiKeys, keyPresets);
    if (!patch) return setCustomKey(key);
    setCustomKey(null);
    settings.setFields(patch);
  };

  const onEndpointChange = (url, meta) => {
    if (meta?.init) setInitUrl(url);
    else settings.setFields({ endpoint: url, endpointId: meta?.id });
  };

  const remountPicker = () => {
    setCustomKey(null);
    setPickerKey((k) => k + 1);
  };

  const resetDefaults = async () => {
    if (!(await settings.reset())) return;
    setInitUrl("");
    remountPicker();
  };

  const loadFromFile = () => {
    settings.loadFromDisk();
    // The saved endpoint id would keep winning over the file URL, so clear it.
    if (settings.differs.includes("endpoint")) settings.setFields({ endpointId: undefined });
    remountPicker();
  };

  const savedEndpoint = savedEndpointUrl(values, endpointContext, endpointPresets);

  return {
    values,
    setField,
    setFields: settings.setFields,
    model: str(values.model),
    setModel: (v) => setField("model", v),
    loaded: settings.loaded,
    selectedApiKey,
    onApiKeyChange,
    endpoint: savedEndpoint || initUrl,
    pickerKey,
    pickerProps: { ...endpointContext, savedUrl: savedEndpoint, onChange: onEndpointChange },
    scaffoldProps: (fileHint) => ({
      saveStatus: settings.status,
      onResetDefaults: settings.hasSaved ? resetDefaults : undefined,
      differsHint: settings.differs.length ? fileHint : undefined,
      onLoadFromFile: loadFromFile,
    }),
  };
}
