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

// Stop reasons that cut the response off mid-output.
const CUT_OFF_STOPS = new Set([CLAUDE_STOP.MAX_TOKENS, CLAUDE_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED]);

// Block type a content delta implies when no content_block_start opened it.
const DELTA_BLOCK = {
  text_delta: CLAUDE_BLOCK.TEXT,
  thinking_delta: CLAUDE_BLOCK.THINKING,
};

function pushPayload(payload, out) {
  if (!payload || payload === "[DONE]") return true;
  try {
    const event = JSON.parse(payload);
    if (event?.error) out.error = event.error;
    else out.events.push(event);
    return true;
  } catch {
    return false;
  }
}

// One SSE event's data: its `data:` lines joined with "\n" (SSE spec). Some
// upstreams put one JSON frame per `data:` line with no blank line between
// events; when the joined text is not JSON, each line is parsed on its own.
function parseEventData(lines, out) {
  if (lines.length === 0) return;
  if (pushPayload(lines.join("\n").trim(), out)) return;
  if (lines.length === 1) {
    out.malformed++;
    return;
  }
  for (const line of lines) {
    if (!pushPayload(line, out)) out.malformed++;
  }
}

/**
 * Parsed JSON payloads of the SSE events in a body. Consecutive `data:` lines
 * of one event are joined and parsed at the blank line that ends it (or at
 * EOF). `error` is set when any frame carries an error (a Claude
 * `type:"error"` event or an OpenAI-style `{error}` frame): a terminal error
 * means the stream failed. `malformed` counts frames that are not JSON.
 * @param {string} rawSSE
 * @returns {{ events: object[], error: object|null, malformed: number }}
 */
export function readSSEData(rawSSE) {
  const out = { events: [], error: null, malformed: 0 };
  let lines = [];
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      parseEventData(lines, out);
      lines = [];
    } else if (trimmed.startsWith("data:")) {
      lines.push(trimmed.slice(5).trim());
    }
  }
  parseEventData(lines, out);
  return out;
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

// Merge usage counts, skipping null/undefined so a later event never erases a
// count an earlier one reported.
function mergeUsage(base, next) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next || {})) {
    if (value != null) merged[key] = value;
  }
  return merged;
}

// Block index an event names; index 0 when it names none.
function blockIndex(event) {
  return Number.isInteger(event.index) ? event.index : 0;
}

// Block at `index`; a text or thinking delta without content_block_start gets
// an empty block of its kind, any other delta gets none.
function blockFor(state, event) {
  const index = blockIndex(event);
  if (!state.blocks[index]) {
    const type = DELTA_BLOCK[event.delta?.type];
    if (!type) return { index, block: null };
    state.blocks[index] = type === CLAUDE_BLOCK.TEXT ? { type, text: "" } : { type, thinking: "" };
  }
  return { index, block: state.blocks[index] };
}

// Fold one Claude event into the aggregation state.
function applyEvent(state, event) {
  switch (event?.type) {
    case "message_start": {
      const start = event.message || {};
      const usage = mergeUsage(state.message.usage, start.usage);
      state.message = { ...state.message, ...start, usage };
      if (!state.message.model) state.message.model = state.fallbackModel || "unknown";
      break;
    }
    case "content_block_start":
      state.blocks[blockIndex(event)] = { ...event.content_block };
      break;
    case "content_block_delta": {
      const { index, block } = blockFor(state, event);
      if (!block) {
        // Tool input needs the block content_block_start opened (its id and
        // name): without one the call cannot be rebuilt (YAN-1926).
        if (event.delta?.type === "input_json_delta") state.orphanInput = true;
        break;
      }
      if (event.delta?.type === "input_json_delta") {
        const prev = state.jsonBuffers.get(index) || "";
        state.jsonBuffers.set(index, prev + (event.delta.partial_json || ""));
      } else {
        applyDelta(block, event.delta);
      }
      break;
    }
    case "message_delta":
      Object.assign(state.message, event.delta || {});
      // message_delta usage is cumulative: it overrides message_start counts.
      state.message.usage = mergeUsage(state.message.usage, event.usage);
      break;
    case "message_stop":
      state.stopped = true;
      break;
    default:
      break;
  }
}

// Streamed tool input (tool_use, server_tool_use, mcp_tool_use…). Only the
// final content block (trailing empty blocks skipped) of a response cut off by
// the token limit or the context window keeps the finished arguments of an
// unfinished call (YAN-1854, see parseToolArguments in completionToClient.js):
// only that block can be cut off, so invalid JSON in an earlier block is
// malformed, not truncated, and becomes `{}` like any invalid input (YAN-1926).
function toolInput(json, stopReason, isLastBlock) {
  if (isLastBlock && CUT_OFF_STOPS.has(stopReason)) return parsePartialJSONObject(json);
  return parseJSONObject(json);
}

// A text or thinking block that never received content: an upstream may open
// one after the block that was cut off, so it does not count as the last block.
function isEmptyBlock(block) {
  if (block.type === CLAUDE_BLOCK.TEXT) return !block.text;
  if (block.type === CLAUDE_BLOCK.THINKING) return !block.thinking && !block.signature;
  return false;
}

// message_stop without a stop_reason: infer it like the streaming pivot
// (claude-to-openai.js message_stop), tool_use when a tool was called.
function inferredStopReason(blocks) {
  return blocks.some((block) => block?.type === CLAUDE_BLOCK.TOOL_USE)
    ? CLAUDE_STOP.TOOL_USE
    : CLAUDE_STOP.END_TURN;
}

/**
 * Aggregate Claude Messages SSE into one Claude `message` body.
 * @param {string} rawSSE
 * @param {string} fallbackModel - used when message_start names no model
 * @returns {object|{error: object}|null} the message; `{error}` for a failed,
 *   malformed or truncated stream (neither stop_reason nor message_stop); null
 *   when the body holds no Claude events.
 */
export function claudeSseToMessage(rawSSE, fallbackModel) {
  const { events, error, malformed } = readSSEData(rawSSE);
  if (error) return { error };
  if (!events.some((event) => CLAUDE_EVENTS.has(event?.type))) return null;
  // A dropped frame could be any content delta: never return a silently
  // truncated body as a success.
  if (malformed > 0) return { error: { message: "Upstream Claude stream had a malformed frame" } };

  const state = {
    fallbackModel,
    message: newMessage(fallbackModel),
    blocks: [],
    jsonBuffers: new Map(), // block index -> streamed input JSON text
    stopped: false,
    orphanInput: false, // an input_json_delta named no opened block
  };
  for (const event of events) applyEvent(state, event);
  if (state.orphanInput) {
    return {
      error: {
        message: "Upstream Claude stream had an input_json_delta without content_block_start",
      },
    };
  }

  const { message, blocks } = state;
  if (!message.stop_reason) {
    if (!state.stopped) {
      return { error: { message: "Upstream Claude stream ended before stop_reason" } };
    }
    message.stop_reason = inferredStopReason(blocks);
  }
  const lastIndex = blocks.findLastIndex((block) => block && !isEmptyBlock(block));
  for (const [index, json] of state.jsonBuffers) {
    if (json) blocks[index].input = toolInput(json, message.stop_reason, index === lastIndex);
  }
  const content = blocks.filter(Boolean);
  // An empty message keeps the placeholder the OpenAI pivot produced.
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });
  return { ...message, content };
}
