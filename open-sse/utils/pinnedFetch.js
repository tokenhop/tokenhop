// Pinned outbound request for operator-configured destinations (budget
// webhooks, YAN-1831). Resolves the host once, fails closed, rejects the
// request if any record is blocked, then pins the connection to the validated
// IP so no second resolution can rebind it. Redirects are never followed.
// Never throws: callers get `{ ok, status?, reason? }`.
import { lookup } from "node:dns/promises";
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

/**
 * @returns {Promise<{ ok: true, status: number } | { ok: false, reason: string, status?: number }>}
 */
export async function fetchPinned(
  raw,
  { method = "POST", headers, body } = {},
  { allowPrivate = false, timeoutMs = 5000 } = {},
) {
  const invalid = egressUrlError(raw, { allowPrivate });
  if (invalid) return { ok: false, reason: invalid };
  const url = new URL(raw);
  const host = bareHost(url.hostname);

  let records;
  if (isIP(host)) {
    records = [{ address: host, family: isIP(host) }];
  } else {
    try {
      records = await lookup(host, { all: true });
    } catch {
      return { ok: false, reason: "dns" };
    }
    if (!records?.length) return { ok: false, reason: "dns" };
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
        signal: AbortSignal.timeout(timeoutMs),
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
