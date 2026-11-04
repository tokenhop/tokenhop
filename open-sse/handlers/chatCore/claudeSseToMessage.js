import { parseJSONObject, parsePartialJSONObject } from "../../translator/concerns/json.js";
import { CLAUDE_BLOCK, CLAUDE_STOP, ROLE } from "../../translator/schema/index.js";

// Same-format Claude aggregation (YAN-1842). Pivoting Claude SSE through an
// OpenAI chat.completion drops what OpenAI has no field for: thinking
// signatures, redacted_thinking, server_tool_use / *_tool_result blocks,
// citations, stop_sequence and the upstream stop_details. A Claude client
// behind a Claude upstream gets the message rebuilt from the events instead,
// the way the Anthropic SDK's MessageStream accumulates a final message.
// Tool names stay as the upstream sent them: the caller decloaks once.

// Claude event types that mark the stream as Claude-native. A provider that
// answers in OpenAI chat shape despite a Claude target carries none of them.
const CLAUDE_EVENTS = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "message_delta",
]);

/**
 * Parsed JSON payloads of the `data:` lines of an SSE body. `error` is set when
 * any frame carries an error (a Claude `type:"error"` event or an OpenAI-style
 * `{error}` frame): a terminal error means the stream failed.
 * @param {string} rawSSE
 * @returns {{ events: object[], error: object|null }}
 */
export function readSSEData(rawSSE) {
  const events = [];
  let error = null;
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event?.error) error = event.error;
      else events.push(event);
    } catch {
      /* ignore malformed lines */
    }
  }
  return { events, error };
}

function applyDelta(block, delta) {
  switch (delta?.type) {
    case "text_delta":
      block.text = (block.text || "") + (delta.text || "");
      break;
    case "thinking_delta":
      block.thinking = (block.thinking || "") + (delta.thinking || "");
      break;
    case "signature_delta":
      block.signature = delta.signature;
      break;
    case "citations_delta":
      block.citations = [...(block.citations || []), delta.citation];
      break;
    default:
      break;
  }
}

function newMessage(fallbackModel) {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: ROLE.ASSISTANT,
    model: fallbackModel || "unknown",
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// Fold one Claude event into the aggregation state.
function applyEvent(state, event) {
  switch (event?.type) {
    case "message_start": {
      const start = event.message || {};
      const usage = { ...state.message.usage, ...(start.usage || {}) };
      state.message = { ...state.message, ...start, usage };
      if (!state.message.model) state.message.model = state.fallbackModel || "unknown";
      break;
    }
    case "content_block_start":
      state.blocks[event.index] = { ...event.content_block };
      break;
    case "content_block_delta": {
      if (!state.blocks[event.index]) break;
      if (event.delta?.type === "input_json_delta") {
        const prev = state.jsonBuffers.get(event.index) || "";
        state.jsonBuffers.set(event.index, prev + (event.delta.partial_json || ""));
      } else {
        applyDelta(state.blocks[event.index], event.delta);
      }
      break;
    }
    case "message_delta":
      Object.assign(state.message, event.delta || {});
      // message_delta usage is cumulative: it overrides message_start counts.
      if (event.usage) state.message.usage = { ...state.message.usage, ...event.usage };
      break;
    default:
      break;
  }
}

// Streamed tool input (tool_use, server_tool_use, mcp_tool_use…). Only a
// response cut off by max_tokens keeps the finished arguments of an unfinished
// call (YAN-1854, see parseToolArguments in completionToClient.js); otherwise
// invalid JSON becomes `{}`, as before.
function toolInput(json, stopReason) {
  if (stopReason === CLAUDE_STOP.MAX_TOKENS) return parsePartialJSONObject(json);
  return parseJSONObject(json);
}

/**
 * Aggregate Claude Messages SSE into one Claude `message` body.
 * @param {string} rawSSE
 * @param {string} fallbackModel - used when message_start names no model
 * @returns {object|{error: object}|null} the message; `{error}` for a failed or
 *   truncated stream (no stop_reason); null when the body holds no Claude events.
 */
export function claudeSseToMessage(rawSSE, fallbackModel) {
  const { events, error } = readSSEData(rawSSE);
  if (error) return { error };
  if (!events.some((event) => CLAUDE_EVENTS.has(event?.type))) return null;

  const state = {
    fallbackModel,
    message: newMessage(fallbackModel),
    blocks: [],
    jsonBuffers: new Map(), // block index -> streamed input JSON text
  };
  for (const event of events) applyEvent(state, event);

  const { message, blocks } = state;
  // Every complete Claude stream ends with a stop_reason in message_delta.
  if (!message.stop_reason) {
    return { error: { message: "Upstream Claude stream ended before stop_reason" } };
  }
  for (const [index, json] of state.jsonBuffers) {
    if (json) blocks[index].input = toolInput(json, message.stop_reason);
  }
  const content = blocks.filter(Boolean);
  // An empty message keeps the placeholder the OpenAI pivot produced.
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });
  return { ...message, content };
}
