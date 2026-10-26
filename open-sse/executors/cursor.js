import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  encodeField,
  wrapConnectRPCFrame,
  decodeMessage,
  decodeStringField,
  encodeMcpTools,
  encodeSelectedContextImages,
  decodeMcpArgs,
  concatArrays,
} from "../utils/cursorProtobuf.js";
import { AGENT_ENVIRONMENT_NOTE, EXEC_VARIANT, buildExecReply } from "../utils/cursorAgentExec.js";
import { redirectNativeExec } from "../utils/cursorNativeToolRedirect.js";
import { resolveCursorImages, CursorImageError } from "../utils/cursorImages.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { FORMATS } from "../translator/formats.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";
import { refreshCursorToken, cursorRefreshSource } from "../services/tokenRefresh/cursor.js";
import zlib from "zlib";
import crypto from "crypto";

// Detect cloud environment
const isCloudEnv = () => {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
};

// Lazy import http2 (only in Node.js environment)
let http2 = null;
if (!isCloudEnv()) {
  try {
    http2 = await import("http2");
  } catch {
    // http2 not available
  }
}

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  TRAILER: 0x02,
  GZIP_TRAILER: 0x03,
};

const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
const PROTOBUF_LEN = 2;
const PROTOBUF_VARINT = 0;

const agentString = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentMessage = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentBool = (field, value) => encodeField(field, PROTOBUF_VARINT, value ? 1 : 0);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === OPENAI_BLOCK.TEXT && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function isAgentCapableRequest(body) {
  // Every supported chat shape runs on AgentService: text, declared tool
  // schemas, tool-call history, and images (via selected_context). The retired
  // ChatService answers "Update Required" for all shapes at api2.cursor.sh, so
  // nothing is allowed onto the legacy path anymore.
  return Array.isArray(body?.messages) && body.messages.length > 0;
}

// One prior turn as transcript text, with tool calls/results kept inline so
// the model can see what it already ran and what came back.
function renderHistoryMessage(message) {
  const content = textFromContent(message?.content);
  const extras = [];
  if (message?.role === ROLE.ASSISTANT && message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      extras.push(
        `[tool_call id=${tc.id || ""} name=${tc.function?.name || "tool"} args=${tc.function?.arguments || "{}"}]`,
      );
    }
  }
  if (message?.role === ROLE.TOOL) {
    extras.push(`[tool_result id=${message.tool_call_id || ""}]`);
  }
  const textBody = [content, ...extras].filter(Boolean).join("\n");
  if (!textBody) return null;
  const speaker = message.role === ROLE.ASSISTANT ? "Assistant" : "User";
  return `${speaker}:\n${textBody}`;
}

// AgentService has no inline history channel for a stateless request:
// UserMessageAction defines no history field (unknown fields are dropped) and
// ConversationStateStructure.turns holds server-side blob references, not
// inline turns. Fold the transcript into the current message so the model
// still sees the task, earlier tool calls and their results (YAN-248).
function renderConversationHistory(history) {
  if (!history.length) return "";
  return `<conversation_history>\n${history.join("\n\n")}\n</conversation_history>\n\nLatest message:\n`;
}

