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
import { isPrivateIp } from "../../utils/ipPolicy.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  MAX_IMAGE_BYTES,
  FETCH_TIMEOUT_MS,
  IMAGE_SIGNATURES,
  BLOCKED_HOSTS,
} from "../../config/mediaConfig.js";

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
 *   proxyAwareFetch. Direct and HTTP(S)/SOCKS proxy connections target the
 *   validated IP; a configured relay (Vercel/Deno/Cloudflare) would resolve
 *   the hostname itself, so the fetch is refused (returns null).
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

  // Pin every connection to the validated IP so no second DNS resolution can
  // rebind (TOCTOU fix). Honour Node's lookup contract for both opts.all forms.
  // Prefer IPv4: IPv4-only proxies and SOCKS tunnels cannot reach an IPv6 pin.
  const first = pinnedIps.find((r) => r.family === 4) ?? pinnedIps[0];
  const pinned = { address: first.address, family: first.family };
  const dispatcher = new Agent({
    connect: {
      lookup: (_h, opts, cb) =>
        opts?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
    },
  });

  try {
    // redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    // pinnedAddress makes a connection or env proxy target the validated IP
    // instead of resolving the hostname itself, and refuses relay routing;
    // strict proxy and relay refusals surface as failure below.
    const response = await proxyAwareFetch(
      url.href,
      { signal: fetchSignal, redirect: "manual", dispatcher, pinnedAddress: pinned },
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
  } catch (error) {
    if (error?.code === "ERR_PINNED_RELAY") {
      console.warn("[image] Remote image URL refused: connection relays cannot fetch images");
    }
    return null;
  } finally {
    dispatcher.close().catch(() => {});
  }
}
