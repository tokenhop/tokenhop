// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { isIP, BlockList } from "node:net";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  MAX_IMAGE_BYTES,
  FETCH_TIMEOUT_MS,
  IMAGE_SIGNATURES,
  BLOCKED_HOSTS,
} from "../../config/mediaConfig.js";

// IPs that must never be fetched (SSRF guard). BlockList semantics replace the
// hand-rolled prefix checks and cover ::/128, deprecated ::/96, fec0::/10,
// multicast, TEST-NET, reserved ranges, etc.
const BLOCKED_SUBNETS = new BlockList();
const blockSubnet = (cidr, family) => {
  const [address, prefix] = cidr.split("/");
  BLOCKED_SUBNETS.addSubnet(address, Number(prefix), family);
};
for (const subnet of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/29",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
])
  blockSubnet(subnet, "ipv4");
for (const subnet of [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
])
  blockSubnet(subnet, "ipv6");

// Expand an IPv6 address (optionally with a dotted IPv4 tail) to 8 hextets.
function expandIPv6(ip) {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ""] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = text.includes("::") && tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.length === 8 ? parts.map((part) => Number.parseInt(part || "0", 16)) : null;
}

// BlockList only matches v4-mapped v6 against v6 ranges. Canonicalize every
// ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (translated) spelling to dotted
// IPv4 so it is checked against the v4 ranges.
function normalizeIPv4Mapped(ip) {
  if (isIP(ip) !== 6) return ip;
  const h = expandIPv6(ip);
  if (!h) return ip;
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const translated = h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0;
  if (!mapped && !translated) return ip;
  return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join(".");
}

// True if an IPv4/IPv6 address is private/reserved (SSRF target).
export function isPrivateIp(ip) {
  const normalized = normalizeIPv4Mapped(ip || "");
  const family = isIP(normalized);
  if (!family) return true;
  try {
    return BLOCKED_SUBNETS.check(normalized, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return true; // unparseable address → do not fetch.
  }
}

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
export function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (
      verifyWebp &&
      !(
        buf.length >= 12 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      )
    )
      continue;
    return mime;
  }
  return null;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on any failure or rejection.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes, proxyOptions }
 *   proxyOptions: optional connection proxy settings forwarded to
 *   proxyAwareFetch; without a proxy the request uses the pinned dispatcher.
 * @returns {Promise<{url: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const {
    signal,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_IMAGE_BYTES,
    proxyOptions,
  } = options;
  let url;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const pinnedIps = await resolvePinnedIps(url.hostname);
  if (!pinnedIps) return null;

  // Always bound the fetch; also honour caller cancellation.
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  // Pin connect to the validated IP so no second DNS resolution can rebind (TOCTOU fix).
  const dispatcher = new Agent({
    connect: {
      lookup: (_h, _o, cb) =>
        cb(null, [{ address: pinnedIps[0].address, family: pinnedIps[0].family }]),
    },
  });

  try {
    // redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    // Direct connections are validated above and pinned to the resolved IP via
    // the dispatcher; strict proxy errors surface as failure below.
    const response = await proxyAwareFetch(
      url.href,
      { signal: fetchSignal, redirect: "manual", dispatcher },
      proxyOptions ?? null,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return null;
    }

    // Stream-read with a hard byte cap to avoid loading huge payloads into memory.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null; // not a recognized image — reject disguised payloads

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType };
  } catch {
    return null;
  } finally {
    dispatcher.close().catch(() => {});
  }
}