export function buildAgentRunFrame(messages, model, tools = [], { images = [] } = {}) {
  // custom_system_prompt (RunRequest field 8) makes AgentService return an
  // empty turn. Fold system text into the current user message instead.
  const isInstruction = (message) =>
    message?.role === ROLE.SYSTEM || message?.role === ROLE.DEVELOPER;
  const system = messages
    .filter(isInstruction)
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const chatMessages = messages.filter((message) => !isInstruction(message));
  const currentIndex = [...chatMessages].map((message) => message?.role).lastIndexOf(ROLE.USER);
  const current = currentIndex >= 0 ? chatMessages[currentIndex] : chatMessages.at(-1);
  // History turns before the current one, including tool_calls / tool_results
  // as text. The agent protocol carries images only on the current turn
  // (selected_context.selected_images), so images from earlier turns are
  // replayed into the current turn and marked [image N=M ref] here.
  const history = chatMessages
    .slice(0, currentIndex >= 0 ? currentIndex : -1)
    .map(renderHistoryMessage)
    .filter(Boolean);
  const rawUser = textFromContent(current?.content) || "Continue.";
  const allImages = images;
  const currentMessageIndex = messages.indexOf(current);
  const historical = allImages.filter((image) => image.messageIndex !== currentMessageIndex);
  const imageRefs = historical.length
    ? `\n\n${historical
        .map((image, index) => {
          const turn = messages
            .slice(0, image.messageIndex + 1)
            .filter((message) => !isInstruction(message)).length;
          return `[image ${index + 1} from prior turn ${turn}]`;
        })
        .join("\n")}`
    : "";
  const preamble = [system, AGENT_ENVIRONMENT_NOTE].filter(Boolean).join("\n\n");
  const userText = `${preamble}\n\n${renderConversationHistory(history)}${rawUser}${imageRefs}`;
  const selectedContext = encodeSelectedContextImages(allImages);

  // agent.v1.UserMessageAction.user_message.
  // selected_context (3) + mode=1 (4) match cursor-agent's wire format; without
  // them the server may accept the RPC and stream an empty turn.
  const userMessage = concatArrays(
    agentString(1, userText),
    agentString(2, crypto.randomUUID()),
    agentMessage(3, selectedContext),
    encodeField(4, PROTOBUF_VARINT, 1),
  );
  const userAction = agentMessage(1, userMessage);
  const conversationAction = agentMessage(1, userAction);
  const requestedModel = concatArrays(agentString(1, model), agentBool(7, true));
  // ModelDetails (field 3): thinking variants (Composer, Grok, *-thinking)
  // return an empty turn when only RequestedModel (field 9) is set.
  const modelDetails = concatArrays(
    agentString(1, model),
    agentString(3, model),
    agentString(4, model),
  );
  const mcpTools = encodeMcpTools(tools);
  const runRequest = concatArrays(
    // An empty ConversationStateStructure starts a fresh local agent session.
    agentMessage(1, new Uint8Array()),
    agentMessage(2, conversationAction),
    agentMessage(3, modelDetails),
    ...(mcpTools.length ? [agentMessage(4, mcpTools)] : []),
    agentMessage(9, requestedModel),
  );

  // agent.v1.AgentClientMessage.run_request.
  return wrapConnectRPCFrame(agentMessage(1, runRequest));
}

// Split Connect frames. Data frames go to onFrame; the end-of-stream trailer
// (flag 0x02) is the only channel for a terminal error when HTTP status is 200
// (Update Required, quota, …) — hand it to onTrailer instead of dropping it.
function decodeAgentFrames(buffer, onFrame, onTrailer) {
  let pending = Buffer.from(buffer || []);
  while (pending.length >= 5) {
    const flags = pending[0];
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    let payload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (flags & COMPRESS_FLAG.GZIP) {
      payload = zlib.gunzipSync(payload);
    }
    if (flags & COMPRESS_FLAG.TRAILER) onTrailer?.(payload);
    else onFrame(payload);
  }
  return pending;
}

function encodeKvClientMessage(kvId, resultField, resultPayload, metadata) {
  const parts = [];
  if (kvId) parts.push(encodeField(1, PROTOBUF_VARINT, kvId));
  parts.push(encodeField(resultField, PROTOBUF_LEN, resultPayload || new Uint8Array()));
  if (metadata && metadata.length) parts.push(encodeField(4, PROTOBUF_LEN, metadata));
  return wrapConnectRPCFrame(agentMessage(3, concatArrays(...parts)));
}

// An exec request with no tool variant cannot be answered; end the turn with
// a stable, request-scoped error instead of stalling the h2 stream.
const UNSUPPORTED_EXEC_ERROR = {
  status: HTTP_STATUS.BAD_REQUEST,
  type: "api_error",
  code: "cursor_unsupported_exec",
  message: "Cursor AgentService sent an exec request without a tool variant",
};

function isComposerModel(model) {
  const modelId = String(model || "")
    .split("/")
    .pop();
  return /^composer(?:-|$)/i.test(modelId);
}

function visibleComposerContentFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return "";
  return thinking.slice(endIdx + endTag.length).trimStart();
}

/**
 * Classify a Cursor Connect error envelope ({ error: { code, message, details } }).
 * YAN-134: Cursor answers stale-client shapes with resource_exhausted +
 * title "Update Required" — an incompatibility, not quota. It must be a
 * request-scoped 400 so accountFallback never backoff-locks healthy accounts
 * (its message carries no rate-limit wording, so no text rule matches either).
 * Plain resource_exhausted stays 429 so genuine quota still rotates accounts.
 */
