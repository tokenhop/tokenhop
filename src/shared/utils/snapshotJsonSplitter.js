// YAN-1013: bounded-memory splitter for instance snapshot JSON.
//
// A byte-level state machine over the top-level object. It works on raw UTF-8
// bytes (never decodes while scanning), so multibyte sequences split across
// chunk boundaries are harmless: every structural character is ASCII and can
// never occur inside a multibyte sequence. Only a complete value is handed to
// the consumer, as the exact JSON text of that value; the consumer decodes it
// (see parseSnapshotValue) and runs JSON.parse.
//
// - Values of keys that are not kept are skipped without buffering.
// - Keys in `streamedArrays` whose value is an array are cut element by element.
// - Pure ESM, no Node imports: usable in the browser.
//
// Scope of validation: the top-level grammar and the array-element grammar are
// checked here (separators, truncation, trailing data, duplicate keys). The
// inside of a value is only string/escape/bracket-depth tracked; bytes of
// kept values are validated by the consumer's TextDecoder + JSON.parse, and
// skipped values are not validated at all.

export const SNAPSHOT_JSON_INVALID = "SNAPSHOT_JSON_INVALID";
export const DEFAULT_MAX_ELEMENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_KEPT_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const BUF_RETAIN_BYTES = 1024 * 1024;
const BOM = [0xef, 0xbb, 0xbf];

const MESSAGES = {
  not_object: "Snapshot JSON must be an object",
  truncated: "Snapshot JSON is truncated",
  trailing: "Snapshot JSON has trailing data",
  duplicate_key: "Snapshot JSON has a duplicate top-level key",
  element_too_large: "Snapshot JSON element is too large",
  head_too_large: "Snapshot JSON head is too large",
  syntax: "Snapshot JSON is malformed",
  utf8: "Snapshot JSON is not valid UTF-8",
};

function invalid(reason, detail) {
  const message = detail ? `${MESSAGES[reason]}: ${detail}` : MESSAGES[reason];
  return Object.assign(new Error(message), { code: SNAPSHOT_JSON_INVALID, reason });
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode one emitted value (fatal UTF-8) and JSON.parse it. */
export function parseSnapshotValue(bytes) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw invalid("utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("syntax", "invalid JSON value");
  }
}

const isWs = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

// States.
const S_BOM = 0;
const S_START = 1;
const S_KEY_FIRST = 2;
const S_KEY_NEXT = 3;
const S_KEY = 4;
const S_COLON = 5;
const S_VALUE_START = 6;
const S_VALUE = 7;
const S_AFTER_VALUE = 8;
const S_ELEM_FIRST = 9;
const S_ELEM_NEXT = 10;
const S_ELEM_AFTER = 11;
const S_DONE = 12;

// Value targets and kinds.
const T_KEPT = 0;
const T_SKIP = 1;
const T_ELEM = 2;
const VK_STR = 0;
const VK_CONT = 1;
const VK_SCALAR = 2;

/**
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.streamedArrays] keys whose array value is cut per element
 * @param {(key: string) => boolean} [opts.keepKey] false = skip the value unbuffered (default: keep all)
 * @param {(key: string, bytes: Uint8Array) => void} [opts.onValue] a kept top-level value
 *   (also a non-array value of a streamed key; the consumer rejects it)
 * @param {(key: string, bytes: Uint8Array) => void} [opts.onElement] one element of a streamed array
 * @param {(key: string) => void} [opts.onArrayStart] a streamed key opened its array (also when empty)
 * @param {(key: string) => void} [opts.onArrayEnd] a streamed array closed
 * @param {number} [opts.maxElementBytes] per-element cap (default 8 MiB)
 * @param {number} [opts.maxKeptBytes] cap for kept head values + key names (default 64 MiB)
 * @returns {{ write(chunk: Uint8Array): void, end(): void }}
 */
