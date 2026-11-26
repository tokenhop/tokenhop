/**
 * Combo empty-stream probe (YAN-1023): peek at the head of a 2xx SSE/NDJSON
 * response and decide whether it carries a meaningful token before handing
 * the stream to the client. Empty members (role-only / usage-only /
 * finish_reason / [DONE]) are skipped so combo falls through to the next
 * model instead of serving a tokenless stream.
 *
 * Design: read response.body, keep raw chunks for byte-exact replay,
 * classify a TextDecoder copy, and on first meaningful token return a
 * pull-based Response replaying buffered + remaining bytes. Byte/time caps
 * are fail-open (release).
 */

import { hasAnswerToken, hasMeaningfulToken, refusalOf } from "./streamHelpers.js";

const DEFAULT_MAX_BYTES = 262144;
const DEFAULT_MAX_MS = 10 * 1000;

function isMeaningful(parsed) {
  try {
    return hasMeaningfulToken(parsed);
  } catch {
    return false;
  }
}

function isAnswer(parsed) {
  try {
    return hasAnswerToken(parsed);
  } catch {
    return false;
  }
}

function isErrorFrame(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.error != null) return true;
  return parsed.type === "error" || parsed.type === "response.failed";
}

// Extract the first error message from a probe error frame, else fallback.
function errorMessage(parsed, fallback) {
  const e = parsed?.error;
  const msg =
    (typeof e === "string" && e) ||
    e?.message ||
    parsed?.message ||
    (typeof parsed?.error === "object" ? JSON.stringify(parsed.error) : "");
  return msg || fallback;
}

// Parse one SSE buffer segment (no blank line inside) into JSON payloads.
// Joins multiple `data:` lines with "\n"; ignores `event:` / comments.
// Returns { payloads, done } where done means a [DONE] frame was seen.
function parseSseSegment(segment) {
  const payloads = [];
  let done = false;
  const dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines.length = 0;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    if (data.trim() === "") return;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      unknown = true; // non-JSON payload we can't judge: fail open
    }
  };
  let unknown = false;
  for (const rawLine of segment.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (!/^(event|id|retry):|^:/.test(line)) {
      // Not SSE framing (e.g. a raw JSON body under an SSE label): we can't
      // judge it, so the caller fails open.
      unknown = true;
    }
  }
  flush();
  return { payloads, done, unknown };
}

