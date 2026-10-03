// Pure, client-safe helpers for providers with a live /models catalog
// (registry `features.liveModels`). Shared by the provider page and the model picker.

// Per-provider id normalizers: live catalogs sometimes namespace ids differently
// from the static registry / routing layer, which expects bare ids.
const LIVE_ID_NORMALIZERS = {
  // Qoder's catalog returns `qoder/<key>`; the registry and routing use `<key>`.
  qoder: (id) => id.replace(/^qoder\//, ""),
};

function modelKind(entry) {
  return entry?.kind || entry?.type || "llm";
}

/**
 * Normalize a live-catalog model id to the id the registry and routing use.
 * Returns null for missing/non-string/blank ids so callers can drop the entry.
 */
export function normalizeLiveModelId(providerId, id) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const normalize = LIVE_ID_NORMALIZERS[providerId];
  const normalized = normalize ? normalize(trimmed) : trimmed;
  return normalized || null;
}

// Normalized, deduped live entries in upstream order; entries without a usable id are dropped.
// Deduped per kind: one id can be listed as several kinds (OpenRouter image+text models).
function normalizeLiveModels(providerId, liveModels) {
  const seen = new Set();
  const result = [];
  for (const model of Array.isArray(liveModels) ? liveModels : []) {
    if (!model || typeof model !== "object") continue;
    const id = normalizeLiveModelId(providerId, model.id);
    const key = `${modelKind(model)}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...model, id });
  }
  return result;
}

/**
 * Build the displayed model list from a live catalog. The live list decides WHICH
 * models exist; for ids the static registry also knows, its curated metadata
 * (name, type, capabilities) wins over whatever the upstream reports. Matching is
 * per kind: one id can be both a chat and an STT entry (Gemini).
 */
export function mergeLiveWithStatic(providerId, liveModels, staticModels) {
  const staticByKey = new Map(
    (Array.isArray(staticModels) ? staticModels : [])
      .filter((model) => model?.id)
      .map((model) => [`${modelKind(model)}:${model.id}`, model]),
  );
  return normalizeLiveModels(providerId, liveModels).map((live) => {
    const curated = staticByKey.get(`${modelKind(live)}:${live.id}`);
    if (curated) return { ...live, ...curated };
    return { ...live, name: live.name || live.id };
  });
}

/**
 * Ids from the live catalog that are not yet available for this provider and should
 * be imported as custom models. A model counts as present when it is in the static
 * registry, already a custom llm model under this provider alias, or targeted by an alias.
 */
export function selectModelsToImport({
  providerId,
  liveModels,
  staticModels = [],
  customModels = [],
  modelAliases = {},
  providerStorageAlias,
}) {
  const staticIds = new Set((staticModels || []).map((model) => model?.id).filter(Boolean));
  const customIds = new Set(
    (customModels || [])
      .filter(
        (entry) => entry?.providerAlias === providerStorageAlias && modelKind(entry) === "llm",
      )
      .map((entry) => entry.id),
  );
  const aliasTargets = new Set(Object.values(modelAliases || {}));

  // Imports are always added as llm custom models, so non-chat live entries are skipped.
  return normalizeLiveModels(providerId, liveModels)
    .filter((model) => modelKind(model) === "llm")
    .map((model) => model.id)
    .filter(
      (id) =>
        !staticIds.has(id) &&
        !customIds.has(id) &&
        !aliasTargets.has(`${providerStorageAlias}/${id}`),
    );
}
