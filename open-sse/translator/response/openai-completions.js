import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { cleanFimOutput, toCompletionId } from "../concerns/fim.js";

function textChunk(fim, index, text, finishReason) {
  return {
    id: fim.id,
    object: "text_completion",
    created: fim.created,
    model: fim.model,
    choices: [{ index, text, logprobs: null, finish_reason: finishReason }],
  };
}

/**
 * OpenAI chat.completion.chunk → legacy text_completion chunk.
 *
 * ponytail: each choice is buffered and emitted once, cleaned, when it finishes.
 * This trades token-by-token streaming for deterministic cleanup (fences,
 * leaked FIM tokens, prefix/suffix overlap). Upgrade path: emit incrementally
 * while holding back a window long enough to detect a closing fence/overlap.
 */
export function openaiToCompletionsResponse(chunk, state) {
  if (!state.fim) {
    state.fim = {
      id: toCompletionId(chunk?.id),
      created: chunk?.created || Math.floor(Date.now() / 1000),
      model: chunk?.model || state.model,
      buffers: new Map(),
      done: new Set(),
    };
  }
  const fim = state.fim;

  // Flush: emit every choice that never saw a finish_reason.
  if (!chunk) {
    const out = [];
    for (const [index, text] of fim.buffers) {
      if (fim.done.has(index)) continue;
      fim.done.add(index);
      out.push(textChunk(fim, index, cleanFimOutput(text, state.fimContext), "stop"));
    }
    return out.length ? out : null;
  }

  // Upstream error frames pass through so the client sees the failure, not empty text.
  if (chunk.error) {
    // Drop partial text so flush can't follow the error with a fake success chunk.
    fim.buffers.clear();
    return chunk;
  }
  if (chunk.model) fim.model = chunk.model;
  const out = [];
  for (const choice of chunk.choices || []) {
    const index = choice.index ?? 0;
    if (fim.done.has(index)) continue;
    const content = choice.delta?.content;
    const buffered = (fim.buffers.get(index) ?? "") + (typeof content === "string" ? content : "");
    fim.buffers.set(index, buffered);
    if (choice.finish_reason) {
      fim.done.add(index);
      state.finishReason = choice.finish_reason;
      out.push(
        textChunk(fim, index, cleanFimOutput(buffered, state.fimContext), choice.finish_reason),
      );
    }
  }
  return out.length ? out : null;
}

register(FORMATS.OPENAI, FORMATS.OPENAI_COMPLETIONS, null, openaiToCompletionsResponse);
