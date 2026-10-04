/**
 * YAN-363 MITM server start-request construction (pure). Mirrors the backend
 * POST contract: hashed local/omitted-credential starts carry no apiKey key;
 * a transient pasted remote key travels only while it was pasted for the
 * exact destination being started (normalized), trimmed, and only when the
 * status says the destination needs one. Legacy builds its exact legacy body.
 */

/** Normalize a destination the same way the server treats bindings: URL without a trailing slash. */
const normalizeDestination = (raw) => {
  try {
    const url = new URL(String(raw ?? "").trim());
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(raw ?? "")
      .trim()
      .replace(/\/+$/, "");
  }
};

/**
 * Bind a pasted key to the destination it was pasted for.
 * @returns {{ key: string, destination: string } | null} null when nothing usable was pasted
 */
export const bindRemoteKey = (rawKey, destination) => {
  const key = String(rawKey ?? "").trim();
  if (!key) return null;
  return { key, destination: normalizeDestination(destination) };
};

/**
 * Build the POST /api/cli-tools/antigravity-mitm body.
 *
 * @param {object} opts
 * @param {boolean} opts.hashed status says hashed storage (non-legacy source)
 * @param {{ needsCredential?: boolean, credentialConfigured?: boolean }} opts.status the GET credential fields
 * @param {string} opts.sudoPassword
 * @param {string} opts.mitmRouterBaseUrl
 * @param {boolean} opts.forceKillPort443
 * @param {{ key: string, destination: string } | null} opts.remoteKeyBinding bindRemoteKey() result captured at paste time
 * @param {string|null} [opts.legacyKey] legacy selected key
 * @param {object|null} [opts.legacyFallback] { firstKey, defaultKey } legacy fallbacks
 * @returns {object} JSON-serializable body; apiKey key present only when it will be sent
 */
export function buildMitmStartBody({
  hashed,
  status,
  sudoPassword,
  mitmRouterBaseUrl,
  forceKillPort443,
  remoteKeyBinding,
  legacyKey,
  legacyFallback,
}) {
  const body = {
    sudoPassword,
    mitmRouterBaseUrl,
    forceKillPort443: Boolean(forceKillPort443),
  };
  if (hashed) {
    const needsKey = status.needsCredential === true || !status.credentialConfigured;
    const target = normalizeDestination(mitmRouterBaseUrl);
    // Only the key pasted for THIS destination travels — never one retained
    // across a URL change, never a default/prefix/ref substitute.
    const key =
      needsKey && remoteKeyBinding && remoteKeyBinding.destination === target
        ? remoteKeyBinding.key
        : undefined;
    if (key !== undefined) body.apiKey = key;
    return body;
  }
  const legacy =
    String(legacyKey ?? "").trim() ||
    legacyFallback?.firstKey ||
    legacyFallback?.defaultKey ||
    null;
  if (legacy !== null && legacy !== undefined) body.apiKey = legacy;
  return body;
}
