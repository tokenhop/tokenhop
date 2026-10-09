"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { getModelKind } from "@/shared/constants/models";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { withWorkspace } from "../connectTarget";
import {
  clearOwnedEntry,
  isAutoThinking,
  loadOwnedState,
  loadSettingsValue,
  patchSettings,
} from "@/shared/utils/settingsApi";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { getModelsFetcher } from "./providerDetailMeta";

/**
 * Models state for one provider detail page: aliases, custom models,
 * suggested catalog, disabled ids, thinking mode, per-model tests.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.storageAlias
 * @param {Array<object>} args.staticModels
 * @param {Array<object>} args.catalogModels
 * @param {string} [args.kind="llm"] model kind filter ("llm" keeps LLM behaviour)
 * @param {(message: string) => void} [args.notifyError]
 */
export function useModels({
  providerId,
  storageAlias,
  staticModels,
  catalogModels,
  kind = "llm",
  notifyError,
}) {
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [testResults, setTestResults] = useState({});
  const [testError, setTestError] = useState("");
  const [testingIds, setTestingIds] = useState(() => new Set());
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const { scope } = useSettingsScope();

  // All requests, including follow-up reads, must report HTTP failures.
  const request = useCallback(
    async (url, options, fallback) => {
      const scoped = /^\/api\/models\/(alias|custom|disabled)(\?|$)/.test(url)
        ? withWorkspace(url, scope?.workspaceId)
        : url;
      const res = await fetch(scoped, options);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || fallback);
      }
      return res;
    },
    [scope?.workspaceId],
  );

  const report = useCallback(
    (error, fallback) => {
      notifyError?.(error instanceof Error ? error.message : fallback);
      return false;
    },
    [notifyError],
  );

  // Writes already succeeded at this point: a stale read must not flip the
  // result to failure (that would leave modals open and invite double writes).
  const refreshQuietly = useCallback(
    async (refresh, fallback) => {
      try {
        await refresh();
      } catch (error) {
        report(error, fallback);
      }
    },
    [report],
  );

  const fetchAliases = useCallback(async () => {
    const res = await request("/api/models/alias", undefined, "Failed to fetch aliases");
    const data = await res.json();
    setModelAliases(data.aliases || {});
  }, [request]);

  const fetchCustomModels = useCallback(async () => {
    const res = await request(
      "/api/models/custom",
      { cache: "no-store" },
      "Failed to fetch custom models",
    );
    const data = await res.json();
    setCustomModels(data.models || []);
  }, [request]);

  const fetchDisabledModels = useCallback(async () => {
    const res = await request(
      `/api/models/disabled?providerAlias=${encodeURIComponent(storageAlias)}`,
      { cache: "no-store" },
      "Failed to fetch disabled models",
    );
    const data = await res.json();
    setDisabledModelIds(data.ids || []);
  }, [request, storageAlias]);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchAliases(),
      fetchCustomModels(),
      fetchDisabledModels(),
    ]);
    let success = true;
    for (const result of results) {
      if (result.status === "rejected") success = report(result.reason, "Failed to load models");
    }
    return success;
  }, [fetchAliases, fetchCustomModels, fetchDisabledModels, report]);

  useEffect(() => {
    if (providerId !== "kilocode") return;
    request("/api/providers/kilo/free-models", undefined, "Failed to fetch free models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models?.length) setKiloFreeModels(data.models);
      })
      .catch((error) => report(error, "Failed to fetch free models"));
  }, [providerId, report, request]);

  useEffect(() => {
    if (kind !== "llm") return;
    const fetcher = getModelsFetcher(providerId);
    if (!fetcher) return;
    fetchSuggestedModels(fetcher)
      .then(setSuggestedModels)
      .catch((error) => report(error, "Failed to fetch suggested models"));
  }, [kind, providerId, report]);

  const loadThinking = useCallback(async () => {
    try {
      const providerThinking = await loadSettingsValue(
        "providerThinking",
        scope,
        "Failed to load thinking config",
      );
      setThinkingMode(providerThinking?.[providerId]?.mode || "auto");
      return true;
    } catch (error) {
      return report(error, "Failed to load thinking config");
    }
  }, [providerId, report, scope]);

  const changeThinking = useCallback(
    async (mode) => {
      const previous = thinkingMode;
      setThinkingMode(mode);
      try {
        const { owned, inherited } = await loadOwnedState(
          "providerThinking",
          scope,
          [providerId],
          "Failed to load thinking config",
        );
        // YAN-770: Auto clears the entry, or stores Auto explicitly when the
        // instance sets another mode (deleting would re-inherit it).
        const updated =
          !mode || mode === "auto"
            ? clearOwnedEntry(owned, providerId, inherited, { mode: "auto" }, isAutoThinking)
            : { ...owned, [providerId]: { mode } };
        await patchSettings({ providerThinking: updated }, scope);
        return true;
      } catch (error) {
        setThinkingMode(previous);
        return report(error, "Failed to save thinking config");
      }
    },
    [providerId, report, scope, thinkingMode],
  );

  const testModel = useCallback(
    async (modelId) => {
      if (!modelId) return false;
      let started = false;
      setTestingIds((prev) => {
        if (prev.has(modelId)) return prev;
        started = true;
        return new Set(prev).add(modelId);
      });
      if (!started) return false;
      try {
        const body = { model: `${storageAlias}/${modelId}` };
        if (kind && kind !== "llm") body.kind = kind;
        const res = await request(
          "/api/models/test",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          "Model not reachable",
        );
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Model not reachable");
        setTestResults((prev) => ({ ...prev, [modelId]: "ok" }));
        setTestError("");
        return true;
      } catch (error) {
        setTestResults((prev) => ({ ...prev, [modelId]: "error" }));
        setTestError(error instanceof Error ? error.message : "Network error");
        return report(error, "Network error");
      } finally {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    },
    [kind, report, request, storageAlias],
  );

  const saveAlias = useCallback(
    async (model, alias) => {
      try {
        await request(
          "/api/models/alias",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, alias }),
          },
          "Failed to set alias",
        );
        await refreshQuietly(fetchAliases, "Saved, but aliases could not be reloaded");
        return true;
      } catch (error) {
        return report(error, "Failed to set alias");
      }
    },
    [fetchAliases, refreshQuietly, report, request],
  );

  const setAlias = useCallback(
    (modelId, alias, aliasOverride = null) =>
      saveAlias(`${aliasOverride || storageAlias}/${modelId}`, alias),
    [saveAlias, storageAlias],
  );

  const deleteAlias = useCallback(
    async (alias) => {
      const previous = modelAliases[alias];
      try {
        await request(
          `/api/models/alias?alias=${encodeURIComponent(alias)}`,
          { method: "DELETE" },
          "Failed to delete alias",
        );
        await refreshQuietly(fetchAliases, "Saved, but aliases could not be reloaded");
        useNotificationStore.getState().success(
          "Alias removed",
          previous
            ? {
                action: { label: "Undo", onSelect: () => saveAlias(previous, alias) },
              }
            : undefined,
        );
        return true;
      } catch (error) {
        return report(error, "Failed to delete alias");
      }
    },
    [fetchAliases, modelAliases, refreshQuietly, report, request, saveAlias],
  );

  const addCustomModel = useCallback(
    async (modelId, type = "llm", aliasOverride = storageAlias, caps, name) => {
      try {
        await request(
          "/api/models/custom",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              providerAlias: aliasOverride,
              id: modelId,
              type,
              ...(name ? { name } : {}),
              ...(caps ? { caps } : {}),
            }),
          },
          "Failed to add custom model",
        );
        if (typeof window !== "undefined")
          window.dispatchEvent(new CustomEvent("customModelChanged"));
        await refreshQuietly(fetchCustomModels, "Saved, but models could not be reloaded");
        return true;
      } catch (error) {
        return report(error, "Failed to add custom model");
      }
    },
    [fetchCustomModels, refreshQuietly, report, request, storageAlias],
  );

  const deleteCustomModel = useCallback(
    async (modelId, type = "llm", aliasOverride = storageAlias) => {
      const previous = customModels.find(
        (model) =>
          model.providerAlias === aliasOverride &&
          model.id === modelId &&
          (model.type || model.kind || "llm") === type,
      );
      try {
        const params = new URLSearchParams({ providerAlias: aliasOverride, id: modelId, type });
        await request(
          `/api/models/custom?${params}`,
          { method: "DELETE" },
          "Failed to delete custom model",
        );
        if (typeof window !== "undefined")
          window.dispatchEvent(new CustomEvent("customModelChanged"));
        await refreshQuietly(fetchCustomModels, "Saved, but models could not be reloaded");
        useNotificationStore.getState().success("Model removed", {
          action: {
            label: "Undo",
            onSelect: () =>
              addCustomModel(
                modelId,
                previous?.type || previous?.kind || type,
                aliasOverride,
                previous?.caps,
                previous?.name,
              ),
          },
        });
        return true;
      } catch (error) {
        return report(error, "Failed to delete custom model");
      }
    },
    [
      addCustomModel,
      customModels,
      fetchCustomModels,
      refreshQuietly,
      report,
      request,
      storageAlias,
    ],
  );

  const disableModels = useCallback(
    async (ids) => {
      try {
        await request(
          "/api/models/disabled",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: storageAlias, ids }),
          },
          "Failed to disable models",
        );
        await refreshQuietly(
          fetchDisabledModels,
          "Saved, but disabled models could not be reloaded",
        );
        return true;
      } catch (error) {
        return report(error, "Failed to disable models");
      }
    },
    [fetchDisabledModels, refreshQuietly, report, request, storageAlias],
  );

  const enableModels = useCallback(
    async (modelId) => {
      try {
        const query = `providerAlias=${encodeURIComponent(storageAlias)}`;
        await request(
          `/api/models/disabled?${query}${modelId ? `&id=${encodeURIComponent(modelId)}` : ""}`,
          { method: "DELETE" },
          "Failed to enable models",
        );
        await refreshQuietly(
          fetchDisabledModels,
          "Saved, but disabled models could not be reloaded",
        );
        return true;
      } catch (error) {
        return report(error, "Failed to enable models");
      }
    },
    [fetchDisabledModels, refreshQuietly, report, request, storageAlias],
  );

  const disableModel = useCallback(
    async (modelId) => {
      const disabled = await disableModels([modelId]);
      if (disabled) {
        useNotificationStore.getState().success("Model disabled", {
          action: { label: "Undo", onSelect: () => enableModels(modelId) },
        });
      }
      return disabled;
    },
    [disableModels, enableModels],
  );
  const enableModel = useCallback((modelId) => enableModels(modelId), [enableModels]);
  const enableAll = useCallback(() => enableModels(), [enableModels]);

  const disableAll = useCallback(
    async (ids, requestConfirm) => {
      if (!ids.length) return false;
      requestConfirm({
        title: "Disable all models",
        message: `Disable all ${ids.length} model(s)?`,
        onConfirm: () => disableModels(ids),
      });
      return true;
    },
    [disableModels],
  );

  const allModels = [
    ...catalogModels,
    ...kiloFreeModels.filter((free) => !catalogModels.some((model) => model.id === free.id)),
  ].filter((model) => {
    if (kind && kind !== "llm") {
      // Media kind filter, mirroring the legacy media-detail branching exactly.
      if (model.kinds) return model.kinds.includes(kind);
      return getModelKind(model, "llm") === kind;
    }
    const modelKind = getModelKind(model);
    return !modelKind || modelKind === "llm";
  });
  const disabledSet = new Set(disabledModelIds);
  const enabledModels = allModels.filter((model) => !disabledSet.has(model.id));
  const disabledModels = allModels.filter((model) => disabledSet.has(model.id));
  const customModelRows = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: storageAlias,
    builtInModels: staticModels,
    type: kind || "llm",
  });

  return {
    modelAliases,
    customModels,
    customModelRows,
    suggestedModels,
    kiloFreeModels,
    disabledModelIds,
    enabledModels,
    disabledModels,
    thinkingMode,
    testResults,
    testError,
    testingIds,
    showAddCustomModel,
    setShowAddCustomModel,
    load,
    loadThinking,
    changeThinking,
    testModel,
    setAlias,
    deleteAlias,
    addCustomModel,
    deleteCustomModel,
    disableModel,
    enableModel,
    disableAll,
    enableAll,
  };
}
