/**
 * Preview-safe auth constants for rendered/copied cURL snippets (YAN-305).
 * Security: previews must always show `Bearer YOUR_KEY` — the live key is
 * only ever sent in the fetch Authorization header, never rendered or copied.
 * Pure module (no JSX) so unit tests can import it under node.
 */
export const PREVIEW_API_KEY_PLACEHOLDER = "YOUR_KEY";
export const PREVIEW_AUTH_HEADER = `Bearer ${PREVIEW_API_KEY_PLACEHOLDER}`;

/**
 * Build the Authorization preview line for a cURL snippet.
 * The `apiKey` argument is intentionally ignored: it exists only so callers
 * do not need to branch, and passing a live key here can never leak it into
 * rendered or copied output.
 *
 * @param {string} [_apiKey] Ignored; never rendered.
 * @returns {string} `Bearer YOUR_KEY`
 */
export function previewAuthHeader(_apiKey) {
  void _apiKey;
  return PREVIEW_AUTH_HEADER;
}

/**
 * Mask a dashboard API key for read-only display.
 * Shows at most the first 4 characters plus bullets, so a rendered row can
 * never expose enough of the secret to be reusable. Empty input renders as
 * the "No key configured" fallback handled by callers.
 *
 * @param {string} apiKey Live key (never rendered verbatim).
 * @returns {string} Masked display value.
 */
export function maskPreviewApiKey(apiKey) {
  if (!apiKey) return "";
  const visible = apiKey.slice(0, Math.min(4, apiKey.length));
  const hidden = "•".repeat(Math.min(16, Math.max(0, apiKey.length - visible.length)));
  return `${visible}${hidden}`;
}
