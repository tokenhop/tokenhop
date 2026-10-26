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

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
