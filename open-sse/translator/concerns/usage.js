// Build OpenAI usage object. Caller computes prompt/completion/total (provider math).
// Optional details added only when > 0 (matches existing claude/gemini/codex behavior).
export function buildUsage({
  promptTokens,
  completionTokens,
  totalTokens,
  cachedTokens = 0,
  cacheCreationTokens = 0,
  reasoningTokens = 0,
}) {
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
  if (cachedTokens > 0 || cacheCreationTokens > 0) {
    usage.prompt_tokens_details = {};
    if (cachedTokens > 0) usage.prompt_tokens_details.cached_tokens = cachedTokens;
    if (cacheCreationTokens > 0)
      usage.prompt_tokens_details.cache_creation_tokens = cacheCreationTokens;
  }
  if (reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return usage;
}

const n = (v) => {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
};

// Shared Gemini usageMetadata counts (numeric-coerced). completion = candidates +
// thoughts because Gemini excludes thoughts from candidatesTokenCount, and the
// storage convention keeps completion_tokens reasoning-inclusive.
// @returns {{prompt:number, completion:number, total:number, cached:number, reasoning:number}}
export function geminiUsageCounts(raw) {
  const cached = n(raw.cachedContentTokenCount);
  const prompt = n(raw.promptTokenCount);
  const thoughts = n(raw.thoughtsTokenCount);
  const total = n(raw.totalTokenCount);
  let candidates = n(raw.candidatesTokenCount);
  // Fallback: derive candidates from total when upstream omits it
  if (candidates === 0 && total > 0) {
    candidates = total - prompt - thoughts;
    if (candidates < 0) candidates = 0;
  }
  return { prompt, completion: candidates + thoughts, total, cached, reasoning: thoughts };
}

// OpenAI-shaped completion_tokens, made reasoning-inclusive. xAI/Grok reports
// reasoning outside completion_tokens (total = prompt + completion + reasoning);
// fold it in so the storage convention holds. Skipped when total is missing.
export function reasoningInclusiveCompletion(usage) {
  const prompt = n(usage.prompt_tokens);
  const completion = n(usage.completion_tokens);
  const reasoning = n(usage.completion_tokens_details?.reasoning_tokens);
  const excludesReasoning =
    reasoning > 0 &&
    usage.total_tokens != null &&
    n(usage.total_tokens) === prompt + completion + reasoning;
  return excludesReasoning ? completion + reasoning : completion;
}

// Per-provider raw token field-map + math. Returns buildUsage() args (NOT the usage object).
// Keeps each provider's exact semantics: claude/gemini fold cache+reasoning, others don't.
const USAGE_EXTRACTORS = {
  claude(raw) {
    const input = n(raw.input_tokens),
      output = n(raw.output_tokens);
    const cacheRead = n(raw.cache_read_input_tokens),
      cacheCreate = n(raw.cache_creation_input_tokens);
    const prompt = input + cacheRead + cacheCreate;
    return {
      promptTokens: prompt,
      completionTokens: output,
      totalTokens: prompt + output,
      cachedTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
    };
  },
  gemini(raw) {
    const { prompt, completion, total, cached, reasoning } = geminiUsageCounts(raw);
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      cachedTokens: cached,
      reasoningTokens: reasoning,
    };
  },
  kiro(raw) {
    const input = n(raw.inputTokens),
      output = n(raw.outputTokens);
    // ponytail: Amazon Q (Kiro upstream) does not expose cache fields today,
    // but pass through any cache_read/cache_creation/cached_tokens if the
    // event shape grows them later so cost tracking keeps working without
    // a second pass.
    const cached = n(raw.cache_read_input_tokens) || n(raw.cachedTokens) || n(raw.cached_tokens);
    const cacheCreation = n(raw.cache_creation_input_tokens);
    const out = { promptTokens: input, completionTokens: output, totalTokens: input + output };
    if (cached > 0) out.cachedTokens = cached;
    if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation;
    return out;
  },
  ollama(raw) {
    const input = n(raw.prompt_eval_count),
      output = n(raw.eval_count);
    return { promptTokens: input, completionTokens: output, totalTokens: input + output };
  },
  commandcode(raw) {
    const input = n(raw.inputTokens),
      output = n(raw.outputTokens);
    const total = typeof raw.totalTokens === "number" ? raw.totalTokens : input + output;
    return { promptTokens: input, completionTokens: output, totalTokens: total };
  },
};

// Convert provider-native usage object → OpenAI usage. Returns null if no extractor/raw.
export function toOpenAIUsage(raw, kind) {
  const extract = USAGE_EXTRACTORS[kind];
  if (!extract || !raw || typeof raw !== "object") return null;
  return buildUsage(extract(raw));
}

// Chat Completions usage → Responses API usage. Shared by the non-stream pivot
// (handlers/chatCore/completionToClient.js) and the streaming Chat→Responses
// translator (response/openai-responses.js). Detail blocks are omitted when
// zero, matching buildUsage(). Top-level cached_tokens/reasoning_tokens are
// accepted as fallbacks: stream.js merges usage into state.usage in the
// canonical shape, which hoists them out of the nested detail blocks.
export function toResponsesUsage(usage = {}) {
  const input = usage.prompt_tokens || usage.input_tokens || 0;
  const output = usage.completion_tokens || usage.output_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0;
  const reasoningTokens =
    usage.completion_tokens_details?.reasoning_tokens || usage.reasoning_tokens || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens || input + output,
    ...(cachedTokens > 0 ? { input_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(reasoningTokens > 0
      ? { output_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {}),
  };
}
