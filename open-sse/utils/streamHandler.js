// Stream handler with disconnect detection - shared for all providers
import { STREAM_KEEPALIVE_INTERVAL_MS, STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { SSE_KEEPALIVE } from "./sseConstants.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { clockTime } from "./clockTime.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return clockTime();
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({
  onDisconnect,
  onError,
  log,
  provider,
  model,
  reqTag = "",
} = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else
      console.log(
        `[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`,
      );
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort(),
  };
}

const KEEPALIVE_BYTES = new TextEncoder().encode(SSE_KEEPALIVE);
const LF = 0x0a;
const CR = 0x0d;

// Trailing line feeds of an output chunk (CRs ignored), carried across chunks
// that are all newlines. >= 2 means the client sits on an SSE event boundary.
function trailingNewlines(chunk, prev) {
  const len = chunk?.length ?? 0;
  if (!len) return prev;
  const at = typeof chunk === "string" ? (i) => chunk.charCodeAt(i) : (i) => chunk[i];
  let n = 0;
  for (let i = len - 1; i >= 0; i--) {
    const c = at(i);
    if (c === CR) continue;
    if (c !== LF) return n;
    n++;
  }
  return prev + n;
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * Keepalive: with `keepaliveIntervalMs` > 0, an SSE comment is written to the
 * client whenever nothing was written for that long (including before the
 * first chunk), so idle-timeout proxies don't cut a silent stream. It is only
 * written on an event boundary, never inside a partially written event, and
 * it never reaches the transform (translators, usage, logs) or the upstream
 * stall watchdog. The timer stops on end, error, cancel and disconnect.
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 * @param {{ keepaliveIntervalMs?: number }} [options]
 */
export function createDisconnectAwareStream(
  transformStream,
  streamController,
  onAbortTerminal = null,
  { keepaliveIntervalMs = 0 } = {},
) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let closed = false;
  let keepaliveTimer = null;
  // Nothing written yet counts as a boundary: a keepalive may lead the stream.
  let newlines = 2;

  const clearKeepalive = () => {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
  const markClosed = () => {
    closed = true;
    clearKeepalive();
  };
  const armKeepalive = (controller) => {
    clearKeepalive();
    if (!(keepaliveIntervalMs > 0) || closed) return;
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      if (closed || !streamController.isConnected()) {
        markClosed();
        return;
      }
      if (newlines >= 2) {
        try {
          controller.enqueue(KEEPALIVE_BYTES);
        } catch {
          markClosed(); // stream already closed/errored downstream
          return;
        }
      }
      armKeepalive(controller);
    }, keepaliveIntervalMs);
    keepaliveTimer.unref?.();
  };
  const write = (controller, chunk) => {
    controller.enqueue(chunk);
    newlines = trailingNewlines(chunk, newlines);
    armKeepalive(controller);
  };

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch {
      /* best-effort terminal */
    }
  };

  return new ReadableStream({
    start(controller) {
      armKeepalive(controller);
    },

    async pull(controller) {
      if (!streamController.isConnected()) {
        markClosed();
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          markClosed();
          streamController.handleComplete();
          controller.close();
          return;
        }
        write(controller, value);
      } catch (error) {
        markClosed();
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed =
          msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) {
          /* already closed or cancelled */
        }
      }
    },

    cancel(reason) {
      markClosed();
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    },
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 * @param {function} [onAbortTerminal] - Terminal bytes after an abort (see createDisconnectAwareStream)
 * @param {number} [stallTimeoutMs] - Upstream inactivity before the fetch is aborted
 * @param {number} [keepaliveIntervalMs] - Client-side silence before an SSE keepalive comment; 0 = off.
 *   Keepalives are added after the transform, so the stall timer above never sees them.
 */
export function pipeWithDisconnect(
  providerResponse,
  transformStream,
  streamController,
  onAbortTerminal = null,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  keepaliveIntervalMs = STREAM_KEEPALIVE_INTERVAL_MS,
) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      abortMessage = "stream stall timeout";
      dbg(
        tag,
        `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`,
      );
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => {
      dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
      clearStall();
      streamController.handleComplete();
    },
    handleError: (e) => {
      dbg(
        tag,
        `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      streamController.handleError(e);
    },
    handleDisconnect: (r) => {
      dbg(
        tag,
        `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      streamController.handleDisconnect(r);
    },
    abort: () => {
      clearStall();
      streamController.abort();
    },
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      dbg(
        tag,
        `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
    },
  });

  // No pipeThrough({signal}): aborting such a pipe rejects Node's internal
  // pipe promise with an unhandled AbortError (YAN-763). Upstream teardown is
  // owned by the executor's fetch signal (streamController.abort) and by
  // reader.cancel on the disconnect-aware tail.
  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    {
      readable: transformedBody,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null,
    { keepaliveIntervalMs },
  );
}