export function classifyCursorError(jsonError) {
  const debug = jsonError?.error?.details?.[0]?.debug;
  const title = debug?.details?.title || "";
  const detail = debug?.details?.detail || "";
  const message = title || detail || jsonError?.error?.message || "Cursor API error";
  if (/update required/i.test(`${title} ${detail} ${jsonError?.error?.message || ""}`)) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      type: "invalid_request_error",
      code: "cursor_client_update_required",
      message: `Cursor rejected this request as coming from an outdated client: ${message}`,
    };
  }
  if (jsonError?.error?.code === "resource_exhausted") {
    return {
      status: HTTP_STATUS.RATE_LIMITED,
      type: "rate_limit_error",
      code: debug?.error || "resource_exhausted",
      message,
    };
  }
  if (jsonError?.error?.code === "unauthenticated") {
    return {
      status: HTTP_STATUS.UNAUTHORIZED,
      type: "authentication_error",
      code: "unauthenticated",
      message,
    };
  }
  return {
    status: HTTP_STATUS.BAD_REQUEST,
    type: "api_error",
    code: debug?.error || jsonError?.error?.code || "unknown",
    message,
  };
}

// Connect end-of-stream trailer frame → JSON error, if any.
function parseConnectTrailerError(payload) {
  try {
    const json = JSON.parse(Buffer.from(payload).toString("utf8"));
    return json?.error ? json : null;
  } catch {
    return null;
  }
}

export class CursorExecutor extends BaseExecutor {
  constructor() {
    super("cursor", PROVIDERS.cursor);
  }

  canRefreshCredentials(credentials) {
    return Boolean(cursorRefreshSource(credentials));
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;

    if (!machineId) {
      throw new Error("Machine ID is required for Cursor API");
    }

    return buildCursorHeaders(accessToken, machineId, ghostMode);
  }

