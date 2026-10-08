/**
 * Upstream native FIM (prompt/suffix endpoint) → OpenAI chat.
 *
 * DeepSeek /beta/completions returns legacy text_completion chunks
 * (choices[].text); Mistral /v1/fim/completions already returns openai
 * chat-chunk shape. Both normalize to openai chat so the existing
 * openai→{completions,codestral,llamacpp} translators keep doing
 * cleanFimOutput, client shape, [DONE] and usage.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

function textToChatChunk(chunk, state) {
  // Keep one `created` across the stream when upstream omits it.
  state.fimNative ??= { created: chunk?.created || Math.floor(Date.now() / 1000) };
  const created = chunk?.created || state.fimNative.created;
  const model = chunk?.model || state?.model;
  return {
    id: chunk?.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created,
    model,
    choices: (chunk.choices || []).map((choice) => ({
      index: choice.index ?? 0,
      delta: {
        ...(typeof choice.text === "string" ? { content: choice.text } : {}),
      },
      finish_reason: choice.finish_reason ?? null,
    })),
    ...(chunk.usage ? { usage: chunk.usage } : {}),
  };
}

export function fimNativeToOpenAI(chunk, state) {
  if (!chunk || typeof chunk !== "object" || chunk.error) return chunk;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  // Text-shaped (DeepSeek): choices carry `text`, no delta/message.
  if (choices.length && choices.some((c) => typeof c?.text === "string")) {
    return textToChatChunk(chunk, state);
  }
  // Chat-shaped (Mistral): already openai chat chunks; pass through.
  return chunk;
}

// Non-stream: text_completion body → chat.completion; chat-shaped passes through.
export function normalizeFimNativeBody(body) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  if (body && choices.length && choices.some((c) => typeof c?.text === "string")) {
    const usage = body.usage;
    return {
      id: body.id?.replace?.(/^cmpl-/, "chatcmpl-") || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: body.created || Math.floor(Date.now() / 1000),
      model: body.model,
      choices: choices.map((c, i) => ({
        index: c.index ?? i,
        message: { role: "assistant", content: c.text ?? "" },
        finish_reason: c.finish_reason ?? "stop",
      })),
      // Unknown usage stays absent; the client-format step fills its own defaults.
      ...(usage ? { usage } : {}),
    };
  }
  return body;
}

register(FORMATS.FIM_NATIVE, FORMATS.OPENAI, null, fimNativeToOpenAI);
