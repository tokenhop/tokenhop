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

import { hasMeaningfulToken } from "./streamHelpers.js";

const DEFAULT_MAX_BYTES = 262144;
const DEFAULT_MAX_MS = 10 * 1000;

function isMeaningful(parsed) {
  try {
    return hasMeaningfulToken(parsed);
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
 * @returns {Promise<{outcome:"release"|"empty"|"error", response?, error?}>}
 */
export async function probeStreamHead(
  response,
  { maxBytes = DEFAULT_MAX_BYTES, maxMs = DEFAULT_MAX_MS } = {},
) {
  if (!response.body) return { outcome: "release", response };

  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  const isNdjson = contentType.includes("ndjson") && !contentType.includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered = [];
  let bufferedBytes = 0;
  let text = "";

  const release = (pending = null) => ({
    outcome: "release",
    response: replayResponse(response, buffered, reader, pending),
  });
  // Not awaited: cancel of a tee()'d branch only resolves once every branch
  // cancels, and the upstream abort runs through the stream's own cancel hook.
  const reject = (error) => {
    reader.cancel().catch(() => {});
    return error ? { outcome: "error", error } : { outcome: "empty" };
  };

  // Classify one parsed frame: "meaningful" | { error } | null (keep going).
  const judge = (parsed) => {
    if (isErrorFrame(parsed)) return { error: errorMessage(parsed, "stream error") };
    return isMeaningful(parsed) ? "meaningful" : null;
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
  const verdictOf = (v) => (v === "done" ? reject() : reject(v.error));

  for (;;) {
    const read = reader.read();
    let timer;
    let r;
    try {
      r = await Promise.race([
        read,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch (err) {
      clearTimeout(timer);
      return reject(err?.message || String(err) || "stream error");
    }
    clearTimeout(timer);

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