  /**
   * AgentService (agent.api5.cursor.sh) is HTTP/2-only. Node's fetch/undici speaks
   * HTTP/1.1 and fails with HTTPParserError on the h2 preface — use http2 duplex.
   */
  openAgentHttp2Stream(url, headers, signal) {
    if (!http2) {
      throw new Error("HTTP/2 is required for Cursor AgentService (endpoint is h2-only)");
    }

    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunkQueue = [];
    let waiting = null;
    let ended = false;
    let streamError = null;
    let req = null;

    const wake = (result) => {
      if (!waiting) return;
      const resolve = waiting;
      waiting = null;
      resolve(result);
    };

    const fail = (error) => {
      if (streamError) return;
      streamError = error;
      ended = true;
      wake(null);
    };

    const close = () => {
      try {
        req?.destroy();
      } catch {}
      try {
        client.close();
      } catch {}
    };

    client.on("error", fail);

    req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("error", fail);
    req.on("data", (chunk) => {
      if (waiting) wake({ value: chunk, done: false });
      else chunkQueue.push(chunk);
    });
    req.on("end", () => {
      ended = true;
      wake({ value: undefined, done: true });
    });

    if (signal) {
      const onAbort = () => {
        fail(new Error("Request aborted"));
        close();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const responseHeaders = new Promise((resolve, reject) => {
      const onEarlyError = (error) => reject(error);
      client.once("error", onEarlyError);
      req.once("error", onEarlyError);
      req.once("response", (hdrs) => {
        client.off("error", onEarlyError);
        req.off("error", onEarlyError);
        resolve(hdrs);
      });
    });

    return {
      responseHeaders,
      write(frame) {
        if (req && !req.destroyed) req.write(Buffer.from(frame));
      },
      end() {
        try {
          if (req && !req.destroyed) req.end();
        } catch {}
      },
      close,
      async read() {
        if (chunkQueue.length) return { value: chunkQueue.shift(), done: false };
        if (ended) {
          if (streamError) throw streamError;
          return { value: undefined, done: true };
        }
        const result = await new Promise((resolve) => {
          waiting = resolve;
        });
        if (streamError) throw streamError;
        return result || { value: undefined, done: true };
      },
    };
  }

  async executeAgent({ model, body, stream, credentials, signal, log }) {
    const agentEndpoint = PROVIDER_OAUTH.cursor?.agentEndpoint;
    if (!agentEndpoint) throw new Error("Cursor AgentService endpoint is not configured");

    const url = `${agentEndpoint}${AGENT_RUN_PATH}`;
    const headers = this.buildHeaders(credentials);
    const requestController = new AbortController();
    if (signal?.aborted) requestController.abort(signal.reason);
    else if (signal?.addEventListener) {
      signal.addEventListener("abort", () => requestController.abort(signal.reason), {
        once: true,
      });
    }

    let session;
    const tools = body.tools || [];
    try {
      // Resolve + validate images before opening the stream: failures are
      // request-scoped, account-neutral errors, never silently dropped media.
      const images = await resolveCursorImages(body.messages || [], {
        signal: requestController.signal,
      });
      session = this.openAgentHttp2Stream(url, headers, requestController.signal);
      session.write(buildAgentRunFrame(body.messages || [], model, tools, { images }));
    } catch (error) {
      try {
        session?.close();
      } catch {}
      if (error instanceof CursorImageError) throw error;
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    let responseHeaders;
    try {
      responseHeaders = await session.responseHeaders;
    } catch (error) {
      session.close();
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    const status = Number(responseHeaders[":status"] || 0);
    if (status !== 200) {
      let errorText = "";
      try {
        while (true) {
          const { done, value } = await session.read();
          if (done) break;
          errorText += Buffer.from(value).toString("utf8");
        }
      } catch {}
      session.close();
      // Classify structured Connect errors (Update Required, quota); fall back
      // to the raw upstream status otherwise.
      let classified = null;
      try {
        classified = JSON.parse(errorText);
      } catch {}
      const detail = classified?.error ? classifyCursorError(classified) : null;
      return {
        response: new Response(
          JSON.stringify({
            error: detail
              ? { message: detail.message, type: detail.type, code: detail.code }
              : {
                  message: `Cursor AgentService ${status}: ${errorText || "request failed"}`,
                  type: "api_error",
                },
          }),
          {
            status: detail?.status || status || HTTP_STATUS.SERVER_ERROR,
            headers: { "Content-Type": "application/json" },
          },
        ),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    // The Claude SSE translator derives Anthropic's message ID by stripping
    // `chatcmpl-`. Keep the remaining ID in Anthropic's required `msg_` form
    // so strict clients such as Claude Code accept the completed stream.
    const responseId = `chatcmpl-msg_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const composerModel = isComposerModel(model);
    let pending = Buffer.alloc(0);
    let finished = false;
    let thinkingAcc = "";
    let emittedVisible = 0;
    let emittedText = false;

    const flushThinkingFallback = (onEvent) => {
      if (emittedText || !thinkingAcc) return;
      const fallback = composerModel
        ? visibleComposerContentFromThinking(thinkingAcc)
        : thinkingAcc.trim();
      if (fallback) {
        emittedText = true;
        onEvent({ type: "text", value: fallback });
      }
    };

    const consume = async (onEvent) => {
      const emitToolCallAndEnd = (toolCall) => {
        finished = true;
        onEvent({ type: "tool_call", value: toolCall });
        onEvent({ type: "done", finishReason: "tool_calls" });
      };
      try {
        while (!finished) {
          const { done, value } = await session.read();
          if (done) break;
          pending = Buffer.concat([pending, Buffer.from(value)]);
          pending = decodeAgentFrames(
            pending,
            (payload) => {
              // A single read can carry several frames; once the turn is over the
              // rest of the batch must not reach the already-closed controller.
              if (finished) return;
              const serverMessage = decodeMessage(payload);

              // agent.v1.AgentServerMessage.interaction_update
              if (serverMessage.has(1)) {
                const update = decodeMessage(serverMessage.get(1)[0].value);
                if (update.has(1)) {
                  const textDelta = decodeStringField(decodeMessage(update.get(1)[0].value), 1);
                  if (textDelta) {
                    emittedText = true;
                    onEvent({ type: "text", value: textDelta });
                  }
                }
                // thinking_delta (field 4). Composer (and some Grok variants) put
                // the visible answer after </think> here and never send text_delta.
                if (update.has(4)) {
                  const thinkingDelta = decodeStringField(decodeMessage(update.get(4)[0].value), 1);
                  if (thinkingDelta) {
                    thinkingAcc += thinkingDelta;
                    if (composerModel) {
                      const visible = visibleComposerContentFromThinking(thinkingAcc);
                      if (visible.length > emittedVisible) {
                        const deltaContent = visible.slice(emittedVisible);
                        emittedVisible = visible.length;
                        emittedText = true;
                        onEvent({ type: "text", value: deltaContent });
                      }
                    }
                  }
                }
                // Keep unsigned reasoning upstream-only for Anthropic clients.
                if (update.has(14)) {
                  flushThinkingFallback(onEvent);
                  finished = true;
                  onEvent({ type: "done" });
                }
              }

              // KvServerMessage (field 4): get/set blob. Ack so the stream proceeds.
              if (serverMessage.has(4)) {
                const kv = decodeMessage(serverMessage.get(4)[0].value);
                const kvId = kv.get(1)?.[0]?.value || 0;
                const metadata = kv.get(4)?.[0]?.value || null;
                if (kv.has(2)) {
                  session.write(
                    encodeKvClientMessage(kvId, 2, agentMessage(1, new Uint8Array()), metadata),
                  );
                } else if (kv.has(3)) {
                  session.write(encodeKvClientMessage(kvId, 3, new Uint8Array(), metadata));
                }
              }

              // ExecServerMessage: AgentService asks the "IDE" for context or to
              // run a tool. Named MCP calls are the client's tool calls; native
              // built-ins (read/grep/ls/shell) become the client's tool call too
              // when a declared tool's schema can be filled; every other exec is
              // answered in-stream so the turn keeps going.

              if (serverMessage.has(2)) {
                const execRequest = decodeMessage(serverMessage.get(2)[0].value);
                const mcp = execRequest.has(EXEC_VARIANT.MCP)
                  ? decodeMcpArgs(execRequest.get(EXEC_VARIANT.MCP)[0].value)
                  : null;
                const toolName = mcp?.toolName || mcp?.name;
                if (toolName) {
                  log?.info?.("CURSOR", `AgentService MCP tool_call ${toolName}`);
                  emitToolCallAndEnd({
                    id: mcp.toolCallId || `call_${crypto.randomUUID()}`,
                    name: toolName,
                    arguments: JSON.stringify(mcp.args || {}),
                  });
                  return;
                }
                const redirected = redirectNativeExec(execRequest, tools);
                if (redirected) {
                  log?.info?.("CURSOR", redirected.message);
                  emitToolCallAndEnd(redirected.toolCall);
                  return;
                }
                const reply = buildExecReply(execRequest, { tools });
                if (!reply) {
                  log?.warn?.(
                    "CURSOR",
                    `AgentService exec request has no tool variant fields=${[...execRequest.keys()].join(",")}`,
                  );
                  finished = true;
                  onEvent({ type: "error", value: UNSUPPORTED_EXEC_ERROR });
                  return;
                }
                if (reply.level === "warn") log?.warn?.("CURSOR", reply.message);
                else log?.info?.("CURSOR", reply.message);
                session.write(reply.frame);
              }
            },
            // Known limitation: an auth failure (e.g. `unauthenticated`) that only
            // surfaces in this end-of-stream trailer arrives after the 200 response
            // was already returned, so it can't trigger reactive refresh/fallback.
            // Proactive refresh (registry refreshLeadMs, 1 day) covers expiry.
            (trailer) => {
              const trailerError = parseConnectTrailerError(trailer);
              if (!trailerError || finished) return;
              finished = true;
              onEvent({ type: "error", value: classifyCursorError(trailerError) });
            },
          );
        }
        // Only a clean EOF completes the turn; transport errors must propagate.
        if (!finished) {
          flushThinkingFallback(onEvent);
          onEvent({ type: "done" });
        }
      } finally {
        try {
          session.end();
        } catch {}
        try {
          session.close();
        } catch {}
      }
    };

    if (stream === false) {
      let content = "";
      let reasoning = "";
      let agentError = null;
      const toolCalls = [];
      let finishReason = "stop";
      await consume((event) => {
        if (event.type === "text") content += event.value;
        else if (event.type === "thinking") reasoning += event.value;
        else if (event.type === "tool_call") {
          toolCalls.push({
            id: event.value.id,
            type: "function",
            function: { name: event.value.name, arguments: event.value.arguments },
          });
          finishReason = "tool_calls";
        } else if (event.type === "error") agentError = event.value;
        else if (event.type === "done" && event.finishReason) finishReason = event.finishReason;
      });
      if (agentError) {
        // Structured upstream errors keep their classified status (Update
        // Required → 400, quota → 429); protocol errors are request-scoped 400.
        const detail =
          typeof agentError === "string"
            ? { status: HTTP_STATUS.BAD_REQUEST, message: agentError, type: "api_error" }
            : agentError;
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: detail.message,
                type: detail.type,
                ...(detail.code ? { code: detail.code } : {}),
              },
            }),
            {
              status: detail.status,
              headers: { "Content-Type": "application/json" },
            },
          ),
          url,
          headers,
          transformedBody: body,
          responseFormat: FORMATS.OPENAI,
        };
      }
      const message = {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      return {
        response: new Response(
          JSON.stringify({
            id: responseId,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: estimateUsage(body, content.length, FORMATS.OPENAI),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        consume((event) => {
          if (event.type === "text") {
            controller.enqueue(
              encoder.encode(
                chatChunkSse({ id: responseId, created, model, delta: { content: event.value } }),
              ),
            );
          } else if (event.type === "thinking") {
            controller.enqueue(
              encoder.encode(
                chatChunkSse({
                  id: responseId,
                  created,
                  model,
                  delta: { reasoning_content: event.value },
                }),
              ),
            );
          } else if (event.type === "tool_call") {
            controller.enqueue(
              encoder.encode(
                chatChunkSse({
                  id: responseId,
                  created,
                  model,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: event.value.id,
                        type: "function",
                        function: { name: event.value.name, arguments: event.value.arguments },
                      },
                    ],
                  },
                }),
              ),
            );
          } else if (event.type === "error") {
            // An SSE error frame, not a content delta: a protocol failure must not
            // be rendered to the user as the assistant's reply, and downstream
            // usage tracking must not record the turn as a success.
            const detail =
              typeof event.value === "string"
                ? { message: event.value, type: "api_error" }
                : { message: event.value.message, type: event.value.type, code: event.value.code };
            controller.enqueue(encoder.encode(sseChunk({ error: detail })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } else if (event.type === "done") {
            controller.enqueue(
              encoder.encode(
                chatChunkSse({
                  id: responseId,
                  created,
                  model,
                  delta: {},
                  finishReason: event.finishReason || "stop",
                }),
              ),
            );
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          }
        }).catch((error) => controller.error(error));
      },
      cancel() {
        requestController.abort();
      },
    });

    return {
      response: new Response(responseStream, { headers: SSE_HEADERS }),
      url,
      headers,
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const agentUrl = `${PROVIDER_OAUTH.cursor?.agentEndpoint || ""}${AGENT_RUN_PATH}`;
    const errorResult = (status, message, type, code) => ({
      response: new Response(JSON.stringify({ error: { message, type, code } }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url: agentUrl,
      headers: {},
      transformedBody: body,
    });

    // ponytail: AgentService is raw HTTP/2 and has no proxy transport yet.
    // Honour strictProxy by failing instead of silently going direct; add an
    // h2-over-CONNECT tunnel when proxied Cursor traffic is needed.
    if (proxyOptions?.strictProxy === true) {
      return errorResult(
        HTTP_STATUS.BAD_REQUEST,
        "Cursor AgentService is HTTP/2-only and cannot use the configured proxy (strictProxy=true)",
        "invalid_request_error",
        "cursor_proxy_unsupported",
      );
    }
    if (!isAgentCapableRequest(body)) {
      return errorResult(
        HTTP_STATUS.BAD_REQUEST,
        "Cursor AgentService: request has no messages",
        "invalid_request_error",
        "empty_request",
      );
    }
    try {
      return await this.executeAgent({ model, body, stream, credentials, signal, log });
    } catch (error) {
      // Invalid images are the caller's fault — request-scoped 400, never an
      // account-level failure that would rotate or cool down Cursor accounts.
      if (error instanceof CursorImageError) {
        return errorResult(
          HTTP_STATUS.BAD_REQUEST,
          error.message,
          "invalid_request_error",
          "invalid_image",
        );
      }
      return errorResult(HTTP_STATUS.SERVER_ERROR, error.message, "connection_error", "");
    }
  }

  // cursorRefreshSource falls back to the accessToken for legacy imported rows
  // that have no refresh token: a Cursor session JWT is itself a valid refresh_token.
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return refreshCursorToken(cursorRefreshSource(credentials), log, proxyOptions);
  }
}

export default CursorExecutor;
