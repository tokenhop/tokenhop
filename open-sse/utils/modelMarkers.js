// Claude Code appends a bracketed context marker to the model name when the
// 1M-context beta is toggled on: `claude-opus-5` becomes `claude-opus-5[1m]`.
// The marker is a client-side annotation, not part of any model id: it never
// matches a combo name, an alias or a `provider/model` pair, so a request that
// carries it dies at model resolution with "Invalid model format".
//
// The marker is stripped only so the model resolves. tokenhop rebuilds the
// upstream `Anthropic-Beta` itself and never forwards the client's, so
// `context-1m-2025-08-07` is not sent: on many subscription plans that beta
// bills the request to extra usage. Current Claude models serve 1M context
// natively without it.

const CONTEXT_MARKER = /\[1m\]$/i;

// Returns { model, contextMarker } — contextMarker is null when there is none.
export function stripModelContextMarker(modelStr) {
  if (typeof modelStr !== "string") return { model: modelStr, contextMarker: null };
  const trimmed = modelStr.trim();
  const match = trimmed.match(CONTEXT_MARKER);
  if (!match) return { model: modelStr, contextMarker: null };
  return {
    model: trimmed.slice(0, -match[0].length),
    contextMarker: match[0].slice(1, -1).toLowerCase(),
  };
}
