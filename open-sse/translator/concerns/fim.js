export const CURSOR_MARKER = "<|cursor|>";

export const FIM_TOKENS = [
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|fim_pad|>",
  "<|endoftext|>",
  "<|file_separator|>",
  "<|file_sep|>",
  "<|repo_name|>",
  "<fim_prefix>",
  "<fim_suffix>",
  "<fim_middle>",
  "<PRE>",
  "<SUF>",
  "<MID>",
  "<EOT>",
  "<｜fim▁begin｜>",
  "<｜fim▁hole｜>",
  "<｜fim▁end｜>",
  "[PREFIX]",
  "[SUFFIX]",
  "[MIDDLE]",
  "<|code_prefix|>",
  "<|code_suffix|>",
  "<|code_middle|>",
  "</s>",
  "<|im_end|>",
];

// [format, open, middle, close]: open{first}middle{second}close. Codestral is
// suffix-first and has no closing token. indexOf parsing keeps this linear on
// untrusted multi-hundred-KB prompts (regex backtracking was quadratic).
const TEMPLATES = [
  ["qwen", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"],
  ["star_coder", "<fim_prefix>", "<fim_suffix>", "<fim_middle>"],
  ["code_llama", "<PRE> ", " <SUF>", " <MID>"],
  ["deepseek_coder", "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>"],
  ["codestral", "[SUFFIX]", "[PREFIX]", ""],
  ["glm", "<|code_prefix|>", "<|code_suffix|>", "<|code_middle|>"],
];

export function parseFimPrompt(prompt, suffix) {
  prompt = typeof prompt === "string" ? prompt : "";
  suffix = typeof suffix === "string" ? suffix : "";
  const plain = { prefix: prompt, suffix, format: "plain", context: "" };
  for (const [format, open, middle, close] of TEMPLATES) {
    const start = prompt.indexOf(open);
    if (start < 0) continue;
    const context = prompt.slice(0, start).replace(/<\|(?:file_sep|repo_name)\|>/g, "");
    // Other template markers before this one indicate malformed/unknown input.
    if (FIM_TOKENS.some((token) => context.includes(token))) return plain;
    const body = prompt.slice(start + open.length);
    const split = body.indexOf(middle);
    if (split < 0 || !body.endsWith(close)) return plain;
    const first = body.slice(0, split);
    const second = body.slice(split + middle.length, body.length - close.length);
    return format === "codestral"
      ? { prefix: second, suffix: first, format, context }
      : { prefix: first, suffix: second, format, context };
  }
  if (suffix && !FIM_TOKENS.some((token) => prompt.includes(token))) {
    return { ...plain, format: "suffix" };
  }
  return plain;
}

// "chatcmpl-abc" → "cmpl-abc"; legacy completions ids use the cmpl- prefix.
export function toCompletionId(id) {
  const raw = typeof id === "string" && id ? id.replace(/^chatcmpl-/, "") : `${Date.now()}`;
  return raw.startsWith("cmpl-") ? raw : `cmpl-${raw}`;
}

// Prefix/suffix of a legacy completions client body, for response cleanup.
export function fimContextFor(body) {
  const prompt = Array.isArray(body?.prompt) ? body.prompt[0] : body?.prompt;
  return parseFimPrompt(prompt, body?.suffix);
}

// Echo overlaps longer than this are not plausible; bounding the scan keeps
// cleanup O(MAX_OVERLAP^2) instead of O(n^2) on whole-file prefixes.
const MAX_OVERLAP = 2048;
const isWord = (ch) => ch !== undefined && /\w/.test(ch);

// Longest overlap where `left` ends with what `right` starts with. Accept it only
// when it ends at a newline, or spans >= 10 chars without splitting a word on
// either side; short or mid-identifier matches are ambiguous and stay.
function overlapLength(left, right) {
  for (let size = Math.min(left.length, right.length, MAX_OVERLAP); size > 0; size--) {
    const overlap = right.slice(0, size);
    if (!left.endsWith(overlap)) continue;
    if (overlap.endsWith("\n")) return size;
    const before = left[left.length - size - 1];
    const after = right[size];
    const splitsWord =
      (isWord(before) && isWord(overlap[0])) || (isWord(after) && isWord(overlap.at(-1)));
    if (size >= 10 && !splitsWord) return size;
  }
  return 0;
}

// `</s>` also appears in real markup, so it is a stop token but never a cut point.
const CUT_TOKENS = FIM_TOKENS.filter((token) => token !== "</s>");

export function cleanFimOutput(text, options = {}) {
  if (typeof text !== "string") return "";
  const prefix = typeof options?.prefix === "string" ? options.prefix : "";
  const suffix = typeof options?.suffix === "string" ? options.suffix : "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^\s*<think>[\s\S]*$/, "");
  if (/^```[^\r\n]*\r?\n/.test(text)) {
    text = text.replace(/^```[^\r\n]*\r?\n/, "").replace(/\r?\n```[ \t]*(?:\r?\n)?$/, "");
  }
  for (const token of CUT_TOKENS) {
    const index = text.indexOf(token);
    if (index >= 0) text = text.slice(0, index);
  }
  text = text.replaceAll(CURSOR_MARKER, "");
  text = text.slice(overlapLength(prefix, text));
  // Cursor sits in indentation: the client inserts at the cursor, so a reply
  // that repeats that indentation would double it (YAN-741).
  const indent = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (/^[ \t]+$/.test(indent) && text.startsWith(indent)) text = text.slice(indent.length);
  const overlap = overlapLength(text, suffix);
  return overlap ? text.slice(0, -overlap) : text;
}
