// Codex auto-generates a "-review" variant for each llm model (review quota family)
export const CODEX_REVIEW_SUFFIX = "-review";

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if ((model.kind || model.type || "llm") !== "llm" || model.id.endsWith(CODEX_REVIEW_SUFFIX)) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review",
      },
    ];
  });
}

// OpenCode Go's live /models list has ids only. For an id the registry doesn't
// know, infer its endpoint by vendor prefix from https://opencode.ai/docs/go/
// (Endpoints): grok-N/gpt-N/muse-spark → /responses only; minimax/qwen also take
// /messages; everything else is /chat/completions only.
export function inferOpencodeGoModel(modelId) {
  const base = String(modelId || "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim();
  if (/^(grok-\d|gpt-\d|muse[-_]?spark)/i.test(base)) {
    return { targetFormat: "openai-responses", supportedFormats: ["openai-responses"] };
  }
  if (/^(minimax|qwen)/i.test(base)) return { supportedFormats: ["openai", "claude"] };
  return { supportedFormats: ["openai"] };
}

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}
