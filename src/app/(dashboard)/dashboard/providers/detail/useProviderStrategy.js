"use client";

import { useCallback, useState } from "react";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { loadSettings, loadOwnedMap, patchSettings } from "@/shared/utils/settingsApi";
import { stickyLimitError } from "../detailUtils";

/**
 * Per-provider account strategy + sticky limit, preserving unrelated
 * providerStrategies keys. Mirrors the current detail page save semantics.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {(message: string) => void} [args.notifyError]
 */
export function useProviderStrategy({ providerId, notifyError }) {
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [globalStrategy, setGlobalStrategy] = useState(null);
  const [stickyDraft, setStickyDraft] = useState("");
  const [savedSticky, setSavedSticky] = useState("");
  const [globalSticky, setGlobalSticky] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const { scope, canManageInstance } = useSettingsScope();

  const load = useCallback(async () => {
    try {
      const data = await loadSettings(scope, { canManageInstance }).catch(() => {
        throw new Error("Failed to load provider strategy.");
      });
      const override = data.providerStrategies?.[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setGlobalStrategy(data.fallbackStrategy || null);
      setGlobalSticky(data.stickyRoundRobinLimit ?? null);
      const stored =
        override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "";
      setStickyDraft(stored);
      setSavedSticky(stored);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load provider strategy.";
      setError(message);
      notifyError?.(message);
    }
  }, [notifyError, providerId, scope, canManageInstance]);

  const save = useCallback(
    async (strategy, stickyLimit) => {
      const persistSticky =
        strategy === "round-robin" || strategy === "weighted" || strategy === null;
      const stickyError = persistSticky ? stickyLimitError(stickyLimit) : "";
      if (stickyError) {
        setError(stickyError);
        return false;
      }
      setSaving(true);
      setError("");
      try {
        const current = await loadOwnedMap("providerStrategies", scope, [providerId]).catch(() => {
          throw new Error("Failed to load current provider strategy.");
        });
        const override = { ...(current[providerId] || {}) };
        if (strategy) override.fallbackStrategy = strategy;
        else delete override.fallbackStrategy;
        if (persistSticky) {
          if (stickyLimit === "") delete override.stickyRoundRobinLimit;
          else override.stickyRoundRobinLimit = Number(stickyLimit);
        } else {
          delete override.stickyRoundRobinLimit;
        }

        const updated = { ...current };
        if (Object.keys(override).length === 0) delete updated[providerId];
        else updated[providerId] = override;
        // No-op saves keep the untouched override keys (rotateStrategy, proxyPoolId).
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await patchSettings({ providerStrategies: updated }, scope).catch((e) => {
            throw new Error(scope ? e.message : "Failed to save provider strategy.");
          });
        }
        setProviderStrategy(strategy);
        setSavedSticky(override.stickyRoundRobinLimit?.toString() ?? "");
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save strategy.";
        setError(message);
        notifyError?.(message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [notifyError, providerId, scope],
  );

  const changeStrategy = useCallback(
    async (value) => {
      const strategy = value === "inherit" ? null : value;
      // Existing round-robin selection rotates each request unless a sticky override is set.
      const nextSticky = strategy === "round-robin" && stickyDraft === "" ? "1" : stickyDraft;
      if (await save(strategy, nextSticky)) {
        setStickyDraft(strategy === "fill-first" ? "" : nextSticky);
      }
    },
    [save, stickyDraft],
  );

  /** Saves a committed stepper value; failures restore the last saved value. */
  const commitSticky = useCallback(
    async (next) => {
      if (
        providerStrategy !== "round-robin" &&
        providerStrategy !== "weighted" &&
        providerStrategy !== null
      )
        return;
      const draft = next === "" || next == null ? "" : String(next);
      setStickyDraft(draft);
      if (!(await save(providerStrategy, draft))) setStickyDraft(savedSticky);
    },
    [providerStrategy, save, savedSticky],
  );

  const clearStickyOverride = useCallback(async () => {
    // Sticky-only clear: keep the current strategy override intact.
    setSaving(true);
    setError("");
    try {
      const current = await loadOwnedMap("providerStrategies", scope, [providerId]).catch(() => {
        throw new Error("Failed to load current provider strategy.");
      });
      const override = { ...(current[providerId] || {}) };
      delete override.stickyRoundRobinLimit;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await patchSettings({ providerStrategies: updated }, scope).catch((e) => {
        throw new Error(scope ? e.message : "Failed to clear sticky override.");
      });
      setStickyDraft("");
      setSavedSticky("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear sticky override.";
      setError(message);
      notifyError?.(message);
    } finally {
      setSaving(false);
    }
  }, [notifyError, providerId, scope]);

  return {
    providerStrategy,
    globalStrategy,
    stickyDraft,
    savedSticky,
    globalSticky,
    error,
    saving,
    load,
    changeStrategy,
    commitSticky,
    clearStickyOverride,
  };
}
