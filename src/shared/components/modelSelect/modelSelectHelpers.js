/**
 * Pure model-picker grouping, search, and sort. No DOM, no fetch.
 * Behavior matches the pre-split ModelSelectModal useMemos.
 */

const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

/** @param {Array<{provider: string}>} activeProviders */
export function filterActiveProviders(activeProviders, kindFilter, aiProviders) {
  if (!kindFilter) return activeProviders;
  return activeProviders.filter((provider) => {
    const kinds = aiProviders[provider.provider]?.serviceKinds || ["llm"];
    return kinds.includes(kindFilter);
  });
}

/** @param {string[]} noAuthIds */
export function kindFilteredNoAuthIds(noAuthIds, kindFilter, aiProviders) {
  if (!kindFilter) return noAuthIds;
  return noAuthIds.filter((id) => (aiProviders[id]?.serviceKinds || ["llm"]).includes(kindFilter));
}

/** Unknown ids sort after the configured order. */
export function sortProviderIds(ids, providerOrder) {
  return [...ids].sort((a, b) => {
    const indexA = providerOrder.indexOf(a);
    const indexB = providerOrder.indexOf(b);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });
}

/** LLM picker keeps custom/untyped rows. Typed pickers keep that kind plus placeholders. */
export function filterModelsByKind(models, kindFilter, getModelKind) {
  if (!kindFilter) {
    return models.filter(
      (model) =>
        model.isPlaceholder ||
        model.isCustom ||
        !getModelKind(model) ||
        getModelKind(model) === "llm",
    );
  }
  if (!TYPED_KINDS.has(kindFilter)) return models;
  return models.filter((model) => model.isPlaceholder || getModelKind(model) === kindFilter);
}

/** Combos are LLM-only. Hidden when a kind or capability filter is set. */
export function filterCombos(combos, searchQuery, kindFilter, capFilter) {
  if (kindFilter || capFilter) return [];
  if (!searchQuery.trim()) return combos;
  const query = searchQuery.toLowerCase();
  return combos.filter((combo) => combo.name.toLowerCase().includes(query));
}

/** Added values first, then the rest. Each side is alphabetical by name. */
export function sortModels(models, addedModelValues) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const added = models.filter((model) => addedModelValues.includes(model.value)).sort(byName);
  const rest = models.filter((model) => !addedModelValues.includes(model.value)).sort(byName);
  return [...added, ...rest];
}

/**
 * Capability filter, then search on model name/id.
 * A provider-name match keeps the group even when every model was filtered out.
 */
export function filterGroupedModels(
  groupedModels,
  { searchQuery, capFilter, getCaps, addedModelValues },
) {
  const query = searchQuery.trim().toLowerCase();
  const filtered = {};
  for (const [providerId, group] of Object.entries(groupedModels)) {
    let models = group.models;
    if (capFilter) {
      models = models.filter((model) => getCaps(model.value)?.[capFilter] === true);
      if (models.length === 0) continue;
    }
    if (query) {
      const providerNameMatches = group.name.toLowerCase().includes(query);
      models = models.filter(
        (model) =>
          model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query),
      );
      if (models.length === 0 && !providerNameMatches) continue;
    }
    filtered[providerId] = { ...group, models: sortModels(models, addedModelValues) };
  }
  return filtered;
}

/** `value`, else `name`, else the value itself. */
export function modelChoiceValue(model) {
  return model?.value || model?.name || model;
}

/** JSON key of `{provider: connectionIds}` for live-catalog providers, or null. */
export function liveCatalogRequestKey(activeProviders, liveModelProviders) {
  const byProvider = {};
  for (const provider of activeProviders) {
    if (!provider?.id || !liveModelProviders.includes(provider.provider)) continue;
    if (!byProvider[provider.provider]) byProvider[provider.provider] = [];
    byProvider[provider.provider].push(provider.id);
  }
  const entries = Object.entries(byProvider);
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

function aliasModelsFor(modelAliases, prefix) {
  return Object.entries(modelAliases)
    .filter(([, fullModel]) => fullModel.startsWith(`${prefix}/`))
    .map(([aliasName, fullModel]) => ({
      id: fullModel.replace(`${prefix}/`, ""),
      name: aliasName,
      value: fullModel,
    }));
}

function registeredFor(customModels, providerAlias, nodePrefix, getModelKind) {
  return customModels
    .filter((model) => model.providerAlias === providerAlias)
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      value: `${nodePrefix}/${model.id}`,
      kind: getModelKind(model),
      isCustom: true,
    }));
}

