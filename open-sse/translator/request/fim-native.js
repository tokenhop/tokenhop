/**
 * Translator: FIM client formats → native prompt/suffix endpoints
 * (target format "fim-native": Mistral /v1/fim/completions, DeepSeek
 * /beta/completions). Only used when the model has capability fim:true and the
 * provider declares a "fim-native" transport — otherwise the chat-FIM wrapper
 * (openai-completions.js) handles the request. Template context (input_extra,
 * parseFimPrompt context) is prepended to the prompt as plain text.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import {
  FIM_MAX_PREFIX_CHARS,
  FIM_MAX_SUFFIX_CHARS,
  FIM_MAX_CONTEXT_CHARS,
  FIM_DEFAULT_MAX_TOKENS,
} from "../../config/runtimeConfig.js";
import {
  promptParts,
  cleanStop,
  mapNPredictToMaxTokens,
  joinInputExtra,
} from "./openai-completions.js";

// DeepSeek /beta/completions historically rejects max_tokens above 4K.
const DEEPSEEK_FIM_MAX_TOKENS = 4096;

export function buildFimNativeRequest(model, body, stream, { prefix, suffix, context }, vendor) {
  prefix = prefix.slice(-FIM_MAX_PREFIX_CHARS);
  suffix = suffix.slice(0, FIM_MAX_SUFFIX_CHARS);
  // Native endpoints take prompt/suffix only, so other-file context leads the
  // prompt (the repo-level FIM layout). Cleanup only reads the prefix tail.
  context = context ? context.slice(0, FIM_MAX_CONTEXT_CHARS) : "";
  let maxTokens = body.max_tokens ?? body.max_completion_tokens ?? FIM_DEFAULT_MAX_TOKENS;
  if (vendor === "deepseek") maxTokens = Math.min(maxTokens, DEEPSEEK_FIM_MAX_TOKENS);
  const out = {
    model,
    prompt: context ? `${context}\n${prefix}` : prefix,
    temperature: body.temperature ?? 0,
    stream: !!stream,
    max_tokens: maxTokens,
  };
  if (suffix) out.suffix = suffix;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  const stop = cleanStop(body.stop);
  if (stop.length) out.stop = stop;
  // Mistral vendor knob: random_seed (used by Continue); seed wins when both set.
  if (vendor === "mistral") {
    const seed = body.seed ?? body.random_seed;
    if (seed !== undefined) out.random_seed = seed;
  }
  // DeepSeek usage arrives only on request; the final chunk otherwise omits it.
  if (vendor === "deepseek" && stream) out.stream_options = { include_usage: true };
  return out;
}

// chatCore sets credentials.runtimeTransport to the resolved "fim-native"
// transport; its fimVendor selects the vendor knobs above.
const fimVendor = (credentials) => credentials?.runtimeTransport?.fimVendor;

export function completionsToFimNativeRequest(model, body, stream, credentials) {
  return buildFimNativeRequest(model, body, stream, promptParts(body), fimVendor(credentials));
}

export function codestralToFimNativeRequest(model, body, stream, credentials) {
  return completionsToFimNativeRequest(model, body, stream, credentials);
}

export function llamacppToFimNativeRequest(model, body, stream, credentials) {
  for (const key of ["input_prefix", "input_suffix", "prompt"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  if (body.input_extra !== undefined && !Array.isArray(body.input_extra)) {
    throw new Error("input_extra must be an array");
  }
  const mapped = mapNPredictToMaxTokens(body);
  return buildFimNativeRequest(
    model,
    mapped,
    stream,
    {
      prefix: `${body.input_prefix ?? ""}${body.prompt ?? ""}`,
      suffix: body.input_suffix ?? "",
      context: joinInputExtra(body.input_extra),
    },
    fimVendor(credentials),
  );
}

register(FORMATS.OPENAI_COMPLETIONS, FORMATS.FIM_NATIVE, completionsToFimNativeRequest, null);
register(FORMATS.CODESTRAL_FIM, FORMATS.FIM_NATIVE, codestralToFimNativeRequest, null);
register(FORMATS.LLAMACPP_INFILL, FORMATS.FIM_NATIVE, llamacppToFimNativeRequest, null);
