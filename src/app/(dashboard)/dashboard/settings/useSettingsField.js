"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

const TEXT_DEBOUNCE_MS = 500;

/**
 * Per-field save state: idle -> saving -> saved | error (rolled back to the
 * last value the server accepted).
 */
export function fieldReducer(state, action) {
  switch (action.type) {
    case "optimistic":
      return { ...state, value: action.value, status: "saving", error: "" };
    case "saved":
      return { value: action.value, savedValue: action.value, status: "saved", error: "" };
    case "failed":
      return { ...state, value: state.savedValue, status: "error", error: action.error };
    case "sync":
      // Never let a server refresh clobber an in-flight optimistic edit.
      // A successful refresh also clears a stale error from an earlier save.
      if (state.status === "saving") return state;
      return { ...state, value: action.value, savedValue: action.value, error: "" };
    case "clear-error":
      return { ...state, status: "idle", error: "" };
    default:
      return state;
  }
}

export function initialFieldState(serverValue) {
  return { value: serverValue, savedValue: serverValue, status: "idle", error: "" };
}

export function debounce(fn, delayMs) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * PATCH one settings key. Throws with the server's validation message.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<object>} Safe settings echoed by the server.
 */
export async function patchSetting(key, value) {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to save setting");
  return data;
}

/**
 * Optimistic settings field: instant UI update, rollback on server error,
 * optional debounce for text inputs, inline server validation errors.
 *
 * @param {string} settingKey Stored settings key (single-key PATCH).
 * @param {*} serverValue Latest value from GET /api/settings.
 * @param {object} [options]
 * @param {boolean} [options.debounced=false] Debounce saves (text inputs).
 * @param {(value: *, meta: { restartRequired: boolean }) => void} [options.onSaved]
 *   Called only after the server accepted the value.
 * @param {boolean} [options.restartRequired=false] Value applies after a restart.
 * @returns {{ value: *, saving: boolean, error: string, set: (value: *) => void,
 *   clearError: () => void }}
 */
export function useSettingsField(settingKey, serverValue, options = {}) {
  const { debounced = false, onSaved, restartRequired = false } = options;
  const [state, dispatch] = useReducer(fieldReducer, serverValue, initialFieldState);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    dispatch({ type: "sync", value: serverValue });
  }, [serverValue]);

  const save = useCallback(
    async (value) => {
      try {
        const data = await patchSetting(settingKey, value);
        const saved = Object.hasOwn(data, settingKey) ? data[settingKey] : value;
        dispatch({ type: "saved", value: saved });
        onSavedRef.current?.(saved, { restartRequired });
      } catch (err) {
        dispatch({ type: "failed", error: err.message });
      }
    },
    [settingKey, restartRequired],
  );

  const debouncedRef = useRef(null);
  useEffect(() => {
    if (!debounced) return undefined;
    debouncedRef.current = debounce(save, TEXT_DEBOUNCE_MS);
    return () => debouncedRef.current?.cancel();
  }, [debounced, save]);

  const set = useCallback(
    (value) => {
      dispatch({ type: "optimistic", value });
      if (debounced) debouncedRef.current?.(value);
      else save(value);
    },
    [debounced, save],
  );

  const clearError = useCallback(() => dispatch({ type: "clear-error" }), []);

  return {
    value: state.value,
    saving: state.status === "saving",
    error: state.error,
    set,
    clearError,
  };
}
