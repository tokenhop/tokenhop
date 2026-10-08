"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import {
  comboStrategyKeyFor,
  loadSettings,
  onHttpError,
  settingsEndpoint,
} from "@/shared/utils/settingsApi";
import { getListingHref, validateMediaComboName } from "./mediaComboConfig";

/**
 * Load + mutation state for the media combo detail page.
 * Same 6 endpoints, same payloads as before; edits autosave immediately.
 */
export function useMediaCombo(id) {
  const router = useRouter();
  const [combo, setCombo] = useState(null);
  const [loading, setLoading] = useState(true);
  const { ready, scope, canManageInstance } = useSettingsScope();
  const [loadError, setLoadError] = useState("");
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [providers, setProviders] = useState([]);
  const [roundRobin, setRoundRobin] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const savingModelsRef = useRef(false);
  const savingStrategyRef = useRef(false);
  // Serializes rename + strategy toggle so the toggle PATCH never targets a stale name.
  const opQueueRef = useRef(Promise.resolve());
  const comboNameRef = useRef("");
  const [logs, setLogs] = useState([]);
  const [apiKey, setApiKey] = useState("");
  const [connections, setConnections] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setMissing(false);
    try {
      const [comboRes, s, logsRes, keysRes, connsRes, aliasesRes] = await Promise.all([
        fetch(`/api/combos/${id}`, { cache: "no-store" }),
        loadSettings(scope, { canManageInstance }).catch(onHttpError({})),
        fetch("/api/usage/logs", { cache: "no-store" }),
        fetch("/api/keys", { cache: "no-store" }),
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/models/alias", { cache: "no-store" }),
      ]);
      if (aliasesRes.ok) setModelAliases((await aliasesRes.json()).aliases || {});
      if (keysRes.ok) {
        const k = await keysRes.json();
        setApiKey((k.keys || []).find((x) => x.isActive !== false)?.key || "");
      }
      if (connsRes.ok) setConnections((await connsRes.json()).connections || []);
      if (!comboRes.ok) {
        if (comboRes.status === 404) {
          setCombo(null);
          setMissing(true);
        } else {
          setLoadError(`Could not load combo (HTTP ${comboRes.status})`);
        }
        setLoading(false);
        return;
      }
      const c = await comboRes.json();
      comboNameRef.current = c.name;
      setCombo(c);
      setName(c.name);
      setProviders(c.models || []);
      const strategy = s.comboStrategies?.[comboStrategyKeyFor(scope, c)];
      setRoundRobin(strategy?.fallbackStrategy === "round-robin");
      const allLogs = logsRes.ok ? await logsRes.json() : [];
      setLogs(allLogs.filter((l) => typeof l === "string" && l.includes(c.name)).slice(0, 50));
    } catch (e) {
      setLoadError(e?.message || "Could not load combo");
    }
    setLoading(false);
  }, [id, scope, canManageInstance]);

  useEffect(() => {
    if (ready) fetchAll();
  }, [ready, fetchAll]);

  const validateName = (v) => {
    const result = validateMediaComboName(v);
    setNameError(result.ok ? "" : result.error);
    return result.ok;
  };

  const saveCombo = async (patch) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.error || "Failed to save");
        return false;
      }
      setSaveError("");
      return true;
    } catch {
      setSaveError("Failed to save — network error");
      return false;
    }
  };

  // Chain fn after any in-flight rename/toggle; a failure never blocks later ops.
  const enqueue = (fn) => {
    const run = opQueueRef.current.then(fn);
    opQueueRef.current = run.catch(() => {});
    return run;
  };

  const handleSaveName = () => {
    if (!validateName(name)) return;
    const nextName = name;
    return enqueue(async () => {
      if (nextName === comboNameRef.current) return;
      setSaveStatus("Saving");
      const ok = await saveCombo({ name: nextName });
      if (ok) {
        await fetchAll();
        setSaveStatus("Saved");
      } else {
        setSaveStatus("");
      }
    }).catch(() => setSaveError("Failed to save — network error"));
  };

  const saveComboModels = async (next) => {
    savingModelsRef.current = true;
    setSavingModels(true);
    try {
      return await saveCombo({ models: next });
    } finally {
      savingModelsRef.current = false;
      setSavingModels(false);
    }
  };

  const handleAddModel = async (model) => {
    const value = model?.value || model;
    if (!value || providers.includes(value) || savingModelsRef.current) return;
    const previous = providers;
    const next = [...providers, value];
    setProviders(next);
    const ok = await saveComboModels(next);
    if (!ok) setProviders(previous);
  };

  const handleDeselectModel = async (model) => {
    const value = model?.value || model;
    if (!value || !providers.includes(value) || savingModelsRef.current) return;
    const previous = providers;
    const next = providers.filter((p) => p !== value);
    setProviders(next);
    const ok = await saveComboModels(next);
    if (!ok) setProviders(previous);
  };

  const handleRemoveProvider = async (idx) => {
    if (savingModelsRef.current) return;
    const previous = providers;
    const next = providers.filter((_, i) => i !== idx);
    setProviders(next);
    const ok = await saveComboModels(next);
    if (!ok) setProviders(previous);
  };

  const handleMove = async (idx, dir) => {
    if (savingModelsRef.current) return;
    const next = [...providers];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    const previous = providers;
    setProviders(next);
    const ok = await saveComboModels(next);
    if (!ok) setProviders(previous);
  };

  // Atomic per-combo PATCH: the server merges only this combo's entry, so a failed
  // request can never wipe other combos. Only runs on an explicit user toggle, so a
  // stored "weighted"/"fusion" strategy is never rewritten on load. Switching on keeps
  // existing weights (server merges); switching off sets "fallback", which drops the
  // whole entry (weights included) per the existing prune semantics.
  // Disable while saving; ref closes the gap before React applies disabled state.
  // Queued behind any pending rename and reads the name at send time, so it never
  // PATCHes a stale combo name. 409 = name changed server-side: refetch, don't revert.
  const handleToggleRoundRobin = async (enabled) => {
    if (savingStrategyRef.current || !comboNameRef.current) return;
    savingStrategyRef.current = true;
    const previous = roundRobin;
    setRoundRobin(enabled);
    setSavingStrategy(true);
    let error = "";
    let conflict = false;
    try {
      await enqueue(async () => {
        // YAN-749: the workspace route resolves `name` inside the workspace.
        const res = await fetch(settingsEndpoint("comboStrategies", scope), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comboStrategyPatch: {
              name: comboNameRef.current,
              patch: { fallbackStrategy: enabled ? "round-robin" : "fallback" },
            },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          error = err.error || `Failed to save (${res.status})`;
          conflict = res.status === 409;
          if (conflict) {
            error = "Combo was renamed elsewhere — refreshed, please retry";
            await fetchAll();
          }
        }
      });
    } catch {
      error = "Failed to save — network error";
    } finally {
      savingStrategyRef.current = false;
      setSavingStrategy(false);
    }
    if (!error) {
      // A queued rename's fetchAll may have reset the toggle to pre-save server state.
      setRoundRobin(enabled);
      setSaveError("");
      return;
    }
    if (!conflict) setRoundRobin(previous);
    setSaveError(error);
  };

  const handleDelete = async () => {
    const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
    }
    router.push(getListingHref(combo.kind));
  };

  return {
    combo,
    loading,
    loadError,
    missing,
    reload: fetchAll,
    name,
    setName,
    nameError,
    validateName,
    providers,
    roundRobin,
    savingStrategy,
    savingModels,
    logs,
    apiKey,
    connections,
    modelAliases,
    confirmDelete,
    setConfirmDelete,
    saveError,
    setSaveError,
    saveStatus,
    setSaveStatus,
    handleSaveName,
    handleAddModel,
    handleDeselectModel,
    handleRemoveProvider,
    handleMove,
    handleToggleRoundRobin,
    handleDelete,
  };
}