function hardcodedRows(providerId, kindPredicate, alias, getModelsByProviderId, getModelKind) {
  return getModelsByProviderId(providerId)
    .filter(kindPredicate)
    .map((model) => ({
      id: model.id,
      name: model.name,
      value: `${alias}/${model.id}`,
      kind: getModelKind(model),
    }));
}

/**
 * Group picker rows by connected provider. Same branches as the old modal:
 * provider-as-model kinds, passthrough, compatible nodes, static/live merge.
 */
export function groupModels({
  filteredActiveProviders,
  activeProviders,
  kindFilter,
  modelAliases,
  allProviders,
  providerNodes,
  customModels,
  disabledModels,
  liveCatalogs,
  providerOrder,
  noAuthIds,
  getModelKind,
  getModelsByProviderId,
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  mergeLiveWithStatic,
}) {
  const groups = {};
  const providerIds = sortProviderIds(
    [
      ...new Set([
        ...filteredActiveProviders.map((provider) => provider.provider),
        ...kindFilteredNoAuthIds(noAuthIds, kindFilter, allProviders),
      ]),
    ],
    providerOrder,
  );

  for (const providerId of providerIds) {
    const alias = getProviderAlias(providerId);
    const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
    const isCustomProvider =
      isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

    if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
      groups[providerId] = {
        name: providerInfo.name,
        alias,
        color: providerInfo.color,
        models: [{ id: providerId, name: providerInfo.name, value: providerId }],
      };
      continue;
    }

    if (providerInfo.passthroughModels) {
      const combined = passthroughModels({
        providerId,
        alias,
        providerInfo,
        kindFilter,
        modelAliases,
        customModels,
        getModelKind,
        getModelsByProviderId,
      });
      if (combined.length > 0) {
        const matchedNode = providerNodes.find((node) => node.id === providerId);
        groups[providerId] = {
          name: matchedNode?.name || providerInfo.name,
          alias,
          color: providerInfo.color,
          models: combined,
        };
      }
      continue;
    }

    if (isCustomProvider) {
      if (kindFilter && TYPED_KINDS.has(kindFilter)) continue;
      const connection = activeProviders.find((provider) => provider.provider === providerId);
      const matchedNode = providerNodes.find((node) => node.id === providerId);
      const nodePrefix =
        connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;
      const nodeModels = Object.entries(modelAliases)
        .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
        .map(([aliasName, fullModel]) => ({
          id: fullModel.replace(`${providerId}/`, ""),
          name: aliasName,
          value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
        }));
      const seen = new Set(nodeModels.map((model) => model.value));
      const registeredCustom = customModels
        .filter((model) => model.providerAlias === providerId)
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          value: `${nodePrefix}/${model.id}`,
          isCustom: true,
        }))
        .filter((model) => !seen.has(model.value));
      const mergedModels = [...nodeModels, ...registeredCustom];
      groups[providerId] = {
        name: matchedNode?.name || connection?.name || providerInfo.name,
        alias: nodePrefix,
        color: providerInfo.color,
        models:
          mergedModels.length > 0
            ? mergedModels
            : [
                {
                  id: `__placeholder__${providerId}`,
                  name: `${nodePrefix}/model-id`,
                  value: `${nodePrefix}/model-id`,
                  isPlaceholder: true,
                },
              ],
        isCustom: true,
        hasModels: mergedModels.length > 0,
      };
      continue;
    }

    const staticProviderModels = getModelsByProviderId(providerId);
    const liveProviderModels = mergeLiveWithStatic(
      providerId,
      liveCatalogs[providerId],
      staticProviderModels,
    );
    const hardcodedModels =
      liveProviderModels.length > 0 ? liveProviderModels : staticProviderModels;
    const hardcodedIds = new Set(hardcodedModels.map((model) => model.id));
    const hasHardcoded = hardcodedModels.length > 0;
    const customAliasModels = Object.entries(modelAliases)
      .filter(([aliasName, fullModel]) => {
        const modelId = fullModel.replace(`${alias}/`, "");
        return (
          fullModel.startsWith(`${alias}/`) &&
          (hasHardcoded ? aliasName === modelId : true) &&
          !hardcodedIds.has(modelId)
        );
      })
      .map(([aliasName, fullModel]) => ({
        id: fullModel.replace(`${alias}/`, ""),
        name: aliasName,
        value: fullModel,
        isCustom: true,
      }));
    const customAliasIds = new Set(customAliasModels.map((model) => model.id));
    const customRegisteredModels = customModels
      .filter(
        (model) =>
          model.providerAlias === alias &&
          !hardcodedIds.has(model.id) &&
          !customAliasIds.has(model.id),
      )
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        value: `${alias}/${model.id}`,
        isCustom: true,
      }));
    const seen = new Set();
    let allModels = filterModelsByKind(
      [
        ...hardcodedModels.map((model) => ({
          id: model.id,
          name: model.name,
          value: `${alias}/${model.id}`,
          kind: getModelKind(model),
        })),
        ...customAliasModels,
        ...customRegisteredModels,
      ].filter((model) => {
        if (seen.has(model.value)) return false;
        seen.add(model.value);
        return true;
      }),
      kindFilter,
      getModelKind,
    );
    if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
      const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
      if (supports) allModels = [{ id: providerId, name: providerInfo.name, value: alias }];
    }
    if (allModels.length > 0) {
      groups[providerId] = {
        name: providerInfo.name,
        alias,
        color: providerInfo.color,
        models: allModels,
      };
    }
  }

  for (const [providerId, group] of Object.entries(groups)) {
    const aliasKey = getProviderAlias(providerId);
    const disabledIds = new Set([
      ...(disabledModels[aliasKey] || []),
      ...(disabledModels[providerId] || []),
    ]);
    if (disabledIds.size === 0) continue;
    group.models = group.models.filter((model) => !disabledIds.has(model.id));
    if (group.models.length === 0) delete groups[providerId];
  }
  return groups;
}

