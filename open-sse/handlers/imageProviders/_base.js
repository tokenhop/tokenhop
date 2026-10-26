// Shared helpers for image provider adapters
import { fetchImageAsBase64 } from "../../translator/concerns/image.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch a provider-returned image URL → { b64, mimeType } via the hardened fetcher
// (private-IP rejection, no redirects, byte cap, magic-byte check, relay refused).
// Returns null when the fetch is refused or fails.
export async function urlToBase64(url, proxyOptions = null) {
  const fetched = await fetchImageAsBase64(url, { proxyOptions });
  if (!fetched) return null;
  return { b64: fetched.url.slice(fetched.url.indexOf(",") + 1), mimeType: fetched.mimeType };
}

// Polling/result URLs come from the provider's response and are fetched with the
// API key. Follow them only over https, on the default port, with no userinfo,
// and on a host `isAllowedHost` accepts; anything else is refused before any
// request is sent. The URL is not echoed in the error.
export function assertProviderUrl(rawUrl, isAllowedHost, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label}: invalid polling URL from provider`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !isAllowedHost(parsed.hostname)
  ) {
    throw new Error(`${label}: polling URL is not on the provider host`);
  }
  return parsed.href;
}

// Credentialed follow-up requests must not follow redirects: a redirect could
// carry a custom key header (e.g. x-key) to another origin.
export const NO_REDIRECT = Object.freeze({ redirect: "error" });

// Provider-supplied failure text for the client: string only, length-capped.
export function upstreamErrorText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 300) : fallback;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
