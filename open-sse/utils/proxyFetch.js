import { Readable } from "stream";
import { isIPv6 } from "node:net";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();
// Mirror src/lib/network/relayTemplates.js: open-sse must not depend on src/.
export const RELAY_TEMPLATE_VERSION = 2;
export const RELAY_TEMPLATE_VERSION_HEADER = "x-relay-version";
const RELAY_PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000;
const RELAY_PROBE_FAILURE_TTL_MS = 60 * 1000;
const outdatedRelayWarnings = new Set();
const relayVersionCache = new Map();
const relayProbePending = new Map();
const RELAY_PROBE_TIMEOUT_MS = 5000;

function relayVersion(response) {
  const raw = response.headers.get(RELAY_TEMPLATE_VERSION_HEADER);
  if (raw === null) return 0;
  const version = Number(raw);
  return Number.isFinite(version) ? version : 0;
}

function warnOutdatedRelay(relayUrl) {
  if (outdatedRelayWarnings.has(relayUrl)) return;
  outdatedRelayWarnings.add(relayUrl);
  // Never print the configured URL: it may contain credentials or query tokens.
  console.warn("[ProxyFetch] Relay template is outdated and must be redeployed");
}

function outdatedRelayError() {
  return Object.assign(
    new Error("[ProxyFetch] Relay template is outdated and must be redeployed"),
    {
      code: "ERR_RELAY_OUTDATED",
    },
  );
}

function relayRequestFailed(cause) {
  return new Error("[ProxyFetch] Relay request failed", { cause });
}

function wrapRelayRequestError(error, options) {
  if (options.signal?.aborted || error?.name === "AbortError") return error;
  if (options.redirect === "error" && isRefusedRedirect(error)) return error;
  return relayRequestFailed(error);
}

function throwIfProbeAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function raceProbeCaller(pending, signal) {
  throwIfProbeAborted(signal);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfProbeAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function fetchRelayVersion(relayUrl) {
  const signal = AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS);
  try {
    const response = await originalFetch(relayUrl, { method: "GET", headers: {}, signal });
    const version = relayVersion(response);
    await response.body?.cancel().catch(() => {});
    relayVersionCache.set(relayUrl, {
      version,
      expiresAt:
        Date.now() +
        (version >= RELAY_TEMPLATE_VERSION
          ? RELAY_PROBE_SUCCESS_TTL_MS
          : RELAY_PROBE_FAILURE_TTL_MS),
    });
    return version;
  } catch (error) {
    relayVersionCache.delete(relayUrl);
    throw relayRequestFailed(error);
  }
}

