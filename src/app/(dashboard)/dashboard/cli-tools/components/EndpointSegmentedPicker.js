"use client";

import PropTypes from "prop-types";
import { useEffect, useMemo, useState } from "react";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { buildEndpointOptions, ENDPOINT_CUSTOM_VALUE } from "../lib/toolStatus";
import { readPresets, subscribePresets, stripSlash } from "./cliEndpointPresets";

/**
 * Signal endpoint picker for CLI setup cards. Segmented choices
 * (Local / Tunnel / Tailscale / Custom) plus a saved-preset Select when
 * presets exist; matches the old BaseUrlSelect option algebra exactly
 * (saved presets preserved, custom URL typed inline).
 *
 * @param {object} props
 * @param {string} props.value Currently selected or typed URL.
 * @param {(nextUrl: string) => void} props.onChange
 * @param {boolean} [props.requiresExternalUrl=false] Disables Local.
 * @param {boolean} [props.tunnelEnabled=false]
 * @param {string} [props.tunnelPublicUrl=""]
 * @param {boolean} [props.tailscaleEnabled=false]
 * @param {string} [props.tailscaleUrl=""]
 * @param {boolean} [props.cloudEnabled=false]
 * @param {string} [props.cloudUrl=""]
 * @param {boolean} [props.withV1=true]
 * @param {string} [props.currentUrl=""] Existing configured URL (prefers its saved preset).
 * @param {string} [props.className]
 */
export default function EndpointSegmentedPicker({
  value,
  onChange,
  requiresExternalUrl = false,
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  cloudEnabled = false,
  cloudUrl = "",
  withV1 = true,
  currentUrl = "",
  className = "",
}) {
  const [localOrigin, setLocalOrigin] = useState("");
  const [customDraft, setCustomDraft] = useState("");
  const [savedPresets, setSavedPresets] = useState([]);
  const [mode, setMode] = useState(null);

  useEffect(() => {
    setLocalOrigin(window.location.origin);
    const sync = () => setSavedPresets(readPresets());
    sync();
    return subscribePresets(sync);
  }, []);

  const options = useMemo(
    () =>
      buildEndpointOptions({
        requiresExternalUrl,
        tunnelEnabled,
        tunnelPublicUrl,
        tailscaleEnabled,
        tailscaleUrl,
        cloudEnabled,
        cloudUrl,
        savedPresets,
        withV1,
        localOrigin,
      }),
    [
      requiresExternalUrl,
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      cloudEnabled,
      cloudUrl,
      savedPresets,
      withV1,
      localOrigin,
    ],
  );

  // Init: prefer the saved preset matching currentUrl, else the first option.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once init; currentUrl/onChange are intentionally snapshot at mount
  useEffect(() => {
    if (mode !== null || options.length === 0) return;
    const current = stripSlash(currentUrl);
    const matchedSaved = current
      ? options.find((o) => o.value.startsWith("saved:") && stripSlash(o.url) === current)
      : null;
    const target =
      matchedSaved || options.find((o) => o.value !== ENDPOINT_CUSTOM_VALUE) || options[0];
    setMode(target.value);
    if (target.url) onChange?.(target.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, mode]);

  const liveMatched = useMemo(() => {
    const stripped = stripSlash(value);
    if (!stripped) return null;
    const saved = options.find(
      (o) => o.value.startsWith("saved:") && stripSlash(o.url) === stripped,
    );
    if (saved) return saved;
    return (
      options.find((o) => o.value !== ENDPOINT_CUSTOM_VALUE && stripSlash(o.url) === stripped) ||
      null
    );
  }, [options, value]);

  // A preset saved elsewhere (e.g. on Apply) takes over when it matches.
  useEffect(() => {
    if (mode !== ENDPOINT_CUSTOM_VALUE || !value) return;
    const typed = stripSlash(value);
    const match = options.find((o) => o.value.startsWith("saved:") && stripSlash(o.url) === typed);
    if (match) setMode(match.value);
  }, [options, mode, value]);

  const activeValue = mode ?? liveMatched?.value ?? ENDPOINT_CUSTOM_VALUE;
  const activeIsBuiltIn =
    activeValue !== ENDPOINT_CUSTOM_VALUE && !activeValue.startsWith("saved:");

  const handleSegmentChange = (nextValue) => {
    if (nextValue === ENDPOINT_CUSTOM_VALUE) {
      setMode(ENDPOINT_CUSTOM_VALUE);
      setCustomDraft("");
      onChange?.("");
      return;
    }
    const found = options.find((o) => o.value === nextValue);
    if (!found) return;
    setMode(nextValue);
    setCustomDraft("");
    if (found.url) onChange?.(found.url);
  };

  const handleSavedChange = (event) => {
    const next = event.target.value;
    setMode(next);
    setCustomDraft("");
    const found = options.find((o) => o.value === next);
    if (found?.url) onChange?.(found.url);
  };

  const handleCustomChange = (event) => {
    const next = event.target.value;
    setCustomDraft(next);
    setMode(ENDPOINT_CUSTOM_VALUE);
    onChange?.(next);
  };

  const builtinOptions = options.filter((o) => !o.value.startsWith("saved:"));
  const savedOptions = options.filter((o) => o.value.startsWith("saved:"));
  const showCustom = activeValue === ENDPOINT_CUSTOM_VALUE;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">Endpoint</span>
      <SegmentedControl
        options={builtinOptions.map((o) => ({ value: o.value, label: o.label }))}
        value={activeIsBuiltIn ? activeValue : ENDPOINT_CUSTOM_VALUE}
        onChange={handleSegmentChange}
        aria-label="Select endpoint"
        size="sm"
      />
      {savedOptions.length > 0 && (
        <Select
          label="Saved endpoint"
          value={activeValue.startsWith("saved:") ? activeValue : ""}
          onChange={handleSavedChange}
          placeholder="Saved endpoints"
          options={savedOptions.map((o) => ({ value: o.value, label: o.label }))}
        />
      )}
      {showCustom && (
        <Input
          type="url"
          value={value ?? customDraft}
          onChange={handleCustomChange}
          placeholder={withV1 ? "https://example.com/v1" : "https://example.com"}
          aria-label="Custom endpoint URL"
          className="w-full"
        />
      )}
    </div>
  );
}

EndpointSegmentedPicker.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  requiresExternalUrl: PropTypes.bool,
  tunnelEnabled: PropTypes.bool,
  tunnelPublicUrl: PropTypes.string,
  tailscaleEnabled: PropTypes.bool,
  tailscaleUrl: PropTypes.string,
  cloudEnabled: PropTypes.bool,
  cloudUrl: PropTypes.string,
  withV1: PropTypes.bool,
  currentUrl: PropTypes.string,
  className: PropTypes.string,
};
