// Safe JSON.parse: non-string passthrough; on parse error return caller-chosen `fallback`.
export function safeParseJSON(str, fallback) {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Full JSON parse of an object; `{}` when invalid or not a plain object.
export function parseJSONObject(text) {
  const parsed = safeParseJSON(text, null);
  return isPlainObject(parsed) ? parsed : {};
}

const LITERALS = ["true", "false", "null"];
const NUMBER_CHAR = /[-+.eE0-9]/;
const WHITESPACE = /\s/;
// Deeper nesting stops the scan; what finished above the cap is kept.
const MAX_DEPTH = 256;

// End index of the scalar (string / number / literal) starting at `i`, or -1
// when it is cut off. A number reaching the end may be missing digits.
function scalarEnd(text, i) {
  const ch = text[i];
  if (ch === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j < text.length ? j + 1 : -1;
  }
  if (NUMBER_CHAR.test(ch)) {
    let j = i;
    while (j < text.length && NUMBER_CHAR.test(text[j])) j++;
    return j < text.length ? j : -1;
  }
  const literal = LITERALS.find((word) => text.startsWith(word, i));
  return literal ? i + literal.length : -1;
}

/**
 * Parse a JSON object that may be cut off (tool arguments truncated by
 * max_tokens). Keeps only the values that finished: a cut-off string, literal
 * or key is dropped together with its key. Unlike the Anthropic SDK's
 * partial-JSON parser, a number at the very end is dropped too, since it may be
 * missing digits. An open container is closed. Returns `{}` when nothing
 * finished or the text is not an object. Linear in the input length.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parsePartialJSONObject(text) {
  const full = safeParseJSON(text, undefined);
  if (full !== undefined) return isPlainObject(full) ? full : {};
  if (typeof text !== "string") return {};

  // Last cut point: text up to `cutEnd` plus closers for the first `cutDepth`
  // stack entries. Every pop records a new cut, so those entries still match.
  const stack = []; // { close, keyNext }
  let cutEnd = -1;
  let cutDepth = 0;
  const mark = (end) => {
    cutEnd = end;
    cutDepth = stack.length;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const top = stack.at(-1);
    if (WHITESPACE.test(ch)) i++;
    else if (ch === ":") {
      if (top) top.keyNext = false;
      i++;
    } else if (ch === ",") {
      if (top?.close === "}") top.keyNext = true;
      i++;
    } else if (ch === "{" || ch === "[") {
      if (stack.length >= MAX_DEPTH) break;
      stack.push({ close: ch === "{" ? "}" : "]", keyNext: ch === "{" });
      mark(++i);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      mark(++i);
    } else {
      const end = scalarEnd(text, i);
      if (end < 0) break;
      i = end;
      // A key is only complete once its value is; a top-level scalar is no object.
      if (top && !(top.close === "}" && top.keyNext)) mark(i);
    }
  }

  if (cutEnd < 0) return {};
  let closers = "";
  for (let d = cutDepth - 1; d >= 0; d--) closers += stack[d].close;
  return parseJSONObject(text.slice(0, cutEnd) + closers);
}
