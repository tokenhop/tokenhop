"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  flushToolSettings,
  loadToolSettings,
  resetToolSettings,
  setToolSettings,
  useToolSettingsStore,
} from "@/store/toolSettingsStore";
import { diffFromDisk, mergeToolSettings } from "@/lib/cliToolConfigs/toolSettings";

/**
 * Persisted per-tool card settings. Precedence: saved, then on-disk (host
 * only), then defaults. Edits autosave (500 ms debounce, flushed on unmount
 * and `beforeunload`).
 *
 * @param {string} toolId
 * @param {object} defaults Card defaults; memoize in the caller.
 * @param {?object} [disk] On-disk values (host only); memoize in the caller.
 * @returns {[object, (key: string, value: *) => void, {
 *   loaded: boolean,
 *   status: ""|"saving"|"saved"|"error",
 *   hasSaved: boolean,
 *   setFields: (patch: object) => void,
 *   reset: () => Promise<boolean>,
 *   differs: string[],
 *   loadFromDisk: () => void,
 * }]} Merged values, single-field setter, and helpers. `undefined` in a patch deletes the key.
 */
export function useToolSettings(toolId, defaults, disk = null) {
  const saved = useToolSettingsStore((s) => s.saved[toolId]);
  const loaded = useToolSettingsStore((s) => s.loaded);
  const status = useToolSettingsStore((s) => s.status[toolId] ?? "");

  useEffect(() => {
    loadToolSettings();
    const flush = () => flushToolSettings(toolId);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [toolId]);

  const setFields = useCallback((patch) => setToolSettings(toolId, patch), [toolId]);
  const setField = useCallback((key, value) => setFields({ [key]: value }), [setFields]);
  const reset = useCallback(() => resetToolSettings(toolId), [toolId]);

  const values = useMemo(() => mergeToolSettings(defaults, disk, saved), [defaults, disk, saved]);
  const differs = useMemo(() => diffFromDisk(saved, disk), [saved, disk]);

  const loadFromDisk = useCallback(() => {
    setFields(Object.fromEntries(differs.map((key) => [key, undefined])));
  }, [differs, setFields]);

  const hasSaved = Boolean(saved && Object.keys(saved).length > 0);
  return [values, setField, { loaded, status, hasSaved, setFields, reset, differs, loadFromDisk }];
}