/**
 * Probe a deployed relay without forwarding any caller data. The versioned
 * templates answer this missing-target probe with 400 plus x-relay-version.
 * Only an answered probe is cached; caller aborts and transport failures are not.
 * @param {string} relayUrl
 * @param {{ signal?: AbortSignal, fresh?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function probeRelayVersion(relayUrl, { signal, fresh = false } = {}) {
  throwIfProbeAborted(signal);
  const cached = relayVersionCache.get(relayUrl);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.version;
  let pending = fresh ? null : relayProbePending.get(relayUrl);
  if (!pending) {
    pending = fetchRelayVersion(relayUrl).finally(() => {
      if (relayProbePending.get(relayUrl) === pending) relayProbePending.delete(relayUrl);
    });
    if (!fresh) relayProbePending.set(relayUrl, pending);
  }
  return raceProbeCaller(pending, signal);
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    // Exact host or a dot-suffix subdomain — never a substring (so
    // "api2.cursor.sh.other.example" does not match "api2.cursor.sh").
    return MITM_BYPASS_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const patterns = noProxy
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return null;
  }

  if (protocol === "https:") {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
    );
  }

  return (
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {
    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

// Dispatch options for a request whose connection must target an address the
// caller already validated (SSRF pinning). The proxy is asked for the IP
// literal, so it cannot resolve the hostname a second time; the Host header and
// TLS SNI/certificate checks keep using the real hostname.
function pinnedOriginOptions(opts, targetUrl, pinnedAddress) {
  const ip = isIPv6(pinnedAddress.address) ? `[${pinnedAddress.address}]` : pinnedAddress.address;
  const port = targetUrl.port ? `:${targetUrl.port}` : "";
  const headers = {};
  const source = opts.headers;
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i += 2) headers[source[i]] = source[i + 1];
  } else if (source) {
    Object.assign(headers, source);
  }
  for (const name of Object.keys(headers)) if (name.toLowerCase() === "host") delete headers[name];
  headers.host = targetUrl.host;
  return {
    ...opts,
    origin: `${targetUrl.protocol}//${ip}${port}`,
    headers,
    ...(targetUrl.protocol === "https:" ? { servername: targetUrl.hostname } : {}),
  };
}

// Fetch through proxyUrl with the connection pinned to pinnedAddress. Uses a
// per-request ProxyAgent so requestTls.servername can carry the real hostname:
// SOCKS5 tunnels take SNI from requestTls only, never from the request.
async function pinnedProxyFetch(url, options, proxyUrl, pinnedAddress) {
  const target = new URL(url);
  // undici's SOCKS5 agent sends a bracketed IPv6 origin as a domain name, so an
  // IPv6 pin cannot be honoured through SOCKS; refuse instead of going unpinned.
  if (/^socks/i.test(new URL(proxyUrl).protocol) && isIPv6(pinnedAddress.address)) {
    throw new Error("[ProxyFetch] SOCKS proxy cannot target a pinned IPv6 address");
  }
  const { ProxyAgent } = await import("undici");
  const agent = new ProxyAgent({
    uri: proxyUrl,
    ...(target.protocol === "https:" ? { requestTls: { servername: target.hostname } } : {}),
  });
  const dispatcher = agent.compose((dispatch) => (opts, handler) => {
    // Only the validated origin may be dispatched (no cross-origin redirect hops).
    if (opts.origin && new URL(opts.origin).origin !== target.origin) {
      throw new Error("[ProxyFetch] Pinned request cannot leave its validated origin");
    }
    return dispatch(pinnedOriginOptions(opts, target, pinnedAddress), handler);
  });
  try {
    return await originalFetch(url, { ...options, dispatcher });
  } finally {
    // Graceful close: an in-flight response body keeps streaming to the end.
    agent.close().catch(() => {});
  }
}

// Fetch through proxyUrl: pinned when the caller validated the address,
// otherwise through the shared cached dispatcher.
async function fetchViaProxy(url, options, proxyUrl, pinnedAddress) {
  if (pinnedAddress)
    return pinnedProxyFetch(url, options, normalizeProxyUrl(proxyUrl), pinnedAddress);
  const dispatcher = await getDispatcher(proxyUrl);
  return originalFetch(url, { ...options, dispatcher });
}

// True when undici refused a redirect for a redirect: "error" request.
function isRefusedRedirect(error) {
  return error?.cause?.message === "unexpected redirect";
}
function refusedRedirectError(cause) {
  return Object.assign(
    new TypeError('[ProxyFetch] Redirect refused (redirect: "error")', { cause }),
    {
      code: "ERR_REDIRECT_REFUSED",
    },
  );
}

// Statuses whose Response must not carry a body (WHATWG Response constructor throws).
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS).
 * Resolves a real WHATWG Response (clone/text/json/arrayBuffer share one body
 * stream) and honors options.signal before connect, during the request and
 * while the body streams.
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;
  const { signal } = options;
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let req = null;
    let res = null;
    const onAbort = () => {
      const reason = signal.reason;
      // Erroring the response stream propagates the abort to body readers.
      res?.destroy(reason);
      req?.destroy(reason);
      socket.destroy(reason);
      reject(reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", onAbort));

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      req = https.request(reqOptions, (incoming) => {
        res = incoming;
        // Response() throws on statuses outside 200-599 or bad headers; this
        // callback runs outside the executor, so reject instead of throwing.
        try {
          const body = NULL_BODY_STATUSES.has(res.statusCode) ? null : Readable.toWeb(res);
          resolve(
            new Response(body, {
              status: res.statusCode,
              statusText: res.statusMessage || "",
              headers: toHeaders(res.headers),
            }),
          );
          if (!body) res.resume();
        } catch (error) {
          res.destroy();
          reject(error);
        }
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

/**
 * fetch with connection-proxy, env-proxy and Vercel-relay support.
 * options.pinnedAddress ({ address, family }) marks a request whose host was
 * already validated: through an HTTP(S) proxy, or a SOCKS proxy for IPv4, the
 * connection targets that address instead of letting the proxy resolve the
 * hostname again. Such a request must also pass options.dispatcher pinned to
 * the same address for the direct path, and redirect:"manual" so no hop can
 * reach another origin. A relay resolves the hostname itself and cannot be
 * pinned, so a pinned request through a relay is refused. When relaying, the
 * caller's redirect mode is forwarded to the relay in the x-relay-redirect
 * header so the relay can honor it.
 */
