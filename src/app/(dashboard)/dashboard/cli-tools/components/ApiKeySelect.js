"use client";

import { useEffect, useMemo, useState } from "react";
import { ACTIVE } from "@/shared/brand";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Button from "@/shared/components/Button";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { useCliAccessStore } from "@/store/cliAccessStore";
import { useMultiUserActive } from "../hooks/useMultiUserActive";
import { createMemberKey } from "./createMemberKey";
import {
  readKeyPresets,
  upsertKeyPreset,
  deleteKeyPreset,
  subscribeKeyPresets,
  readKeyImportError,
} from "./cliEndpointPresets";

const CUSTOM_VALUE = "__custom__";
const SAVE_VALUE = "__save_key__";

const SOURCE_OPTIONS = [
  { value: "existing", label: "Use existing configured key" },
  { value: "new", label: "Paste new key" },
];
// A member has no host: the key stored on the host is never theirs to reuse.
const MEMBER_SOURCE_OPTIONS = [{ value: "new", label: "Paste or create a key" }];

/**
 * YAN-363 hashed-storage mode: no raw key is recoverable in the browser, so
 * the control offers exactly two grounded choices — reuse the credential the
 * server already keeps on disk (Apply omits the key; the server preserves it
 * for the same destination), or paste one that lives in this page only.
 * Saved presets render as names (refs / external markers), never secrets.
 */
function HashedKeyPicker({
  value,
  onChange,
  existingConfigured = false,
  savedKeys,
  importError,
  multiUser = false,
  className = "",
}) {
  const noHost = useCliAccessStore((st) => st.noHost);
  const { scope } = useSettingsScope();
  // noHost is OR-ed live (not snapshot) so a mid-session role flip is consistent.
  const [pasteModeRaw, setPasteMode] = useState(Boolean(value));
  const pasteMode = pasteModeRaw || noHost;
  const [pasted, setPasted] = useState(typeof value === "string" ? value : "");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState(false);
  // YAN-374: members create their own workspace key here; with the switch off
  // this affordance stays exactly as before (no extra API key management).
  const canCreateKey = useCliAccessStore((s) => s.keyCanCreate);
  const canCreate = multiUser && noHost && canCreateKey;
  const pasteOnly = noHost;

  const createKey = async () => {
    setCreating(true);
    setCreateError("");
    try {
      const raw = await createMemberKey(scope?.workspaceId);
      setPasteMode(true);
      setPasted(raw);
      setCreated(true);
      onChange(raw);
    } catch (err) {
      setCreateError(err.message || "Couldn't create a key.");
    } finally {
      setCreating(false);
    }
  };

  const refPresets = savedKeys.filter((p) => p && typeof p.apiKeyId === "string");
  const externalPresets = savedKeys.filter((p) => p && p.external === true);

  const choose = (mode) => {
    setPasteMode(mode === "new");
    setCreated(false);
    if (mode !== "new") {
      setPasted("");
      onChange("");
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <SegmentedControl
        options={pasteOnly ? MEMBER_SOURCE_OPTIONS : SOURCE_OPTIONS}
        value={pasteMode ? "new" : "existing"}
        onChange={choose}
        aria-label="API key source"
        size="sm"
      />
      {pasteMode ? (
        <input
          type="text"
          value={pasted}
          onChange={(e) => {
            setCreated(false);
            setPasted(e.target.value);
            onChange(e.target.value);
          }}
          placeholder="sk-… (kept in this page only)"
          aria-label="Paste new key"
          autoComplete="off"
          spellCheck={false}
          className="w-full min-w-0 px-2 py-2 bg-panel rounded border border-line text-xs focus:outline-none focus:ring-1 focus:ring-coral/50 sm:py-1.5"
        />
      ) : (
        <p className="text-xs leading-relaxed text-muted" role="status">
          {existingConfigured
            ? "A key is already stored on this device for this tool — it's reused and never displayed."
            : "No stored key on this device yet. Paste one to connect."}
        </p>
      )}
      {canCreate && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon="key"
            onClick={createKey}
            loading={creating}
            disabled={creating}
          >
            Create my key
          </Button>
          <span className="text-[11px] text-subtle">Makes a personal key in your workspace.</span>
        </div>
      )}
      <p role="status" aria-live="polite" className={created ? "text-xs text-warn" : "sr-only"}>
        {created
          ? "Key created. Copy your config now — this key is shown only here and isn't saved."
          : ""}
      </p>
      {createError && (
        <p className="text-xs text-err" role="alert">
          {createError}
        </p>
      )}
      {(refPresets.length > 0 || externalPresets.length > 0) && (
        <p className="text-[11px] leading-relaxed text-subtle">
          Saved key presets: {[...refPresets, ...externalPresets].map((p) => p.name).join(", ")}.
          Referenced by name only — the secret stays on the server and can't be pasted for you.
        </p>
      )}
      {importError && (
        <p className="text-xs text-warn" role="alert">
          {importError}
        </p>
      )}
    </div>
  );
}

