import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * tokenhop can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await super.execute(opts);
      if (!result?.response?.ok || !result.response.body) return result;

      const wrappedResponse = await inspectAndWrapCommandCodeResponse(result.response, opts.model);
      if (!wrappedResponse.ok && attempt < maxRetries) {
        const isRetryableStatus =
          wrappedResponse.status === 502 ||
          wrappedResponse.status === 503 ||
          wrappedResponse.status === 504;
        if (isRetryableStatus) {
          opts.log?.debug?.(
            "RETRY",
            `CommandCode upstream returned status ${wrappedResponse.status}, retrying ${attempt + 1}/${maxRetries}...`,
          );
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }

      result.response = wrappedResponse;
      return result;
    }
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (
      lower.includes("unauthorized") ||
      lower.includes("invalid api key") ||
      lower.includes("authentication")
    ) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (
      lower.includes("quota") ||
      lower.includes("forbidden") ||
      lower.includes("permission")
    ) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (
      lower.includes("unavailable") ||
      lower.includes("overloaded") ||
      lower.includes("server error")
    ) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

// Length of the byte prefix that holds only complete UTF-8 sequences. A
// trailing lead byte (or lead + continuation bytes) of an unfinished
// multi-byte character is excluded.
function completeUtf8Length(bytes) {
  let i = bytes.length;
  while (i > 0 && (bytes[i - 1] & 0xc0) === 0x80) i--;
  if (i === 0) return bytes.length;
  const lead = bytes[i - 1];
  if ((lead & 0x80) === 0) return bytes.length;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return bytes.length - (i - 1) >= need ? bytes.length : i - 1;
}

function concatBytes(a, b) {
  if (!a?.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function inspectAndWrapCommandCodeResponse(originalResponse, model) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Undecoded tail bytes (incomplete multi-byte character). Kept raw so the
  // replay stream can hand them downstream verbatim — a TextDecoder holding
  // them would silently drop them when the peek loop stops mid-chunk.
  let pendingBytes = new Uint8Array(0);
  const bufferedLines = [];
  let detectedError = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (pendingBytes.length) {
          buffer += decoder.decode(pendingBytes);
          pendingBytes = new Uint8Array(0);
        }
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            } else {
              bufferedLines.push(trimmed);
            }
          } catch {
            bufferedLines.push(trimmed);
          }
        }
        break;
      }

      const bytes = concatBytes(pendingBytes, value);
      const completeLen = completeUtf8Length(bytes);
      buffer += decoder.decode(bytes.subarray(0, completeLen));
      pendingBytes = bytes.subarray(completeLen);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let stopLoop = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (stopLoop) {
          bufferedLines.push(trimmed);
          continue;
        }
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          bufferedLines.push(trimmed);
          stopLoop = true;
          continue;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          bufferedLines.push(trimmed);
          continue;
        }

        if (event?.type === "error") {
          detectedError = event;
          stopLoop = true;
          break;
        }

        bufferedLines.push(trimmed);

        if (
          event?.type === "text-delta" ||
          event?.type === "reasoning-delta" ||
          event?.type === "tool-input-start" ||
          event?.type === "tool-call" ||
          event?.type === "finish" ||
          event?.type === "finish-step"
        ) {
          // Keep scanning so the rest of this chunk is buffered for replay.
          stopLoop = true;
        }
      }

      if (stopLoop) break;
    }
  } catch {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    return originalResponse;
  }

  if (detectedError) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    const { statusCode, message, type } = parseCommandCodeError(detectedError);
    return new Response(
      JSON.stringify({
        error: {
          message: `[CommandCode error: ${message}]`,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        statusText:
          statusCode === 503
            ? "Service Unavailable"
            : statusCode === 429
              ? "Too Many Requests"
              : "Bad Gateway",
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const combinedStream = createReplayedStream(bufferedLines, buffer, pendingBytes, reader);
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createReplayedStream(bufferedLines, remainingBuffer, trailingBytes, reader) {
  const encoder = new TextEncoder();
  let replayed = false;

  return new ReadableStream({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        let prefix = bufferedLines.join("\n");
        if (prefix && remainingBuffer) {
          prefix += "\n" + remainingBuffer;
        } else if (remainingBuffer) {
          prefix = remainingBuffer;
        } else if (prefix) {
          prefix += "\n";
        }
        if (prefix) {
          controller.enqueue(encoder.encode(prefix));
        }
        // Raw bytes of an unfinished multi-byte character; they precede the
        // live reader bytes so the downstream decoder reassembles the char.
        if (trailingBytes?.length) {
          controller.enqueue(trailingBytes);
        }
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(originalResponse?.headers ? Object.fromEntries(originalResponse.headers.entries()) : {}),
      "content-type": "text/event-stream",
    },
  });
}

export default CommandCodeExecutor;