export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const pinnedAddress = options?.pinnedAddress ?? null;
  if (pinnedAddress && (!options.dispatcher || options.redirect !== "manual")) {
    throw Object.assign(
      new TypeError(
        '[ProxyFetch] pinnedAddress requires a pinned dispatcher and redirect: "manual"',
      ),
      { code: "ERR_PINNED_MISUSE" },
    );
  }

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    // The relay would resolve the hostname again, defeating the validation.
    if (pinnedAddress) {
      throw Object.assign(
        new Error("[ProxyFetch] A pinned request cannot be sent through a connection relay"),
        { code: "ERR_PINNED_RELAY" },
      );
    }
    const parsed = new URL(targetUrl);
    // Caller headers may be a plain object, Headers or tuple array. Drop any
    // x-relay-* header (any casing) so only the gateway sets relay control.
    const relayHeaders = {};
    for (const [name, value] of new Headers(options.headers ?? undefined)) {
      if (!name.toLowerCase().startsWith("x-relay-")) relayHeaders[name] = value;
    }
    relayHeaders["x-relay-target"] = `${parsed.protocol}//${parsed.host}`;
    relayHeaders["x-relay-path"] = `${parsed.pathname}${parsed.search}`;
    if (typeof options.redirect === "string") relayHeaders["x-relay-redirect"] = options.redirect;
    // A caller-supplied dispatcher targets the original host; it must not be
    // used to reach the relay, which is a different origin.
    const { dispatcher: _droppedDispatcher, ...relayOptions } = options;
    if (options.redirect === "error" || options.redirect === "manual") {
      if (
        (await probeRelayVersion(vercelRelayUrl, { signal: options.signal })) <
        RELAY_TEMPLATE_VERSION
      ) {
        warnOutdatedRelay(vercelRelayUrl);
        throw outdatedRelayError();
      }
    }
    try {
      const response = await originalFetch(vercelRelayUrl, {
        ...relayOptions,
        headers: relayHeaders,
      });
      if (relayVersion(response) < RELAY_TEMPLATE_VERSION) warnOutdatedRelay(vercelRelayUrl);
      return response;
    } catch (relayError) {
      const wrapped = wrapRelayRequestError(relayError, options);
      if (wrapped !== relayError) throw wrapped;
      if (options.redirect === "error" && isRefusedRedirect(relayError)) {
        throw refusedRedirectError(relayError);
      }
      throw relayError;
    }
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // Pool id + target host in fallback warnings so operators can find the failing pool.
  const poolId = normalizeString(proxyOptions?.connectionProxyPoolId) || "none";
  let targetHost = targetUrl;
  try {
    targetHost = new URL(targetUrl).host;
  } catch {
    /* keep raw url */
  }
  const fallbackCtx = ` (pool=${poolId}, target=${targetHost})`;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof.
  // A caller-supplied dispatcher already controls connection DNS — respect it.
  if (!options.dispatcher && shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        return await fetchViaProxy(url, options, proxyUrl, null);
      } catch (proxyError) {
        // An aborted request keeps its own error and is never retried.
        if (options.signal?.aborted) throw proxyError;
        if (options.redirect === "error" && isRefusedRedirect(proxyError)) {
          throw refusedRedirectError(proxyError);
        }
        if (proxyOptions?.strictProxy === true) {
          throw new Error(
            `[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`,
          );
        }
        console.warn(
          `[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}${fallbackCtx}`,
        );
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      // An aborted request must not be retried through the fallback fetch.
      if (options.signal?.aborted) throw error;
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      return await fetchViaProxy(url, options, proxyUrl, pinnedAddress);
    } catch (proxyError) {
      // An aborted request keeps its own error and is never retried.
      if (options.signal?.aborted) throw proxyError;
      if (options.redirect === "error" && isRefusedRedirect(proxyError)) {
        throw refusedRedirectError(proxyError);
      }
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        throw new Error(
          `[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`,
        );
      }
      console.warn(
        `[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}${fallbackCtx}`,
      );
      return originalFetch(url, options);
    }
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return originalFetch(url, options);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