export default function ApiKeySelect({
  value,
  onChange,
  apiKeys = [],
  cloudEnabled = false,
  className = "",
  hashed = false,
  existingConfigured = false,
}) {
  const multiUser = useMultiUserActive();
  const [savedKeys, setSavedKeys] = useState([]);
  const [importError, setImportError] = useState("");
  // Custom mode is sticky once the user types, so an emptied input doesn't jump back to a dropdown option
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState("");

  useEffect(() => {
    const sync = () => {
      setSavedKeys(readKeyPresets());
      setImportError(readKeyImportError());
    };
    sync();
    return subscribeKeyPresets(sync);
  }, []);

  const options = useMemo(
    () => [
      ...apiKeys.map((k) => ({ value: k.key, label: k.key })),
      ...savedKeys.map((p) => ({
        value: `saved:${p.name}`,
        label: p.key,
        url: p.key,
        saved: true,
      })),
      { value: CUSTOM_VALUE, label: "Custom...", url: "" },
    ],
    [apiKeys, savedKeys],
  );

  if (hashed) {
    return (
      <HashedKeyPicker
        value={value}
        onChange={onChange}
        existingConfigured={existingConfigured}
        savedKeys={savedKeys}
        importError={importError}
        multiUser={multiUser}
        className={className}
      />
    );
  }

  // Derive the active option from value — no sync effects needed when the parent updates it
  const matched = value ? options.find((o) => o.value === value || o.url === value) : null;
  const mode = matched
    ? matched.value
    : customMode || value
      ? CUSTOM_VALUE
      : (options[0]?.value ?? CUSTOM_VALUE);
  const inputValue = customMode ? customInput : value || "";
  const isSaved = typeof mode === "string" && mode.startsWith("saved:");
  const isCustom = mode === CUSTOM_VALUE;
  const canSave =
    isCustom && (value || "").trim().length > 0 && !apiKeys.some((k) => k.key === value);
  const noKeys = apiKeys.length === 0 && savedKeys.length === 0 && !customMode && !value;

  const handleSelect = (e) => {
    const next = e.target.value;
    if (next === SAVE_VALUE) {
      upsertKeyPreset((value || "").trim());
      return;
    }
    if (next === CUSTOM_VALUE) {
      setCustomMode(true);
      setCustomInput("");
      onChange("");
      return;
    }
    setCustomMode(false);
    setCustomInput("");
    const opt = options.find((o) => o.value === next);
    if (opt) onChange(opt.url ?? opt.value);
  };

  const handleCustomInput = (e) => {
    const v = e.target.value;
    setCustomMode(true);
    setCustomInput(v);
    onChange(v);
  };

  const handleDeleteSaved = () => {
    if (!isSaved) return;
    deleteKeyPreset(mode.slice(6));
    setCustomMode(false);
    setCustomInput("");
    const fallback = options.find((o) => o.value !== CUSTOM_VALUE && o.value !== mode);
    onChange(fallback ? (fallback.url ?? fallback.value) : "");
  };

  if (noKeys) {
    return (
      <span
        className={`min-w-0 rounded bg-panel/40 px-2 py-2 text-xs text-muted sm:py-1.5 ${className}`}
      >
        {cloudEnabled
          ? "No API keys - Create one in Keys page"
          : `${ACTIVE.defaultApiKey} (default)`}
      </span>
    );
  }

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-center gap-2">
        <select
          value={mode}
          onChange={handleSelect}
          className="flex-1 min-w-0 px-2 py-2 bg-panel rounded text-xs border border-line focus:outline-none focus:ring-1 focus:ring-coral/50 sm:py-1.5"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {canSave && <option value={SAVE_VALUE}>+ Save current as...</option>}
        </select>
        {isSaved && (
          <button
            type="button"
            onClick={handleDeleteSaved}
            className="p-1 text-muted hover:text-red-500 rounded transition-colors shrink-0"
            title="Delete saved key"
          >
            <span className="material-symbols-outlined text-[14px]">delete</span>
          </button>
        )}
      </div>
      {isCustom && (
        <input
          type="text"
          value={inputValue}
          onChange={handleCustomInput}
          placeholder="sk-..."
          className="w-full min-w-0 px-2 py-2 bg-panel rounded border border-line text-xs focus:outline-none focus:ring-1 focus:ring-coral/50 sm:py-1.5"
        />
      )}
    </div>
  );
}
