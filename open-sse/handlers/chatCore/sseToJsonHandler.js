import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS, isFimFormat } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import {
  buildRequestDetail,
  extractRequestConfig,
  extractUsageFromResponse,
  saveUsageStats,
  formatDoneLine,
  summarizeClientResponse,
} from "./requestDetail.js";
import { claudeSseToMessage, readSSEData } from "./claudeSseToMessage.js";
import { openAICompletionToClientFormat } from "./completionToClient.js";
import { fimContextFor } from "../../translator/concerns/fim.js";
import { initState, translateResponse } from "../../translator/index.js";
import {
  OPENAI_FINISH,
  RESPONSES_INCOMPLETE,
  RESPONSES_ITEM,
} from "../../translator/schema/index.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetailUnscoped } from "@/lib/usageDb.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

// Refusal content parts across all message items → chat message.refusal text.
function refusalFromResponsesOutput(output) {
  if (!Array.isArray(output)) return "";
  return output
    .filter((item) => item?.type === RESPONSES_ITEM.MESSAGE && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === RESPONSES_ITEM.REFUSAL && typeof part.refusal === "string")
    .map((part) => part.refusal)
    .join("");
}

// Responses terminal status → chat finish_reason. "incomplete" is not a chat
// finish_reason: map its reason (content_filter / max_output_tokens). It wins
// over tool calls, as in the streaming computeFinishReason: a cut-off
// function call may carry partial arguments. Then tool calls; other statuses
// keep their previous mapping.
function chatFinishFromResponses(jsonResponse, hasToolCalls) {
  const status = jsonResponse.status;
  if (status === "incomplete") {
    return jsonResponse.incomplete_details?.reason === RESPONSES_INCOMPLETE.CONTENT_FILTER
      ? OPENAI_FINISH.CONTENT_FILTER
      : OPENAI_FINISH.LENGTH;
  }
  if (hasToolCalls) return OPENAI_FINISH.TOOL_CALLS;
  if (status === "completed" || status === "done") return OPENAI_FINISH.STOP;
  return status || OPENAI_FINISH.STOP;
}

// Upstream formats whose response translator only reads its own event shape
// and drops OpenAI chat chunks. Some providers answer in OpenAI chat shape
// despite such a target format (see translateNonStreamingResponse's `choices`
// guard), so those chunks bypass the translator. Others (Kiro restores tool
// names, FIM/Ollama normalize) understand `choices` and always translate.
const CHOICE_BLIND_FORMATS = new Set([
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.OPENAI_RESPONSES,
]);

// An OpenAI chat chunk: has `choices`, or is a usage-only frame without any of
// the Claude/Responses (`type`) or Gemini (`candidates`/`response`) markers.
const isOpenAIChatChunk = (chunk) =>
  Array.isArray(chunk?.choices) ||
  (!!chunk?.usage && !chunk.type && !chunk.candidates && !chunk.response);

// Raw upstream events in a non-OpenAI format (Claude message_start /
// content_block_delta, Gemini candidates, Responses events…) carry no `choices`.
// Run them through the registered format → OpenAI response translator, the
// same one the streaming path uses, so the aggregator only sees chat chunks.
// The requested model seeds the state so an upstream that never names its
// model still reports one.
function toOpenAIChunks(chunks, format, toolNameMap, model) {
  if (!format || format === FORMATS.OPENAI) return chunks;
  const passOpenAI = CHOICE_BLIND_FORMATS.has(format);
  const state = { ...initState(FORMATS.OPENAI), toolNameMap, model };
  const out = [];
  for (const chunk of [...chunks, null]) {
    if (passOpenAI && isOpenAIChatChunk(chunk)) {
      out.push(chunk);
      continue;
    }
    for (const item of translateResponse(format, FORMATS.OPENAI, chunk, state) || []) {
      if (item && typeof item === "object") out.push(item);
    }
  }
  return out;
}