export function createSnapshotSplitter(opts = {}) {
  const {
    keepKey = () => true,
    onValue,
    onElement,
    onArrayStart,
    onArrayEnd,
    maxElementBytes = DEFAULT_MAX_ELEMENT_BYTES,
    maxKeptBytes = DEFAULT_MAX_KEPT_BYTES,
  } = opts;
  const streamed =
    opts.streamedArrays instanceof Set ? opts.streamedArrays : new Set(opts.streamedArrays || []);

  let state = S_BOM;
  let bomIdx = 0;
  let key = null;
  const seen = new Set();
  let keptTotal = 0;
  let target = T_KEPT;
  let vk = VK_STR;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let dead = null;

  // Collector for the key / value / element currently being cut.
  let collecting = false;
  let collKind = "value";
  let collLimit = 0;
  let collBuf = null;
  let collLen = 0;
  let segStart = 0;
  let cur = null;

  const limitError = () => invalid(collKind === "element" ? "element_too_large" : "head_too_large");

  function startCollect(i, kind, limit) {
    collecting = true;
    collKind = kind;
    collLimit = limit;
    collLen = 0;
    segStart = i;
  }

  function append(from, to) {
    const add = to - from;
    if (add <= 0) return;
    const need = collLen + add;
    if (!collBuf || collBuf.length < need) {
      const grown = new Uint8Array(Math.max(need, collBuf ? collBuf.length * 2 : 256));
      if (collBuf) grown.set(collBuf.subarray(0, collLen));
      collBuf = grown;
    }
    collBuf.set(cur.subarray(from, to), collLen);
    collLen = need;
  }

  // Returns a fresh copy of the collected bytes ending at `endExclusive` of `cur`.
  function take(endExclusive) {
    const total = collLen + (endExclusive - segStart);
    if (total > collLimit) throw limitError();
    let out;
    if (collLen === 0) {
      out = cur.slice(segStart, endExclusive);
    } else {
      append(segStart, endExclusive);
      out = collBuf.slice(0, collLen);
    }
    collecting = false;
    collLen = 0;
    if (collBuf && collBuf.length > BUF_RETAIN_BYTES) collBuf = null;
    return out;
  }

  function finishKey(endExclusive) {
    const bytes = take(endExclusive);
    const name = parseSnapshotValue(bytes);
    if (typeof name !== "string") throw invalid("syntax", "object key is not a string");
    if (seen.has(name)) throw invalid("duplicate_key", JSON.stringify(name.slice(0, 80)));
    keptTotal += bytes.length;
    if (keptTotal > maxKeptBytes) throw invalid("head_too_large");
    seen.add(name);
    key = name;
    state = S_COLON;
  }

  function finishValue(endExclusive) {
    if (target === T_SKIP) {
      // nothing buffered
    } else {
      const bytes = take(endExclusive);
      if (target === T_ELEM) {
        onElement?.(key, bytes);
      } else {
        keptTotal += bytes.length;
        onValue?.(key, bytes);
      }
    }
    state = target === T_ELEM ? S_ELEM_AFTER : S_AFTER_VALUE;
  }

  // Begin a value whose first byte is cur[i]; the caller then advances past it.
  function beginValue(i, nextTarget) {
    const b = cur[i];
    if (b === COMMA || b === COLON || b === RBRACE || b === RBRACKET)
      throw invalid("syntax", "unexpected character");
    target = nextTarget;
    if (target === T_ELEM) startCollect(i, "element", maxElementBytes);
    else if (target === T_KEPT) startCollect(i, "value", maxKeptBytes - keptTotal);
    esc = false;
    inStr = false;
    depth = 0;
    if (b === QUOTE) vk = VK_STR;
    else if (b === LBRACE || b === LBRACKET) {
      vk = VK_CONT;
      depth = 1;
    } else vk = VK_SCALAR;
    state = S_VALUE;
  }

  function run(chunk) {
    cur = chunk;
    const n = chunk.length;
    let i = 0;
    while (i < n) {
      const b = chunk[i];
      switch (state) {
        case S_BOM:
          if (b === BOM[bomIdx]) {
            i++;
            if (++bomIdx === 3) state = S_START;
          } else if (bomIdx === 0) state = S_START;
          else throw invalid("syntax", "bad byte order mark");
          break;
        case S_START:
          if (isWs(b)) i++;
          else if (b === LBRACE) {
            i++;
            state = S_KEY_FIRST;
          } else throw invalid("not_object");
          break;
        case S_KEY_FIRST:
        case S_KEY_NEXT:
          if (isWs(b)) i++;
          else if (b === QUOTE) {
            startCollect(i, "key", Math.min(MAX_KEY_BYTES, maxKeptBytes - keptTotal));
            esc = false;
            state = S_KEY;
            i++;
          } else if (b === RBRACE && state === S_KEY_FIRST) {
            i++;
            state = S_DONE;
          } else throw invalid("syntax", "expected an object key");
          break;
        case S_KEY:
          while (i < n) {
            const c = chunk[i++];
            if (esc) esc = false;
            else if (c === BACKSLASH) esc = true;
            else if (c === QUOTE) {
              finishKey(i);
              break;
            }
          }
          break;
        case S_COLON:
          if (isWs(b)) i++;
          else if (b === COLON) {
            i++;
            state = S_VALUE_START;
          } else throw invalid("syntax", "expected ':'");
          break;
        case S_VALUE_START:
          if (isWs(b)) i++;
          else if (b === LBRACKET && streamed.has(key)) {
            i++;
            onArrayStart?.(key);
            state = S_ELEM_FIRST;
          } else {
            beginValue(i, streamed.has(key) || keepKey(key) ? T_KEPT : T_SKIP);
            i++;
          }
          break;
        case S_ELEM_FIRST:
          if (isWs(b)) i++;
          else if (b === RBRACKET) {
            i++;
            onArrayEnd?.(key);
            state = S_AFTER_VALUE;
          } else {
            beginValue(i, T_ELEM);
            i++;
          }
          break;
        case S_ELEM_NEXT:
          if (isWs(b)) i++;
          else {
            beginValue(i, T_ELEM);
            i++;
          }
          break;
        case S_ELEM_AFTER:
          if (isWs(b)) i++;
          else if (b === COMMA) {
            i++;
            state = S_ELEM_NEXT;
          } else if (b === RBRACKET) {
            i++;
            onArrayEnd?.(key);
            state = S_AFTER_VALUE;
          } else throw invalid("syntax", "expected ',' or ']'");
          break;
        case S_AFTER_VALUE:
          if (isWs(b)) i++;
          else if (b === COMMA) {
            i++;
            state = S_KEY_NEXT;
          } else if (b === RBRACE) {
            i++;
            state = S_DONE;
          } else throw invalid("syntax", "expected ',' or '}'");
          break;
        case S_DONE:
          if (isWs(b)) i++;
          else throw invalid("trailing");
          break;
        case S_VALUE:
          if (vk === VK_STR) {
            while (i < n) {
              const c = chunk[i++];
              if (esc) esc = false;
              else if (c === BACKSLASH) esc = true;
              else if (c === QUOTE) {
                finishValue(i);
                break;
              }
            }
          } else if (vk === VK_CONT) {
            while (i < n) {
              const c = chunk[i++];
              if (inStr) {
                if (esc) esc = false;
                else if (c === BACKSLASH) esc = true;
                else if (c === QUOTE) inStr = false;
              } else if (c === QUOTE) inStr = true;
              else if (c === LBRACE || c === LBRACKET) depth++;
              else if ((c === RBRACE || c === RBRACKET) && --depth === 0) {
                finishValue(i);
                break;
              }
            }
          } else if (isWs(b) || b === COMMA || b === RBRACE || b === RBRACKET) {
            finishValue(i); // delimiter is not part of the scalar; reprocessed next
          } else i++;
          break;
        default:
          throw invalid("syntax");
      }
    }
    if (collecting) {
      if (collLen + (n - segStart) > collLimit) throw limitError();
      append(segStart, n);
      segStart = 0;
    }
    cur = null;
  }

  return {
    write(chunk) {
      if (dead) throw dead;
      let bytes = chunk;
      if (!(bytes instanceof Uint8Array)) {
        if (ArrayBuffer.isView(chunk))
          bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        else if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
        else throw new TypeError("Snapshot splitter expects Uint8Array chunks");
      }
      try {
        run(bytes);
      } catch (err) {
        dead = err;
        throw err;
      }
    },
    end() {
      if (dead) throw dead;
      if (state !== S_DONE) {
        dead = invalid("truncated");
        throw dead;
      }
    },
  };
}

