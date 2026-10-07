import { FORMATS } from "../../translator/formats.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { toResponsesUsage } from "../../translator/concerns/usage.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { cleanFimOutput, toCompletionId } from "../../translator/concerns/fim.js";

// Non-streaming bodies pivot through OpenAI `chat.completion`. This module turns that
// pivot back into the client's format. It must not import any chatCore handler:
// sseToJsonHandler.js and nonStreamingHandler.js both import it.

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
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
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
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

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
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

  const truncated = choice.finish_reason === "length";

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: truncated ? "incomplete" : "completed",
    ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
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
  return responseBody;
}
