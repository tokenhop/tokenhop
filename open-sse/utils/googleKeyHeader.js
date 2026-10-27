// Google API keys travel in x-goog-api-key, never the URL: proxy relays log
// pathname+search (YAN-1629). fetch rejects header values with CR/LF/NUL and
// echoes the whole value in its error, so refuse them here with a message that
// does not contain the key.
const INVALID_HEADER_CHARS = /[\r\n\0]/;

export function googleKeyHeader(apiKey) {
  const key = String(apiKey ?? "");
  if (INVALID_HEADER_CHARS.test(key)) {
    throw new Error("Google API key contains invalid characters (line break or NUL)");
  }
  return { "x-goog-api-key": key };
}
