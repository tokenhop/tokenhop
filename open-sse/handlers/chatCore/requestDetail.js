import { saveRequestUsageUnscoped } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";
import { COMBO_PROBE_ENDPOINT, FIM_USAGE_ENDPOINT } from "../../config/runtimeConfig.js";
import {
  geminiUsageCounts,
  reasoningInclusiveCompletion,
} from "../../translator/concerns/usage.js";
import { clockTime } from "../../utils/clockTime.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../../translator/schema/index.js";

const OPTIONAL_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "thinking",
  "reasoning",
  "enable_thinking",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "tools",
  "tool_choice",
  "response_format",
  "prediction",
  "store",
  "metadata",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "user",
  "parallel_tool_calls",
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens:
        responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.output_tokens_details?.reasoning_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens,
    };
  }

  // OpenAI format. prompt_tokens is cache-inclusive. Cache writes appear as
  // prompt_tokens_details.cache_creation_tokens when a Claude upstream was
  // pivoted to OpenAI (buildUsage) or when an OpenAI-compatible gateway in
  // front of Anthropic reports them natively (e.g. LiteLLM, GitHub Copilot
  // Claude models). cached_tokens must then be a number, even 0, so
  // canonicalizeUsage() takes its pass-through branch instead of folding the
  // cache into the prompt again.
  if (responseBody.usage?.prompt_tokens !== undefined) {
    const usage = responseBody.usage;
    const cacheCreation = usage.prompt_tokens_details?.cache_creation_tokens;
    const hasCacheCreation = cacheCreation != null;
    const cached = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    return {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: reasoningInclusiveCompletion(usage),
      cached_tokens: hasCacheCreation ? (cached ?? 0) : cached,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      ...(hasCacheCreation ? { cache_creation_input_tokens: cacheCreation } : {}),
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    // Gemini excludes thoughts from candidatesTokenCount; store completion reasoning-inclusive
    // (matches toOpenAIUsage in translator/concerns/usage.js).
    const counts = geminiUsageCounts(usageMetadata);
    return {
      prompt_tokens: counts.prompt,
      completion_tokens: counts.completion,
      cached_tokens: counts.cached || 0,
      reasoning_tokens: counts.reasoning || 0,
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    ...base.keyContext,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides,
  };
}

/**
 * Summarize a client-format body for the request-detail log. The pivot is an
 * OpenAI chat.completion, but the logged `translatedResponse` is already the
 * client format (Claude message / Responses body / chat.completion).
 */
export function summarizeClientResponse(body) {
  if (body?.choices?.[0]) {
    const message = body.choices[0].message || {};
    // Legacy completions choices carry `text`, not `message`.
    const text =
      message.content ?? (typeof body.choices[0].text === "string" ? body.choices[0].text : null);
    return {
      content: text || null,
      thinking: message.reasoning_content || null,
      finish_reason: body.choices[0].finish_reason || "unknown",
    };
  }
  // Claude message: content blocks (+ top-level stop_reason).
  if (body?.type === "message" && Array.isArray(body.content)) {
    const text = body.content
      .filter((block) => block?.type === CLAUDE_BLOCK.TEXT && block.text)
      .map((block) => block.text)
      .join("");
    const thinking = body.content
      .filter((block) => block?.type === CLAUDE_BLOCK.THINKING && block.thinking)
      .map((block) => block.thinking)
      .join("");
    return {
      content: text || null,
      thinking: thinking || null,
      finish_reason: body.stop_reason || "unknown",
    };
  }
  // Responses body: message items hold output_text, reasoning items hold summary.
  if (body?.object === "response" && Array.isArray(body.output)) {
    const text = body.output
      .filter((item) => item?.type === RESPONSES_ITEM.MESSAGE && Array.isArray(item.content))
      .flatMap((item) => item.content)
      .filter((part) => part?.type === RESPONSES_ITEM.OUTPUT_TEXT && part.text)
      .map((part) => part.text)
      .join("");
    const thinking = body.output
      .filter((item) => item?.type === RESPONSES_ITEM.REASONING && Array.isArray(item.summary))
      .flatMap((item) => item.summary)
      .filter((part) => part?.type === RESPONSES_ITEM.SUMMARY_TEXT && part.text)
      .map((part) => part.text)
      .join("");
    return {
      content: text || null,
      thinking: thinking || null,
      finish_reason: body.status || "unknown",
    };
  }
  return {
    content: body?.content || null,
    thinking: body?.reasoning_content || null,
    finish_reason: body?.finish_reason || "unknown",
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead =
    u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

export function saveUsageStats({
  provider,
  model,
  tokens,
  connectionId,
  apiKey,
  keyContext,
  endpoint,
  latencyMs,
  userAgent = null,
  savings = null,
  comboName = null,
  label = "USAGE",
  silent = false,
  cancelled = false,
}) {
  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) return;

  // Combo dry-run probes spend real quota but are excluded from usage/cost
  // stats (YAN-299 decision: excluded, audit via request detail rows which
  // keep the probe endpoint tag). Skip the write entirely.
  if (endpoint === COMBO_PROBE_ENDPOINT) return;

  if (!silent) {
    const time = clockTime();
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(
      `${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`,
    );
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
  };

  saveRequestUsageUnscoped({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    ...keyContext,
    endpoint: endpoint || null,
    userAgent: userAgent || undefined,
    savings: savings || undefined,
    comboName: comboName || undefined,
    meta: {
      ...(cancelled && { cancelled: true, partialUsage: true, billedCost: "unknown" }),
      ...(Number.isFinite(latencyMs) ? { latencyMs } : {}),
      ...(endpoint === FIM_USAGE_ENDPOINT && outTokens === 0 ? { empty: true } : {}),
    },
  }).catch(() => {});
}
