"use client";

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { debounce } from "../../settings/useSettingsField";
import { diffFromDisk, mergeToolSettings } from "../lib/toolSettings";

export const useToolSettingsStore = create(() => ({ saved: {}, loaded: false, status: {} }));

const SAVE_DEBOUNCE_MS = 500;
const savers = new Map(); // toolId -> { dirty, debounced, flush, cancel }

const setStatus = (toolId, status) =>
  useToolSettingsStore.setState((s) => ({ status: { ...s.status, [toolId]: status } }));

const api = (toolId, init) => fetch(`/api/cli-tool-settings/${toolId}`, init);

function saverFor(toolId) {
  let saver = savers.get(toolId);
  if (saver) return saver;
  saver = { dirty: false };
  const send = async () => {
    if (!saver.dirty) return;
    saver.dirty = false;
    setStatus(toolId, "saving");
    try {
      const res = await api(toolId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(useToolSettingsStore.getState().saved[toolId] || {}),
        keepalive: true,
      });
      setStatus(toolId, res.ok ? "saved" : "error");
    } catch {
      setStatus(toolId, "error");
    }
  };
  saver.debounced = debounce(send, SAVE_DEBOUNCE_MS);
  saver.flush = () => {
    saver.debounced.cancel();
    return send();
  };
  saver.cancel = () => {
    saver.debounced.cancel();
    saver.dirty = false;
  };
  savers.set(toolId, saver);
  return saver;
}

let loadPromise = null;

/** One-shot GET of every tool's saved settings; a failure still unblocks the UI. */
export function ensureLoaded() {
  loadPromise ??= (async () => {
    try {
      const res = await fetch("/api/cli-tool-settings");
      const data = await res.json().catch(() => ({}));
      useToolSettingsStore.setState({ saved: (res.ok && data.settings) || {} });
    } catch {
      useToolSettingsStore.setState({ saved: {} });
    }
    useToolSettingsStore.setState({ loaded: true });
  })();
  return loadPromise;
}

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
    ensureLoaded();
    const flush = () => savers.get(toolId)?.flush();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [toolId]);

  const setFields = useCallback(
    (patch) => {
      useToolSettingsStore.setState((s) => {
        const next = { ...s.saved[toolId], ...patch };
        for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
        return { saved: { ...s.saved, [toolId]: next } };
      });
      const saver = saverFor(toolId);
      saver.dirty = true;
      saver.debounced();
    },
    [toolId],
  );

  const setField = useCallback((key, value) => setFields({ [key]: value }), [setFields]);

  const reset = useCallback(async () => {
    savers.get(toolId)?.cancel();
    try {
      const res = await api(toolId, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
    } catch {
      setStatus(toolId, "error");
      return false;
    }
    useToolSettingsStore.setState((s) => {
      const { [toolId]: _removed, ...rest } = s.saved;
      return { saved: rest, status: { ...s.status, [toolId]: "saved" } };
    });
    return true;
  }, [toolId]);

  const values = useMemo(() => mergeToolSettings(defaults, disk, saved), [defaults, disk, saved]);
  const differs = useMemo(() => diffFromDisk(saved, disk), [saved, disk]);

  const loadFromDisk = useCallback(() => {
    setFields(Object.fromEntries(differs.map((key) => [key, undefined])));
  }, [differs, setFields]);

  return [
    values,
    setField,
    { loaded, status, hasSaved: Boolean(saved), setFields, reset, differs, loadFromDisk },
  ];
}
