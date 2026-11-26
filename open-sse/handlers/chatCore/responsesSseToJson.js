import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { openAICompletionToClientFormat } from "./completionToClient.js";
import {
  OPENAI_FINISH,
  ROLE,
  RESPONSES_INCOMPLETE,
  RESPONSES_ITEM,
} from "../../translator/schema/index.js";

// Responses-API branch of handleForcedSSEToJson (YAN-1925): a Responses-format
// upstream (e.g. codex) forced to stream while the client wants JSON. The
// stream is folded into one Responses object, returned as-is to a Responses
// client and converted through the chat.completion pivot for everyone else.

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

const jsonResult = (payload) => ({
  success: true,
  response: new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  }),
});

/**
 * Aggregate a Responses-API SSE upstream body into the client's JSON format.
 * `recordSuccess` is the shared forced-SSE success recorder
 * (forcedSseSuccess.js).
 */
export async function responsesSseToJson({
  providerResponse,
  sourceFormat,
  model,
  onRequestSuccess,
  abortSignal = null,
  readResponse = (read) => read(),
  customToolNames,
  fimContext,
  recordSuccess,
}) {
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

    const { textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
    recordSuccess(
      usage,
      { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
      { prompt_tokens: inTokens, completion_tokens: outTokens },
    );

    // Client is Responses API → return as-is
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) return jsonResult(jsonResponse);

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

    const message = { role: ROLE.ASSISTANT, content: textContent || (hasToolCalls ? null : "") };
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
    return jsonResult(
      openAICompletionToClientFormat(chatResp, sourceFormat, customToolNames, fimContext),
    );
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    console.error("[ChatCore] Responses API SSE→JSON failed:", err);
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      "Failed to convert streaming response to JSON",
    );
  }
}
