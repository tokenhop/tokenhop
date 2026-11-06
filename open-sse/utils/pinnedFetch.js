// Pinned outbound request for operator-configured destinations (budget
// webhooks, YAN-1831). Resolves the host once with c-ares (A + AAAA, off the
// libuv threadpool, no /etc/hosts); only with the private-network opt-in does
// a name c-ares does not know fall back to the system resolver (hosts file,
// search domains). Fails closed, rejects the request if any
// record is blocked, then pins the connection to the validated IP so no
// second resolution can rebind it. Redirects are never followed. One deadline
// (`timeoutMs`) bounds the whole attempt: DNS, connect and response.
// Never throws: callers get `{ ok, status?, reason? }`.
import { lookup, Resolver } from "node:dns/promises";
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

// Once one address family answered with addresses, wait at most this long for
// the other before continuing with what we have.
export const DNS_FAMILY_GRACE_MS = 300;
// Resolver answers that mean "no such name here": with the private opt-in the
// system resolver (hosts file, search domains) gets a chance.
const NO_ANSWER = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * A + AAAA for `host` with c-ares within `ms`. Returns `{ records }`,
 * `{ timeout: true }`, or `{ noAnswer }` (no usable records; `noAnswer` is
 * true when every family said "no such name/data" or returned nothing).
 */
function resolveHost(host, ms) {
  const resolver = new Resolver({ timeout: Math.max(1, ms), tries: 1 });
  return new Promise((resolve) => {
    const answers = [];
    let done = false;
    let grace;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      resolver.cancel();
      resolve(value);
    };
    const records = () => answers.flatMap((a) => a.list ?? []);
    const settled = () => {
      const found = records();
      if (answers.length === 2) {
        if (found.length) return finish({ records: found });
        if (answers.some((a) => a.error?.code === "ETIMEOUT")) return finish({ timeout: true });
        return finish({ noAnswer: answers.every((a) => !a.error || NO_ANSWER.has(a.error.code)) });
      }
      if (found.length && !grace) {
        grace = setTimeout(() => finish({ records: records() }), DNS_FAMILY_GRACE_MS);
        grace.unref?.();
      }
    };
    const deadline = setTimeout(() => {
      const found = records();
      finish(found.length ? { records: found } : { timeout: true });
    }, ms);
    deadline.unref?.();
    for (const [query, family] of [
      [resolver.resolve4(host), 4],
      [resolver.resolve6(host), 6],
    ]) {
      query
        .then(
          (list) => answers.push({ list: (list ?? []).map((address) => ({ address, family })) }),
          (error) => answers.push({ error }),
        )
        .then(settled);
    }
  });
}

/** System resolver (hosts file, search domains) within `ms`; private opt-in only. */
async function lookupSystem(host, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), Math.max(1, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([
      lookup(host, { all: true }).then(
        (list) => (list?.length ? { records: list } : { noAnswer: true }),
        () => ({ noAnswer: true }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
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
    let answer = await resolveHost(host, timeoutMs);
    // Hosts-file names (e.g. container extra_hosts) and search-domain short
    // names exist only in the system resolver; consulted only with the
    // private-network opt-in, and its answers pass the same policy below.
    if (answer.noAnswer && allowPrivate) answer = await lookupSystem(host, deadline - Date.now());
    if (answer.timeout) return { ok: false, reason: "timeout" };
    if (!answer.records) return { ok: false, reason: "dns" };
    records = answer.records;
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
