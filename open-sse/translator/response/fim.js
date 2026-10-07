/**
 * OpenAI chat (intermediate pivot) → FIM client formats:
 * - Codestral /v1/fim/completions (chat.completion.chunk / chat.completion)
 * - llama.cpp /infill ({content, stop:true} chunks / JSON body)
 *
 * ponytail: reuses the buffered cleanup of openaiToCompletionsResponse
 * (deterministic fence/token/overlap trimming), then restates its one chunk
 * per finished choice. Same tradeoff: token-by-token streaming swapped for
 * deterministic cleanup; upgrade path holds back a trailing window.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiToCompletionsResponse } from "./openai-completions.js";

// text_completion chunk (from openaiToCompletionsResponse) → chat.completion.chunk
function openaiToCodestralResponse(chunk, state) {
  const converted = openaiToCompletionsResponse(chunk, state);
  if (!converted) return null;
  const items = Array.isArray(converted) ? converted : [converted];
  const out = [];
  for (const item of items) {
    if (item?.error) return item; // error frames pass through unchanged
    const choice = item.choices?.[0];
    if (!choice || typeof choice.index !== "number") continue;
    out.push({
      id: item.id.replace(/^cmpl-/, "chatcmpl-"),
      object: "chat.completion.chunk",
      created: item.created,
      model: item.model,
      choices: [
        {
          index: choice.index,
          delta: { role: "assistant", content: choice.text },
          finish_reason: choice.finish_reason,
        },
      ],
    });
  }
  return out.length ? out : null;
}

// text_completion chunk → llama.cpp {content, stop:true} (final text, one per choice)
function openaiToLlamacppResponse(chunk, state) {
  const converted = openaiToCompletionsResponse(chunk, state);
  if (!converted) return null;
  const items = Array.isArray(converted) ? converted : [converted];
  if (items.length === 1 && items[0]?.error) return items[0];
  const out = [];
  for (const item of items) {
    const choice = item.choices?.[0];
    if (!choice || typeof choice.index !== "number") continue;
    out.push({ content: choice.text, stop: true });
  }
  return out.length ? out : null;
}

register(FORMATS.OPENAI, FORMATS.CODESTRAL_FIM, null, openaiToCodestralResponse);
register(FORMATS.OPENAI, FORMATS.LLAMACPP_INFILL, null, openaiToLlamacppResponse);

export { openaiToCodestralResponse, openaiToLlamacppResponse };
