/**
 * DOM-free decisions for the OAuth modal. Fetch, timers, and window stay in
 * the hook; this module only classifies inputs and picks the next step.
 */

export const PROXY_OAUTH_PROVIDERS = new Set(["trae", "windsurf", "zed"]);

export const DEVICE_CODE_PROVIDERS = new Set([
  "github",
  "kiro",
  "kimi",
  "kimi-coding",
  "kilocode",
  "codebuddy-cn",
  "codebuddy-intl",
  "qoder",
  "grok-cli",
  "meta-code",
  "cursor",
]);

const DEFAULT_DEVICE_TIMEOUT_MS = 120_000;

/** @param {string} hostname */
export function isLocalhostHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Redirect URI the authorize call must advertise.
 * @param {string} provider
 * @param {string} port `location.port` (empty when the browser omits it)
 * @param {string} protocol `location.protocol`
 */
export function buildRedirectUri(provider, port, protocol) {
  if (provider === "codex") return "http://localhost:1455/auth/callback";
  if (provider === "xai") return "http://127.0.0.1:56121/callback";
  const appPort = port || (protocol === "https:" ? "443" : "80");
  return `http://localhost:${appPort}/callback`;
}

/**
 * Extra body the device-code poll needs so the server can persist the
 * machine/client material it issued with the code.
 * @param {string} provider
 * @param {Record<string, unknown>} data device-code response
 */
export function buildDeviceExtraData(provider, data) {
  if (provider === "kiro") {
    return {
      _clientId: data._clientId,
      _clientSecret: data._clientSecret,
      _region: data._region,
      _authMethod: data._authMethod,
      _startUrl: data._startUrl,
    };
  }
  if (provider === "qoder") {
    return {
      _qoderNonce: data._qoderNonce,
      _qoderMachineId: data._qoderMachineId,
      _qoderVerifier: data.codeVerifier,
    };
  }
  if (provider === "kimi" || provider === "kimi-coding") {
    return { _kimiDeviceId: data._kimiDeviceId };
  }
  return null;
}

/** Milliseconds to poll before "Authorization timeout". */
export function devicePollTimeoutMs(expiresIn) {
  return Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_DEVICE_TIMEOUT_MS;
}

/** @param {number} interval seconds @param {boolean} slowDown */
export function nextDevicePollInterval(interval, slowDown) {
  if (!slowDown) return interval;
  return Math.min(interval + 5, 30);
}

/**
 * @param {Record<string, unknown>} data poll JSON
 * @returns {{kind:"done"}|{kind:"slow-down"}|{kind:"fatal",message:string}|{kind:"pending"}}
 */
export function classifyDevicePoll(data) {
  if (data.success) return { kind: "done" };
  if (data.error === "expired_token" || data.error === "access_denied") {
    return { kind: "fatal", message: data.errorDescription || data.error };
  }
  if (data.error === "slow_down") return { kind: "slow-down" };
  return { kind: "pending" };
}

/**
 * Which provider's poll-status endpoint to hit, or null when this auth
 * payload is not a server-side proxy session.
 * @param {Record<string, unknown>|null|undefined} authData
 */
export function resolveProxyPollProvider(authData) {
  if (!authData?.state) return null;
  if (authData.codexServerSide) return "codex";
  if (authData.xaiServerSide) return "xai";
  if (authData.proxyProvider) return authData.proxyProvider;
  return null;
}

/** @param {Record<string, unknown>} authData */
export function buildProxyRegisterBody(authData) {
  const body = { state: authData.state };
  if (authData.codeVerifier) body.codeVerifier = authData.codeVerifier;
  if (authData.systemId) body.systemId = authData.systemId;
  return body;
}

/** postMessage origins the callback listener accepts. */
export function isTrustedCallbackOrigin(eventOrigin, locationOrigin) {
  if (typeof eventOrigin !== "string" || !eventOrigin) return false;
  if (eventOrigin === locationOrigin) return true;
  let parsed;
  try {
    parsed = new URL(eventOrigin);
  } catch {
    return false;
  }
  if (parsed.origin !== eventOrigin) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Guard for an in-flight OAuth start flow after an await boundary: when the
 * modal closed mid-flight, the close effect owns proxy cleanup, so the stale
 * flow must stop without touching state or starting new requests.
 * @param {{ current: boolean }} isOpenRef
 */
export function flowCancelled(isOpenRef) {
  return !isOpenRef?.current;
}

/**
 * Classify a pasted callback / code / token. Caller already handled paste-token mode.
 * @param {string} provider
 * @param {string} input trimmed
 * @returns {{kind:"exchange",code:string,state:string|null}|{kind:"xai-manual",code:string}|{kind:"proxy-manual",code:string}|{kind:"error",message:string}}
 */
export function parseManualCallback(provider, input) {
  if (PROXY_OAUTH_PROVIDERS.has(provider) && input) {
    return { kind: "proxy-manual", code: input };
  }
  if (input.startsWith("eyJ") && input.includes(".")) {
    return { kind: "exchange", code: input, state: null };
  }
  if (
    provider === "xai" &&
    input &&
    !input.includes("://") &&
    !input.includes("?") &&
    !input.includes("code=")
  ) {
    return { kind: "xai-manual", code: input };
  }
  if (provider === "kimchi" && input && !input.includes("://") && !input.includes("?")) {
    return { kind: "exchange", code: input, state: null };
  }
  let url;
  try {
    url = new URL(input);
  } catch (err) {
    return { kind: "error", message: err.message };
  }
  const code = url.searchParams.get("code");
  const token = url.searchParams.get("token");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return { kind: "error", message: url.searchParams.get("error_description") || errorParam };
  }
  if (!code && !token) {
    const message =
      provider === "xai"
        ? "Paste the callback URL or copied xAI code"
        : provider === "kimchi"
          ? "No Kimchi token found in URL"
          : "No authorization code found in URL";
    return { kind: "error", message };
  }
  return { kind: "exchange", code: token || code, state };
}

/**
 * Kiro Google/GitHub callback paste. `state` is parsed by the URL but the
 * exchange body never sends it.
 * @param {string} callbackUrl
 * @returns {{kind:"code",code:string}|{kind:"error",message:string}}
 */
export function parseSocialCallback(callbackUrl) {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { kind: "error", message: "Invalid callback URL format" };
  }
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return { kind: "error", message: url.searchParams.get("error_description") || errorParam };
  }
  if (!code) return { kind: "error", message: "No authorization code found in URL" };
  return { kind: "code", code };
}