async function forEachChunk(source, fn) {
  const toBytes = (c) => {
    if (c instanceof Uint8Array) return c;
    if (typeof c === "string") return new TextEncoder().encode(c);
    if (ArrayBuffer.isView(c)) return new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
    if (c instanceof ArrayBuffer) return new Uint8Array(c);
    throw new TypeError("Snapshot source yielded a non-binary chunk");
  };
  if (source && typeof source.getReader === "function") {
    // Web ReadableStream (async iteration is missing in some browsers).
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fn(toBytes(value));
      }
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        // already failed
      }
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // pending read after cancel
      }
    }
    return;
  }
  if (source && (source[Symbol.asyncIterator] || source[Symbol.iterator])) {
    for await (const chunk of source) fn(toBytes(chunk));
    return;
  }
  throw new TypeError("Snapshot source must be an async iterable or a ReadableStream");
}

/**
 * Skip-mode convenience: read the whole source in O(head) memory and return an
 * object containing only `keys` (parsed). Throws SNAPSHOT_JSON_INVALID when the
 * document is not a well-formed snapshot object (truncated, trailing data, ...).
 *
 * @param {AsyncIterable<Uint8Array>|ReadableStream<Uint8Array>} source
 * @param {{ keys: string[], maxKeptBytes?: number }} options
 */
export async function readSnapshotHead(source, { keys, maxKeptBytes } = {}) {
  const want = new Set(keys || []);
  const out = {};
  const splitter = createSnapshotSplitter({
    keepKey: (k) => want.has(k),
    onValue(k, bytes) {
      Object.defineProperty(out, k, {
        value: parseSnapshotValue(bytes),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    },
    ...(maxKeptBytes ? { maxKeptBytes } : {}),
  });
  await forEachChunk(source, (chunk) => splitter.write(chunk));
  splitter.end();
  return out;
}
