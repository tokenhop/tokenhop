/**
 * Translator: FIM infill client formats → OpenAI Chat Completions.
 * Chat models act as a fill-in-the-middle engine around CURSOR_MARKER.
 *
 * Sources: legacy OpenAI /v1/completions (openai-completions),
 * Mistral Codestral /v1/fim/completions (codestral-fim),
 * llama.cpp /infill (llamacpp-infill). All three pivot to chat messages;
 * their native responses come back through response/fim.js.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE } from "../schema/index.js";
import { CURSOR_MARKER, FIM_TOKENS, parseFimPrompt } from "../concerns/fim.js";

const MAX_STOP = 4;
const PASSTHROUGH = [
  "model",
  "max_tokens",
  "top_p",
  "n",
  "stream_options",
  "user",
  "seed",
  "presence_penalty",
  "frequency_penalty",
];
// ponytail: llama.vim ring-buffers ~16 chunks of ~64 lines; these caps keep a
// hostile body from becoming a multi-MB prompt. Raise if real clients hit them.
const MAX_INPUT_EXTRA = 32;
const MAX_EXTRA_CHUNK_CHARS = 16_000;
const MAX_EXTRA_TOTAL_CHARS = 128_000;
const MAX_N_PREDICT = 4096;
// Window kept around the cursor: prefix tail and suffix head.
const MAX_FIM_SIDE_CHARS = 200_000;

const SYSTEM_PROMPT = [
  "You are a code completion engine.",
  `Return ONLY the text to insert at ${CURSOR_MARKER}.`,
  "Preserve indentation and whitespace exactly.",
  "No markdown fences, no explanations.",
  "Do not repeat text before or after the cursor.",
  "Return an empty response if nothing should be inserted.",
].join("\n");

function cleanStop(stop) {
  const list = (Array.isArray(stop) ? stop : [stop]).filter(
    (s) => typeof s === "string" && s && !FIM_TOKENS.some((token) => s.includes(token)),
  );
  return list.slice(0, MAX_STOP);
}

export function buildFimChatRequest(model, body, stream, { prefix, suffix, context }) {
  prefix = prefix.slice(-MAX_FIM_SIDE_CHARS);
  suffix = suffix.slice(0, MAX_FIM_SIDE_CHARS);
  context = context ? context.slice(0, MAX_FIM_SIDE_CHARS) : context;
  const code = `<code>${prefix}${CURSOR_MARKER}${suffix}</code>`;
  const result = {
    messages: [
      { role: ROLE.SYSTEM, content: SYSTEM_PROMPT },
      { role: ROLE.USER, content: context ? `<context>\n${context}\n</context>\n${code}` : code },
    ],
    temperature: body.temperature ?? 0,
    stream,
  };
  for (const key of PASSTHROUGH) if (body[key] !== undefined) result[key] = body[key];
  if (model) result.model = model;

  const stop = cleanStop(body.stop);
  if (stop.length) result.stop = stop;

  if (body.reasoning_effort !== undefined) result.reasoning_effort = body.reasoning_effort;
  else if (body.reasoning !== undefined) result.reasoning = body.reasoning;
  else if (body.thinking !== undefined) result.thinking = body.thinking;
  else result.reasoning_effort = "none";

  return result;
}

function promptParts(body) {
  let prompt = body.prompt;
  if (Array.isArray(prompt) && prompt.length === 1) prompt = prompt[0];
  if (typeof prompt !== "string") {
    throw new Error("prompt must be a string or an array of exactly one string");
  }
  if (body.suffix != null && typeof body.suffix !== "string") {
    throw new Error("suffix must be a string");
  }
  return parseFimPrompt(prompt, body.suffix);
}

export function completionsToOpenAIRequest(model, body, stream, credentials) {
  return buildFimChatRequest(model, body, stream, promptParts(body));
}

export function codestralToOpenAIRequest(model, body, stream, credentials) {
  const parts = promptParts(body);
  // Mistral vendor knob: random_seed (used by Continue); seed wins when both set.
  const mapped =
    body.seed === undefined && body.random_seed !== undefined
      ? { ...body, seed: body.random_seed }
      : body;
  return buildFimChatRequest(model, mapped, stream, parts);
}

// llama.cpp puts `prompt` AFTER the FIM_MID token: the current-line text
// before the cursor. Context entries join as plain `// File: name` text —
// never as <|file_sep|> FIM tokens, which parseFimPrompt would strip.
function joinInputExtra(inputExtra) {
  if (!Array.isArray(inputExtra)) return "";
  const out = [];
  let total = 0;
  for (const e of inputExtra.slice(0, MAX_INPUT_EXTRA)) {
    if (!e || typeof e.text !== "string") continue;
    const name = typeof e.filename === "string" ? e.filename.slice(0, 256) : "";
    const text = e.text.slice(0, MAX_EXTRA_CHUNK_CHARS);
    const chunk = name ? `// File: ${name}\n${text}` : text;
    if (total + chunk.length > MAX_EXTRA_TOTAL_CHARS) break;
    total += chunk.length + 1;
    out.push(chunk);
  }
  return out.join("\n");
}

export function llamacppToOpenAIRequest(model, body, stream, credentials) {
  for (const key of ["input_prefix", "input_suffix", "prompt"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  if (body.input_extra !== undefined && !Array.isArray(body.input_extra)) {
    throw new Error("input_extra must be an array");
  }
  const prefix = `${body.input_prefix ?? ""}${body.prompt ?? ""}`;
  const suffix = body.input_suffix ?? "";
  const context = joinInputExtra(body.input_extra);
  const mapped = { ...body };
  // Vendor knob: n_predict (llama.cpp); only a positive value sizes the reply.
  if (body.n_predict !== undefined && body.n_predict !== null) {
    if (!Number.isFinite(body.n_predict)) throw new Error("n_predict must be a finite number");
    // n_predict <= -1 is llama.cpp's "unlimited": cap it rather than leave generation open.
    if (mapped.max_tokens === undefined && body.n_predict !== 0) {
      mapped.max_tokens =
        body.n_predict > 0
          ? Math.min(Math.floor(body.n_predict), MAX_N_PREDICT) || 1
          : MAX_N_PREDICT;
    }
    delete mapped.n_predict;
  }
  return buildFimChatRequest(model, mapped, stream, {
    prefix,
    suffix,
    context,
    format: "llamacpp",
  });
}

register(FORMATS.OPENAI_COMPLETIONS, FORMATS.OPENAI, completionsToOpenAIRequest, null);
register(FORMATS.CODESTRAL_FIM, FORMATS.OPENAI, codestralToOpenAIRequest, null);
register(FORMATS.LLAMACPP_INFILL, FORMATS.OPENAI, llamacppToOpenAIRequest, null);
