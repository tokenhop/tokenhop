"use client";

import { useState } from "react";
import { useToolSettings } from "./useToolSettings";

/**
 * Persisted model / endpoint / API key for a setup card (`useToolSettings`).
 * Saved values win, then `disk` (host only), then `defaults`. The API key is
 * saved by `apiKeyId`; the endpoint the picker picks at mount isn't a user edit,
 * so it isn't saved.
 *
 * @param {{ toolId: string, apiKeys?: object[], defaults: object, disk?: ?object }} opts
 *   `defaults` and `disk` must be memoized.
 */
export function useSetupSettings({ toolId, apiKeys = [], defaults, disk = null }) {
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

  // ponytail: saves the resolved URL, not the option (Tunnel, Local, …), so a changed
  // tunnel URL keeps the old one until re-picked. Same as Claude; store the option id if it bites.
  const onEndpointChange = (url, meta) => {
    if (meta?.init) setInitUrl(url);
    else setField("endpoint", url);
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

  return {
    values,
    setField,
    loaded: settings.loaded,
    selectedApiKey,
    onApiKeyChange,
    endpoint: values.endpoint || initUrl,
    pickerKey,
    pickerProps: { savedUrl: values.endpoint, onChange: onEndpointChange },
    scaffoldProps: (fileHint) => ({
      saveStatus: settings.status,
      onResetDefaults: settings.hasSaved ? resetDefaults : undefined,
      differsHint: settings.differs.length ? fileHint : undefined,
      onLoadFromFile: loadFromFile,
    }),
  };
}
