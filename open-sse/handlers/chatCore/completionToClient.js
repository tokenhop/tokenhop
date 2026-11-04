import { FORMATS } from "../../translator/formats.js";
import { claudeStopFromOpenAI } from "../../translator/concerns/finishReason.js";
import { toResponsesUsage } from "../../translator/concerns/usage.js";
import {
  ROLE,
  RESPONSES_ITEM,
  RESPONSES_INCOMPLETE,
  OPENAI_FINISH,
} from "../../translator/schema/index.js";
import { cleanFimOutput, toCompletionId } from "../../translator/concerns/fim.js";
import { parseJSONObject, parsePartialJSONObject } from "../../translator/concerns/json.js";

// Non-streaming bodies pivot through OpenAI `chat.completion`. This module turns that
// pivot back into the client's format. It must not import any chatCore handler:
// sseToJsonHandler.js and nonStreamingHandler.js both import it.

// Claude tool_use.input must be an object. Only a call cut off by a `length`
// finish (stop_reason max_tokens) keeps its finished arguments and drops the
// cut-off value (YAN-1854); any other invalid arguments become `{}`, as before.
// Anthropic's docs say a max_tokens response may end in an incomplete tool_use
// block that the caller detects from stop_reason and retries with a higher
// max_tokens rather than running
// (https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
// "Incomplete tool use blocks"). The Anthropic SDK's MessageStream likewise
// fills `input` from a partial-JSON parse of the streamed arguments; ours also
// drops a number at the cut (see parsePartialJSONObject).
function parseToolArguments(value, finishReason) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (finishReason === OPENAI_FINISH.LENGTH) return parsePartialJSONObject(value);
  return parseJSONObject(value);
}

// OpenAI prompt_tokens includes cached tokens; Claude input_tokens does not.
function claudeUsage(usage = {}) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0;
  const cacheCreate = usage.prompt_tokens_details?.cache_creation_tokens || 0;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  return {
    input_tokens: Math.max(0, prompt - cacheRead - cacheCreate),
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
  };
}

function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning =
    message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments, choice.finish_reason),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  // Claude carries refusal text in stop_details.explanation (YAN-1028).
  const { stopReason, stopDetails } = claudeStopFromOpenAI(choice.finish_reason, message.refusal);

  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: stopReason,
    ...(stopDetails ? { stop_details: stopDetails } : {}),
    stop_sequence: null,
    usage: claudeUsage(responseBody.usage),
  };
}

function extractCustomToolInput(argumentsValue) {
  const argumentsText =
    typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string")
      return parsed.input;
  } catch {
    /* raw freeform input */
  }
  return argumentsText;
}

function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text and refusal → one message item: output_text part, then a
  // refusal part (same order the streaming path emits them). A content_filter
  // or length finish leaves the message incomplete, matching the streaming path.
  const text = typeof message.content === "string" ? message.content : "";
  const content = [];
  if (text.length > 0) content.push({ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] });
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    content.push({ type: RESPONSES_ITEM.REFUSAL, refusal: message.refusal });
  }
  const incompleteReason =
    choice.finish_reason === OPENAI_FINISH.LENGTH
      ? RESPONSES_INCOMPLETE.MAX_OUTPUT_TOKENS
      : choice.finish_reason === OPENAI_FINISH.CONTENT_FILTER
        ? RESPONSES_INCOMPLETE.CONTENT_FILTER
        : null;
  if (content.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      ...(incompleteReason ? { status: "incomplete" } : {}),
      content,
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : {
            arguments:
              typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
          }),
    });
  }

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: incompleteReason ? "incomplete" : "completed",
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    background: false,
    error: null,
    output,
    usage: toResponsesUsage(responseBody.usage),
  };
}

// chat.completion → legacy text_completion; reasoning and tool calls are dropped.
function openAICompletionToTextCompletion(body, fimContext) {
  return {
    id: toCompletionId(body.id),
    object: "text_completion",
    created: body.created || Math.floor(Date.now() / 1000),
    model: body.model,
    choices: (body.choices || []).map((c, i) => ({
      index: c.index ?? i,
      text: cleanFimOutput(c.message?.content ?? "", fimContext ?? {}),
      logprobs: null,
      finish_reason: c.finish_reason ?? "stop",
    })),
    usage: toTextCompletionUsage(body.usage),
  };
}

// Zed's edit-prediction client fails to deserialize a reply without all three counts.
function toTextCompletionUsage(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  return {
    ...usage,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.total_tokens ?? prompt + completion,
  };
}

// Codestral /v1/fim/completions JSON body (chat.completion shape).
function openaiToCodestralNonStreaming(body, state) {
  const prompt = body?.usage?.prompt_tokens ?? 0;
  const completion = body?.usage?.completion_tokens ?? 0;
  return {
    id: toCompletionId(body?.id).replace(/^cmpl-/, "chatcmpl-"),
    object: "chat.completion",
    created: body?.created || Math.floor(Date.now() / 1000),
    model: body?.model || state?.model,
    choices: (body?.choices || []).map((c, i) => ({
      index: c.index ?? i,
      message: {
        role: "assistant",
        content: cleanFimOutput(c.message?.content ?? "", state?.fimContext ?? {}),
      },
      finish_reason: c.finish_reason ?? "stop",
    })),
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: body?.usage?.total_tokens ?? prompt + completion,
    },
  };
}

// llama.cpp /infill JSON body.
function openaiToLlamacppNonStreaming(body, state) {
  const choice = body?.choices?.[0];
  const content = cleanFimOutput(choice?.message?.content ?? "", state?.fimContext ?? {});
  const finishReason = choice?.finish_reason ?? "stop";
  return {
    content,
    stop: true,
    ...(body?.model ? { model: body.model } : {}),
    tokens_predicted: body?.usage?.completion_tokens ?? 0,
    tokens_evaluated: body?.usage?.prompt_tokens ?? 0,
    truncated: finishReason === "length",
    stop_type: finishReason === "length" ? "limit" : "eos",
  };
}

/**
 * Convert an OpenAI `chat.completion` body into the client's format.
 * Claude, Responses and legacy Completions clients get their native body; any
 * other client (OpenAI and friends) gets the body unchanged. `fimContext`
 * ({prefix, suffix}) lets Completions output cleanup trim cursor overlap.
 */
export function openAICompletionToClientFormat(
  responseBody,
  clientFormat,
  customToolNames = null,
  fimContext = null,
) {
  if (clientFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(responseBody);
  if (clientFormat === FORMATS.OPENAI_RESPONSES)
    return openAICompletionToResponses(responseBody, customToolNames);
  if (clientFormat === FORMATS.OPENAI_COMPLETIONS)
    return openAICompletionToTextCompletion(responseBody, fimContext);
  if (clientFormat === FORMATS.CODESTRAL_FIM)
    return openaiToCodestralNonStreaming(responseBody, { fimContext, model: responseBody?.model });
  if (clientFormat === FORMATS.LLAMACPP_INFILL)
    return openaiToLlamacppNonStreaming(responseBody, { fimContext });
  return responseBody;
}