// Pull-based replay: buffered chunks first, then the pending (time-cap) read,
// then the live reader. cancel forwards to the reader.
function replayResponse(response, buffered, reader, pending = null) {
  let idx = 0;
  let inflight = pending;
  if (inflight) inflight.catch(() => {}); // surfaced via the awaited copy in pull()
  const stream = new ReadableStream({
    async pull(controller) {
      if (idx < buffered.length) {
        controller.enqueue(buffered[idx++]);
        return;
      }
      try {
        const r = await (inflight ?? reader.read());
        inflight = null;
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // swallow: reader may already be closed
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Peek at the head of a streaming response.
 * A refusal before any answer token resolves "refused" with a replay of the
 * stream and the refusal text, so the caller can serve it or skip the member.
 * `untilAnswer` keeps reading through reasoning-only frames (a model may think,
 * then refuse) until an answer token, a refusal or a cap; a stream that ends with
 * reasoning only is still released (YAN-1031).
 * @returns {Promise<{outcome:"release"|"refused"|"empty"|"error", response?, error?, refusal?}>}
 */
export async function probeStreamHead(
  response,
  { maxBytes = DEFAULT_MAX_BYTES, maxMs = DEFAULT_MAX_MS, signal = null, untilAnswer = false } = {},
) {
  if (!response.body) return { outcome: "release", response };

  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  const isNdjson = contentType.includes("ndjson") && !contentType.includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered = [];
  let bufferedBytes = 0;
  let text = "";

  let sawAnswer = false;
  // beforeAnswer: released on reasoning or a cap, so a refusal may still follow.
  const release = (pending = null) => ({
    outcome: "release",
    response: replayResponse(response, buffered, reader, pending),
    beforeAnswer: !sawAnswer,
  });
  // Not awaited: cancel of a tee()'d branch only resolves once every branch
  // cancels, and the upstream abort runs through the stream's own cancel hook.
  const reject = (error) => {
    reader.cancel().catch(() => {});
    return error ? { outcome: "error", error } : { outcome: "empty" };
  };

  let sawReasoning = false;
  const refused = (refusal) => ({
    outcome: "refused",
    refusal,
    response: replayResponse(response, buffered, reader),
  });

  // Classify one parsed frame: "meaningful" | { error } | { refusal } | null (keep going).
  const judge = (parsed) => {
    if (isErrorFrame(parsed)) return { error: errorMessage(parsed, "stream error") };
    const refusal = refusalOf(parsed);
    if (refusal !== null) return { refusal };
    if (isAnswer(parsed)) {
      sawAnswer = true;
      return "meaningful";
    }
    if (!untilAnswer) return isMeaningful(parsed) ? "meaningful" : null;
    if (isMeaningful(parsed)) sawReasoning = true;
    return null;
  };

  // Scan decoded text. `eof` treats the unterminated tail as a complete event.
  // Returns "meaningful" | "done" (terminal, nothing meaningful) | "more" | { error }.
  const scan = (eof) => {
    let payloads = [];
    let done = false;
    if (isNdjson) {
      const lines = text.split("\n");
      text = eof ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          payloads.push(JSON.parse(line));
        } catch {
          return "meaningful"; // fail-open: unrecognized line
        }
      }
    } else {
      const norm = text.replace(/\r\n/g, "\n");
      const cut = eof ? norm.length : norm.lastIndexOf("\n\n");
      if (cut < 0) {
        text = norm;
        return "more";
      }
      let unknown;
      ({ payloads, done, unknown } = parseSseSegment(norm.slice(0, cut)));
      text = eof ? "" : norm.slice(cut + 2);
      if (unknown) return "meaningful"; // fail-open: release unrecognized bodies
    }
    for (const parsed of payloads) {
      const v = judge(parsed);
      if (v) return v;
    }
    return done || eof ? "done" : "more";
  };

  const deadline = Date.now() + maxMs;
  const verdictOf = (v) => {
    if (v === "done") return sawReasoning ? release() : reject();
    return v.refusal !== undefined ? refused(v.refusal) : reject(v.error);
  };

  for (;;) {
    const read = reader.read();
    let timer;
    let onAbort;
    let r;
    try {
      r = await Promise.race([
        read,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        }),
        // A hedged race loser is aborted mid-probe: the buffered head and the
        // still-open reader are cancelled together.
        new Promise((_, rej) => {
          if (!signal) return;
          onAbort = () => rej(new Error("Attempt aborted"));
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (err) {
      return reject(err?.message || String(err) || "stream error");
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }

    // Time cap: fail-open; replay awaits this same read first (no lost chunk).
    if (r === null) return release(read);

    if (r.done) {
      const v = scan(true);
      return v === "meaningful" ? release() : verdictOf(v);
    }

    buffered.push(r.value);
    bufferedBytes += r.value.byteLength;
    text += decoder.decode(r.value, { stream: true });
    const v = scan(false);
    if (v === "meaningful") return release();
    if (v !== "more") return verdictOf(v);
    if (bufferedBytes >= maxBytes) return release();
  }
}

/**
 * Pass a released stream through unchanged while watching for a refusal that
 * arrives before any answer token (YAN-2479: a model may reason, then refuse,
 * after the probe already released on its reasoning). Calls onRefusal(text) at
 * most once; stops parsing at the first answer token. Fail-open: a parse problem
 * only ends the watch, never the stream.
 * @param {Response} response
 * @param {(refusal: string) => void} onRefusal
 * @returns {Response}
 */
export function watchForLateRefusal(response, onRefusal) {
  if (!response?.body) return response;
  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  const isNdjson = contentType.includes("ndjson") && !contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let text = "";
  let watching = true;
  const inspect = (payloads) => {
    for (const parsed of payloads) {
      const refusal = refusalOf(parsed);
      if (refusal !== null) {
        watching = false;
        try {
          onRefusal(refusal);
        } catch {
          // observer must never break streaming
        }
        return;
      }
      if (isAnswer(parsed)) {
        watching = false;
        return;
      }
    }
  };
  const scan = (eof) => {
    if (isNdjson) {
      const lines = text.split("\n");
      text = eof ? "" : (lines.pop() ?? "");
      const payloads = [];
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          payloads.push(JSON.parse(line));
        } catch {
          // unparseable line: ignore
        }
      }
      inspect(payloads);
      return;
    }
    const norm = text.replace(/\r\n/g, "\n");
    const cut = eof ? norm.length : norm.lastIndexOf("\n\n");
    if (cut < 0) {
      text = norm;
      return;
    }
    text = eof ? "" : norm.slice(cut + 2);
    inspect(parseSseSegment(norm.slice(0, cut)).payloads);
  };
  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!watching) return;
        try {
          text += decoder.decode(chunk, { stream: true });
          scan(false);
          // Bound the watch buffer; a huge frame without a break is not watched.
          if (text.length > DEFAULT_MAX_BYTES) watching = false;
        } catch {
          watching = false;
        }
      },
      flush() {
        if (!watching) return;
        try {
          text += decoder.decode();
          scan(true);
        } catch {
          // ignore
        }
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