function passthroughModels({
  providerId,
  alias,
  providerInfo,
  kindFilter,
  modelAliases,
  customModels,
  getModelKind,
  getModelsByProviderId,
}) {
  const aliasModels = aliasModelsFor(modelAliases, alias);
  const customRegisteredModels = registeredFor(customModels, alias, alias, getModelKind);
  if (kindFilter && TYPED_KINDS.has(kindFilter)) {
    const registeredTyped = customRegisteredModels.filter(
      (model) => getModelKind(model) === kindFilter,
    );
    const combined = [
      ...registeredTyped,
      ...hardcodedRows(
        providerId,
        (model) => getModelKind(model) === kindFilter,
        alias,
        getModelsByProviderId,
        getModelKind,
      ).filter((model) => !registeredTyped.some((registered) => registered.value === model.value)),
    ];
    if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
      const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
      if (supports) return [{ id: providerId, name: providerInfo.name, value: alias }];
    }
    return combined;
  }
  const registeredLlms = customRegisteredModels.filter(
    (model) => !getModelKind(model) || getModelKind(model) === "llm",
  );
  const seen = new Set([...aliasModels, ...registeredLlms].map((model) => model.value));
  const hardcoded = hardcodedRows(
    providerId,
    (model) => !getModelKind(model) || getModelKind(model) === "llm",
    alias,
    getModelsByProviderId,
    getModelKind,
  ).filter((model) => !seen.has(model.value));
  return [
    ...registeredLlms,
    ...aliasModels.filter(
      (model) => !registeredLlms.some((registered) => registered.value === model.value),
    ),
    ...hardcoded,
  ];
}
