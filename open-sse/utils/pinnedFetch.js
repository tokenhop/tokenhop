// Pinned outbound request for operator-configured destinations (budget
// webhooks, YAN-1831). Resolves the host once with c-ares (A + AAAA, off the
// libuv threadpool, no /etc/hosts), fails closed, rejects the request if any
// record is blocked, then pins the connection to the validated IP so no
// second resolution can rebind it. Redirects are never followed. One deadline
// (`timeoutMs`) bounds the whole attempt: DNS, connect and response.
// Never throws: callers get `{ ok, status?, reason? }`.
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { isEgressAllowedIp } from "./ipPolicy.js";
import { proxyAwareFetch } from "./proxyFetch.js";

const MAX_URL_LENGTH = 2000;

export const ALWAYS_BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "169.254.169.254",
]);

function bareHost(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * Validate a destination URL literally (no DNS).
 * @returns {null | "invalid_url" | "blocked_destination"}
 */
export function egressUrlError(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH)
    return "invalid_url";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid_url";
  if (url.username || url.password || url.hash || raw.includes("#")) return "invalid_url";
  const host = bareHost(url.hostname);
  if (!host) return "invalid_url";
  // Destination first: a blocked host reads as blocked whatever the scheme.
  if (ALWAYS_BLOCKED_HOSTS.has(host)) return "blocked_destination";
  if ((host === "localhost" || host.endsWith(".localhost")) && !allowPrivate)
    return "blocked_destination";
  if (isIP(host) && !isEgressAllowedIp(host, { allowPrivate })) return "blocked_destination";
  if (url.protocol === "http:" && !allowPrivate) return "invalid_url";
  return null;
}

// `localhost` never goes to DNS (c-ares has no /etc/hosts): the loopback literals.
const LOOPBACK = [
  { address: "127.0.0.1", family: 4 },
  { address: "::1", family: 6 },
];

const DNS_TIMEOUT = Symbol("dns-timeout");

/**
 * A + AAAA for `host` within `ms`. Returns records, `DNS_TIMEOUT`, or null
 * (resolver error / empty answer: fail closed).
 */
async function resolveHost(host, ms) {
  const resolver = new Resolver({ timeout: Math.max(1, ms), tries: 1 });
  const settle = (p, family) =>
    p.then(
      (list) => ({ list: (list ?? []).map((address) => ({ address, family })) }),
      (error) => ({ error }),
    );
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DNS_TIMEOUT), ms);
    timer.unref?.();
  });
  try {
    const answers = await Promise.race([
      Promise.all([settle(resolver.resolve4(host), 4), settle(resolver.resolve6(host), 6)]),
      deadline,
    ]);
    if (answers === DNS_TIMEOUT) return DNS_TIMEOUT;
    const records = answers.flatMap((a) => a.list ?? []);
    if (records.length) return records;
    return answers.some((a) => a.error?.code === "ETIMEOUT") ? DNS_TIMEOUT : null;
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}

/**
 * @returns {Promise<{ ok: true, status: number } | { ok: false, reason: string, status?: number }>}
 */
export async function fetchPinned(
  raw,
  { method = "POST", headers, body } = {},
  { allowPrivate = false, timeoutMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const invalid = egressUrlError(raw, { allowPrivate });
  if (invalid) return { ok: false, reason: invalid };
  const url = new URL(raw);
  const host = bareHost(url.hostname);

  let records;
  if (isIP(host)) {
    records = [{ address: host, family: isIP(host) }];
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    records = LOOPBACK;
  } else {
    records = await resolveHost(host, timeoutMs);
    if (records === DNS_TIMEOUT) return { ok: false, reason: "timeout" };
    if (!records) return { ok: false, reason: "dns" };
  }
  if (records.some((r) => !isEgressAllowedIp(r.address, { allowPrivate }))) {
    return { ok: false, reason: "blocked_destination" };
  }

  // Prefer IPv4: IPv4-only proxies and SOCKS tunnels cannot reach an IPv6 pin.
  const first = records.find((r) => r.family === 4) ?? records[0];
  const pinned = { address: first.address, family: first.family };
  const dispatcher = new Agent({
    connect: {
      lookup: (_h, opts, cb) =>
        opts?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
    },
  });

  try {
    const response = await proxyAwareFetch(
      url.href,
      {
        method,
        headers,
        body,
        redirect: "manual",
        dispatcher,
        pinnedAddress: pinned,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      },
      null,
    );
    await response.body?.cancel().catch(() => {});
    const { status } = response;
    if (status >= 300 && status < 400) return { ok: false, reason: "redirect", status };
    if (status < 200 || status >= 300) return { ok: false, reason: "http", status };
    return { ok: true, status };
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  } finally {
    dispatcher.close().catch(() => {});
  }
}
