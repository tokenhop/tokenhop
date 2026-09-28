"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LIVE_MODEL_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  AI_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  getProviderAlias,
} from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { mergeLiveWithStatic } from "@/shared/utils/liveModels";
import {
  filterActiveProviders,
  filterCombos,
  filterGroupedModels,
  groupModels,
  liveCatalogRequestKey,
} from "./modelSelectHelpers";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter((id) => FREE_PROVIDERS[id].noAuth);
const ALL_PROVIDERS = {
  ...OAUTH_PROVIDERS,
  ...FREE_PROVIDERS,
  ...FREE_TIER_PROVIDERS,
  ...APIKEY_PROVIDERS,
};
const EMPTY_LIVE_CATALOGS = {};

const readJson = async (path, key, fallback) => {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    const data = await res.json();
    return data[key] || fallback;
  } catch (error) {
    console.error(`Error fetching ${path}:`, error);
    return fallback;
  }
};

async function fetchConnectionModels(connectionId) {
  try {
    const response = await fetch(`/api/providers/${connectionId}/models`, { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.models) ? data.models : [];
  } catch (error) {
    // One unreachable account must not hide the other catalogs (or the static fallback).
    console.warn(`Unable to load live models for connection ${connectionId}:`, error);
    return [];
  }
}

// Live per-account catalogs (via /api/providers/[id]/models) for every connected
// provider flagged `features.liveModels`, as { [providerId]: models }. All providers
// fan out inside ONE effect so the hook count never depends on the provider list.
function useLiveProviderCatalogs(isOpen, activeProviders) {
  const requestKey = useMemo(
    () => liveCatalogRequestKey(activeProviders, LIVE_MODEL_PROVIDERS),
    [activeProviders],
  );
  const key = isOpen ? requestKey : null;
  // Results are tagged with the request key so a stale response is never shown.
  const [catalogs, setCatalogs] = useState({ key: null, byProvider: EMPTY_LIVE_CATALOGS });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    Promise.all(
      JSON.parse(key).map(async ([providerId, connectionIds]) => {
        const lists = await Promise.all(connectionIds.map(fetchConnectionModels));
        return [providerId, lists.flat()];
      }),
    ).then((entries) => {
      if (!cancelled) setCatalogs({ key, byProvider: Object.fromEntries(entries) });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return key && catalogs.key === key ? catalogs.byProvider : EMPTY_LIVE_CATALOGS;
}

// Fetch `data[key]` from `path` each time the picker opens. `fallback` is empty `[]` or `{}`.
function usePickerJson(isOpen, path, key, fallback) {
  const [value, setValue] = useState(fallback);
  const [initial] = useState(fallback);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    readJson(path, key, initial).then((data) => {
      if (alive) setValue(data);
    });
    return () => {
      alive = false;
    };
  }, [isOpen, path, key, initial]);
  return value;
}

/** Picker data: shared JSON lists, live catalogs, grouping, search and capability filters. */
export function useModelSelectData({
  isOpen,
  activeProviders,
  kindFilter,
  capFilter,
  modelAliases,
  searchQuery,
  addedModelValues,
  getCaps,
}) {
  const combos = usePickerJson(isOpen, "/api/combos", "combos", []);
  const providerNodes = usePickerJson(isOpen, "/api/provider-nodes", "nodes", []);
  const customModels = usePickerJson(isOpen, "/api/models/custom", "models", []);
  const disabledModels = usePickerJson(isOpen, "/api/models/disabled", "disabled", {});
  const liveCatalogs = useLiveProviderCatalogs(isOpen, activeProviders);

  const filteredActiveProviders = useMemo(
    () => filterActiveProviders(activeProviders, kindFilter, AI_PROVIDERS),
    [activeProviders, kindFilter],
  );

  // Group models by provider with priority order. Live catalogs expose usable
  // accounts; a provider with nothing live falls back to the static registry.
  const groupedModels = useMemo(
    () =>
      groupModels({
        filteredActiveProviders,
        activeProviders,
        kindFilter,
        modelAliases,
        allProviders: ALL_PROVIDERS,
        providerNodes,
        customModels,
        disabledModels,
        liveCatalogs,
        providerOrder: PROVIDER_ORDER,
        noAuthIds: NO_AUTH_PROVIDER_IDS,
        getModelKind,
        getModelsByProviderId,
        getProviderAlias,
        isOpenAICompatibleProvider,
        isAnthropicCompatibleProvider,
        mergeLiveWithStatic,
      }),
    [
      filteredActiveProviders,
      activeProviders,
      kindFilter,
      modelAliases,
      providerNodes,
      customModels,
      disabledModels,
      liveCatalogs,
    ],
  );

  const filteredCombos = useMemo(
    () => filterCombos(combos, searchQuery, kindFilter, capFilter),
    [combos, searchQuery, kindFilter, capFilter],
  );

  const filteredGroups = useMemo(
    () => filterGroupedModels(groupedModels, { searchQuery, capFilter, getCaps, addedModelValues }),
    [groupedModels, searchQuery, capFilter, getCaps, addedModelValues],
  );

  return { filteredCombos, filteredGroups };
}
