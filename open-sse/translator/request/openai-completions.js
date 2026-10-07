/**
 * Translator: legacy OpenAI /v1/completions → OpenAI Chat Completions.
 * Chat models act as a fill-in-the-middle engine around CURSOR_MARKER.
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

export function completionsToOpenAIRequest(model, body, stream, credentials) {
  let prompt = body.prompt;
  if (Array.isArray(prompt) && prompt.length === 1) prompt = prompt[0];
  if (typeof prompt !== "string") {
    throw new Error("prompt must be a string or an array of exactly one string");
  }
  if (body.suffix != null && typeof body.suffix !== "string") {
    throw new Error("suffix must be a string");
  }

  const { prefix, suffix, context } = parseFimPrompt(prompt, body.suffix);
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

register(FORMATS.OPENAI_COMPLETIONS, FORMATS.OPENAI, completionsToOpenAIRequest, null);
