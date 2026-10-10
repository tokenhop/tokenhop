import { FORMATS } from "../translator/formats.js";
import { extractReasoningText } from "../translator/concerns/reasoning.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/index.js";
import { buildErrorBody } from "./error.js";
import { SSE_DONE } from "./sseConstants.js";

const sharedEncoder = new TextEncoder();

// Parse SSE data line
export function parseSSELine(line, format = null) {
  if (!line) return null;

  // NDJSON format (Ollama): raw JSON lines without "data:" prefix
  if (format === FORMATS.OLLAMA) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  // Standard SSE format: "data: {...}"
  if (line.charCodeAt(0) !== 100) return null; // 'd' = 100

  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (error) {
    if (data.length > 0 && data.length < 1000) {
      console.log(
        `[WARN] Failed to parse SSE line (${data.length} chars): ${data.substring(0, 100)}...`,
      );
    }
    return null;
  }
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    return (
      (delta.content && delta.content !== "") ||
      // reasoning_content, `reasoning`, or MiniMax-style reasoning_details (YAN-672)
      extractReasoningText(delta) !== "" ||
      (delta.tool_calls && delta.tool_calls.length > 0) ||
      chunk.choices[0].finish_reason ||
      delta.role
    );
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";

    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

// True when a chunk EMITTED TO THE CLIENT carries visible payload: non-empty
// content/reasoning text or a productive tool call (non-empty name or
// arguments). OpenAI role-only deltas, usage-only frames, terminal-only chunks
// ([DONE], finish_reason, Responses lifecycle events) and empty tool-call shells
// are not tokens: TTFT feedback must measure the first thing the user actually
// sees, not the first frame after the 200 headers (YAN-764).
const hasText = (v) => typeof v === "string" && v !== "";

const isProductiveToolCall = (tc) =>
  !!tc && (hasText(tc.function?.name) || hasText(tc.function?.arguments) || hasText(tc.name));

// Responses events whose string `delta` is user-visible text/reasoning/tool input.
const RESPONSES_TOKEN_EVENTS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

export function hasMeaningfulToken(item) {
  if (item && typeof item === "object" && item.event && item.data) item = item.data; // formatSSE envelope
  if (!item || typeof item !== "object") return false;

  // OpenAI chat / legacy completions / FIM
  if (Array.isArray(item.choices)) {
    const choice = item.choices[0];
    if (!choice) return false; // usage-only frame
    const delta = choice.delta || choice.message || null;
    if (hasText(delta?.content) || hasText(choice.text) || hasText(delta?.refusal)) return true;
    if (delta && extractReasoningText(delta) !== "") return true;
    // Audio / image output modalities (YAN-1023)
    if (hasText(delta?.audio?.data) || hasText(delta?.audio?.transcript)) return true;
    if (Array.isArray(delta?.images) && delta.images.length > 0) return true;
    return Array.isArray(delta?.tool_calls) && delta.tool_calls.some(isProductiveToolCall);
  }

  if (typeof item.type === "string") {
    const d = item.delta;
    // Claude. input_json_delta partial_json is tool-arg streaming noise, not a
    // visible token (YAN-764).
    if (item.type === "content_block_delta" && d && typeof d === "object")
      return hasText(d.text) || hasText(d.thinking);
    if (item.type === "content_block_start" && item.content_block) {
      const blk = item.content_block;
      if (blk.type === CLAUDE_BLOCK.TOOL_USE || blk.type === CLAUDE_BLOCK.SERVER_TOOL_USE)
        return hasText(blk.name);
      return hasText(blk.text) || hasText(blk.thinking);
    }
    // Responses
    if (RESPONSES_TOKEN_EVENTS.has(item.type)) return hasText(d);
    // Audio / image-generation deltas (response.audio.delta, …partial_image)
    if (/audio|image/.test(item.type) && /delta|partial/.test(item.type))
      return hasText(d) || hasText(item.partial_image_b64);
    if (item.type === "response.output_item.added" && item.item) {
      const it = item.item;
      return (
        (it.type === RESPONSES_ITEM.FUNCTION_CALL || it.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) &&
        hasText(it.name)
      );
    }
    return false; // message_start / message_delta / ping / terminal / lifecycle
  }

  // Ollama NDJSON
  if (item.message && typeof item.message === "object") {
    const m = item.message;
    return (
      hasText(m.content) ||
      extractReasoningText(m) !== "" ||
      (Array.isArray(m.tool_calls) && m.tool_calls.some(isProductiveToolCall))
    );
  }
  // llama.cpp /infill chunk
  if (hasText(item.content)) return true;

  // Gemini-family
  const parts =
    item.candidates?.[0]?.content?.parts ?? item.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts))
    return parts.some(
      (p) => hasText(p?.text) || hasText(p?.functionCall?.name) || hasText(p?.inlineData?.data),
    );
  return false;
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId =
      parsed.extend_fields?.requestId || parsed.extend_fields?.traceId || Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  let cleaned = payload;

  if ("usage" in cleaned) {
    if (cleaned.usage === null) {
      const { usage, ...payloadWithoutUsage } = cleaned;
      cleaned = payloadWithoutUsage;
    } else if (typeof cleaned.usage === "object" && cleaned.usage.perf_metrics === null) {
      const { perf_metrics, ...usageWithoutPerf } = cleaned.usage;
      cleaned = { ...cleaned, usage: usageWithoutPerf };
    }
  }

  if (
    cleaned.response &&
    typeof cleaned.response === "object" &&
    !Array.isArray(cleaned.response)
  ) {
    const cleanedResponse = cleanUsagePayload(cleaned.response);
    if (cleanedResponse !== cleaned.response) {
      cleaned = { ...cleaned, response: cleanedResponse };
    }
  }

  return cleaned;
}

// Format output as SSE
export function formatSSE(data, sourceFormat) {
  if (data === null || data === undefined) return "data: null\n\n";
  if (data && data.done) return "data: [DONE]\n\n";

  // OpenAI Responses API format
  if (data && data.event && data.data) {
    const cleanedEventData = cleanUsagePayload(data.data);
    return `event: ${data.event}\ndata: ${JSON.stringify(cleanedEventData)}\n\n`;
  }

  data = cleanUsagePayload(data);

  // Claude format
  if (sourceFormat === FORMATS.CLAUDE && data && data.type) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return `data: ${JSON.stringify(data)}\n\n`;
}

// Terminal frames for a stream that aborted after HTTP 200 was already sent, so
// the status code can no longer change. OpenAI-compatible clients (openai-python
// raises APIError on any `data:` payload carrying an `error` key, checked before
// [DONE]) need the error frame first, then [DONE]; Anthropic clients need
// `event: error`. Never fabricate a successful finish_reason instead.
//
// Returns encoded bytes: onAbortTerminal callbacks are enqueued verbatim, same
// as buildAbortedResponsesTerminalBytes.
//
// NOTE: non-SSE client formats (Ollama NDJSON) get an SSE frame here — dead in
// practice because detectFormatByEndpoint never resolves to OLLAMA.
export function buildStreamErrorBytes(statusCode, message, clientFormat) {
  const { error } = buildErrorBody(statusCode, message);

  const sse =
    clientFormat === FORMATS.CLAUDE
      ? formatSSE({ type: "error", error }, FORMATS.CLAUDE)
      : formatSSE({ error }, clientFormat) + SSE_DONE;

  return sharedEncoder.encode(sse);
}