/**
 * Parse upstream SSE text into a single OpenAI chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 * `format` is the upstream (provider response) format; anything other than
 * OpenAI chat is translated to chat chunks first. The result is always an
 * OpenAI chat.completion body.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel, { format, toolNameMap } = {}) {
  const { events: rawChunks, error: streamError } = readSSEData(rawSSE);

  if (streamError) return { error: streamError };
  const chunks = toOpenAIChunks(rawChunks, format, toolNameMap, fallbackModel);
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const refusalParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0)
      contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0)
      reasoningParts.push(delta.reasoning_content);
    if (typeof delta.refusal === "string" && delta.refusal.length > 0)
      refusalParts.push(delta.refusal);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, {
            id: tc.id || "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = {
    role: "assistant",
    content: contentParts.join("") || (toolCallMap.size > 0 ? null : ""),
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (refusalParts.length > 0) message.refusal = refusalParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Aggregate an upstream SSE body for a non-streaming client.
 * A Claude client behind a Claude upstream gets a native Claude message
 * (YAN-1842: the OpenAI pivot drops thinking signatures and server-tool
 * blocks); everything else gets the OpenAI chat.completion pivot. Tool names
 * of the native message are still cloaked: the caller decloaks them once.
 * @returns {{ body: object, format: string }|{ error: object }|null}
 */
