// Format identifiers
export const FORMATS = {
  OPENAI: "openai",
  OPENAI_COMPLETIONS: "openai-completions",
  CODESTRAL_FIM: "codestral-fim",
  LLAMACPP_INFILL: "llamacpp-infill",
  FIM_NATIVE: "fim-native", // upstream prompt/suffix endpoint; not a client format
  OPENAI_RESPONSES: "openai-responses",
  OPENAI_RESPONSE: "openai-response",
  CLAUDE: "claude",
  GEMINI: "gemini",
  GEMINI_CLI: "gemini-cli",
  VERTEX: "vertex",
  CODEX: "codex",
  ANTIGRAVITY: "antigravity",
  KIRO: "kiro",
  CURSOR: "cursor",
  OLLAMA: "ollama",
  COMMANDCODE: "commandcode",
};

const FIM_FORMATS = new Set([
  FORMATS.OPENAI_COMPLETIONS,
  FORMATS.CODESTRAL_FIM,
  FORMATS.LLAMACPP_INFILL,
]);
export const isFimFormat = (format) => FIM_FORMATS.has(format);

/**
 * Detect source format from request URL pathname + body.
 * Returns null to fall back to body-based detection.
 */
export function detectFormatByEndpoint(pathname, body) {
  // /v1/completions (legacy completions) is always openai-completions.
  // Exact path match: must NOT catch /v1/chat/completions. Next rewrites hand
  // the route handler /api/v1/completions, which the endsWith check also covers.
  if (pathname.replace(/\/+$/, "").endsWith("/v1/completions")) return FORMATS.OPENAI_COMPLETIONS;
  if (pathname.replace(/\/+$/, "").endsWith("/v1/fim/completions")) return FORMATS.CODESTRAL_FIM;
  if (/^(?:\/api)?(?:\/v1)?\/infill\/?$/.test(pathname)) return FORMATS.LLAMACPP_INFILL;

  // /v1/responses is always openai-responses
  if (pathname.includes("/v1/responses")) return FORMATS.OPENAI_RESPONSES;

  // /v1/messages is always Claude
  if (pathname.includes("/v1/messages")) return FORMATS.CLAUDE;

  // /v1/chat/completions + input[] → treat as openai (Cursor CLI sends Responses body via chat endpoint)
  if (pathname.includes("/v1/chat/completions") && Array.isArray(body?.input)) {
    return FORMATS.OPENAI;
  }

  return null;
}
