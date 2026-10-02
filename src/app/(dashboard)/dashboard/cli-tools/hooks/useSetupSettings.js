"use client";

import { useState } from "react";
import { readPresets } from "../components/cliEndpointPresets";
import { resolveSavedEndpoint } from "../lib/toolStatus";
import { useToolSettings } from "./useToolSettings";

// The API accepts nested objects and arrays; these cards only read strings.
const str = (v) => (typeof v === "string" ? v : "");

/**
 * Saved endpoint resolved against the live options (also used by the Claude card).
 */
export const savedEndpointUrl = (values, endpointContext) =>
  resolveSavedEndpoint(
    { endpoint: str(values.endpoint), endpointId: str(values.endpointId) },
    {
      ...endpointContext,
      localOrigin: typeof window === "undefined" ? "" : window.location.origin,
      savedPresets: readPresets(),
    },
  );

/** Type guards for saved values the API allows but a card must not trust. */
export const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
export const asMap = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string"))
    : {};

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
  // ponytail: typed keys stay in memory only (no raw secrets in the DB); YAN-642.
  const [customKey, setCustomKey] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);

  // A deleted key's id matches nothing and falls back to the first key.
  const selectedApiKey =
    customKey ?? (apiKeys.find((k) => k.id === values.apiKeyId)?.key || apiKeys[0]?.key || "");

  const onApiKeyChange = (key) => {
    const match = apiKeys.find((k) => k.key === key);
    if (!match) return setCustomKey(key);
    setCustomKey(null);
    setField("apiKeyId", match.id);
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
    remountPicker();
  };

  const savedEndpoint = savedEndpointUrl(values, endpointContext);

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