export function aggregateSSEBody(rawSSE, { sourceFormat, targetFormat, model, toolNameMap }) {
  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE) {
    const message = claudeSseToMessage(rawSSE, model);
    if (message?.error) return { error: message.error };
    if (message) return { body: message, format: FORMATS.CLAUDE };
  }
  const parsed = parseSSEToOpenAIResponse(rawSSE, model, { format: targetFormat, toolNameMap });
  if (!parsed) return null;
  if (parsed.error) return { error: parsed.error };
  return { body: parsed, format: FORMATS.OPENAI };
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({
  providerResponse,
  sourceFormat,
  targetFormat,
  provider,
  model,
  body,
  stream,
  translatedBody,
  finalBody,
  requestStartTime,
  connectionId,
  apiKey,
  keyContext,
  clientRawRequest,
  usageEndpoint = clientRawRequest?.endpoint,
  onRequestSuccess,
  abortSignal = null,
  readResponse = (read) => read(),
  customToolNames,
  toolNameMap = null,
  trackDone,
  appendLog,
  savings,
  comboName,
  reqTag,
  log,
}) {
  const fimContext = isFimFormat(sourceFormat) ? fimContextFor(body, sourceFormat) : null;
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE =
    contentType.includes("text/event-stream") ||
    (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    provider,
    model,
    connectionId,
    keyContext,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
  };

  // Codex/Responses API SSE path
  // Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
  // not the client format: a Responses-API client behind a chat-native forced-streaming
  // provider still receives chat SSE chunks, which must go through the standard path.
  const isCodexResponsesApi =
    isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await readResponse(() =>
        convertResponsesStreamToJson(providerResponse.body),
      );
      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      // Responses input_tokens includes nested cached_tokens; Claude-shaped cache fields do not.
      const foldedCache = usage.cache_read_input_tokens || usage.cached_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const inTokens = (usage.input_tokens || 0) + foldedCache + cacheCreate;
      const cacheRead = foldedCache || usage.input_tokens_details?.cached_tokens || 0;
      const outTokens = usage.output_tokens || 0;
      const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
      appendLog({ tokens: usage, status: "200 OK" });
      saveUsageStats({
        provider,
        model,
        tokens: usage,
        connectionId,
        apiKey,
        keyContext,
        endpoint: usageEndpoint,
        latencyMs: Date.now() - requestStartTime,
        userAgent: clientRawRequest?.headers?.["user-agent"],
        savings,
        comboName,
        silent: true,
      });
      if (log?.line)
        log.line(
          reqTag,
          "📊",
          formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }),
        );

      const { textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const totalLatency = Date.now() - requestStartTime;

      saveRequestDetailUnscoped(
        buildRequestDetail(
          {
            ...ctx,
            latency: { ttft: totalLatency, total: totalLatency },
            tokens: { prompt_tokens: inTokens, completion_tokens: outTokens },
            response: {
              content: textContent,
              thinking: null,
              finish_reason: jsonResponse.status || "unknown",
            },
            status: "success",
          },
          { endpoint: clientRawRequest?.endpoint || null },
        ),
      ).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return {
          success: true,
          response: new Response(JSON.stringify(jsonResponse), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }),
        };
      }

      // Build client-format response. Keep cache counts visible in
      // prompt_tokens_details so a client can tell a cache hit from a small prompt.
      const cacheDetails =
        cacheRead > 0 || cacheCreate > 0
          ? {
              prompt_tokens_details: {
                ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
                ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}),
              },
            }
          : {};

      // Extract tool calls from Responses API output (function_call items).
      // No Gemini-family client branch: chatCore only calls this handler when
      // !clientRequestedStreaming, which is always false for Gemini /
      // Gemini-CLI / Antigravity sources (YAN-1853).
      const funcCallItems = (jsonResponse.output || []).filter(
        (item) => item.type === "function_call",
      );
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
        },
      }));
      const hasToolCalls = toolCalls.length > 0;

      const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
      if (hasToolCalls) message.tool_calls = toolCalls;
      const refusal = refusalFromResponsesOutput(jsonResponse.output);
      if (refusal) message.refusal = refusal;
      const finishReason = chatFinishFromResponses(jsonResponse, hasToolCalls);
      const chatResp = {
        id: jsonResponse.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
        model: jsonResponse.model || model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: {
          prompt_tokens: inTokens,
          completion_tokens: outTokens,
          total_tokens: inTokens + outTokens,
          ...(reasoningTokens > 0
            ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
            : {}),
          ...cacheDetails,
        },
      };
      // Convert the chat.completion pivot to the client's format (Claude /
      // Responses). Shared converter in completionToClient.js, imported
      // without a circular import.
      const finalResp = openAICompletionToClientFormat(
        chatResp,
        sourceFormat,
        customToolNames,
        fimContext,
      );

      return {
        success: true,
        response: new Response(JSON.stringify(finalResp), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        "Failed to convert streaming response to JSON",
      );
    }
  }

  // Standard Chat Completions SSE path (and native Claude for Claude → Claude).
  // Logs, usage stats and the request detail for a successful aggregation.
  const recordSuccess = (usage, response) => {
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({
      provider,
      model,
      tokens: usage,
      connectionId,
      apiKey,
      keyContext,
      endpoint: usageEndpoint,
      latencyMs: Date.now() - requestStartTime,
      userAgent: clientRawRequest?.headers?.["user-agent"],
      savings,
      comboName,
      silent: true,
    });
    const totalLatency = Date.now() - requestStartTime;
    if (log?.line)
      log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: totalLatency } }));
    saveRequestDetailUnscoped(
      buildRequestDetail(
        {
          ...ctx,
          latency: { ttft: totalLatency, total: totalLatency },
          tokens: usage,
          response,
          status: "success",
        },
        { endpoint: clientRawRequest?.endpoint || null },
      ),
    ).catch(() => {});
  };

  try {
    const sseText = await readResponse(() => providerResponse.text());
    const aggregated = aggregateSSEBody(sseText, {
      sourceFormat,
      targetFormat,
      model,
      toolNameMap,
    });
    if (!aggregated)
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        "Invalid SSE response for non-streaming request",
      );
    if (aggregated.error) {
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        aggregated.error.message || "Upstream SSE stream failed",
      );
    }

    if (onRequestSuccess) await onRequestSuccess();

    // A native Claude message (Claude client + Claude upstream) is already the
    // client body. Its usage excludes cache from input_tokens: record the
    // canonical (cache-inclusive) counts, as the OpenAI pivot path does.
    if (aggregated.format === FORMATS.CLAUDE) {
      const message = decloakToolNames(aggregated.body, toolNameMap);
      const usage = canonicalizeUsage(extractUsageFromResponse(message));
      recordSuccess(usage, summarizeClientResponse(message));
      return {
        success: true,
        response: new Response(JSON.stringify(message), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
    }

    const parsed = aggregated.body;
    const usage = parsed.usage || {};
    recordSuccess(usage, summarizeClientResponse(parsed));

    // Re-attach usage explicitly. This handler already HAS the correct usage — it is
    // the same object written to the usage DB, and for a cached Claude request that DB
    // row reads cache_read_input_tokens: 11022 — yet the client was observed receiving
    // no usage field at all (verified 2026-08-04 with a fingerprinted payload matched
    // on both sides). Whatever drops it between assembly and serialisation, the client
    // must not be left unable to account for its own token spend: a caller cannot tell
    // a 90%-cached request from a cheap one without this.
    if (usage && Object.keys(usage).length > 0) parsed.usage = usage;

    // parseSSEToOpenAIResponse yields a Chat Completions body regardless of
    // what the client speaks. Convert it to the client's format (Responses /
    // Claude) so a Responses client does not lose tool_calls and a Claude
    // client does not receive a raw chat.completion. The converters live in
    // completionToClient.js, shared with nonStreamingHandler.js without a
    // circular import.
    const finalBody = openAICompletionToClientFormat(
      parsed,
      sourceFormat,
      customToolNames,
      fimContext,
    );

    // Strip reasoning_content only for Chat Completions clients when content is non-empty.
    // Claude and Responses clients carry reasoning as a thinking block / reasoning item.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    if (finalBody === parsed && parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    return {
      success: true,
      response: new Response(JSON.stringify(finalBody), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }),
    };
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      "Failed to convert streaming response to JSON",
    );
  }
}
