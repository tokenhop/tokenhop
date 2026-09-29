/**
 * Pure config/helpers for the media combo detail page (YAN-402).
 * No React, no imports from src/: unit-testable under node.
 */
import { previewAuthHeader } from "@/shared/constants/previewAuth.js";

export const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export const KIND_LABELS = {
  webSearch: "Web search",
  webFetch: "Web fetch",
  image: "Text to image",
  video: "Video",
  tts: "Text to speech",
  stt: "Speech to text",
  embedding: "Embedding",
};

export const EXAMPLE_PATHS = {
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  embedding: "/v1/embeddings",
  video: "/v1/videos/generations",
  stt: "/v1/audio/transcriptions",
};

export const EXAMPLE_BODIES = {
  webSearch: (n) => ({
    model: n,
    query: "What is the latest news about AI?",
    search_type: "web",
    max_results: 5,
  }),
  webFetch: (n) => ({ model: n, url: "https://example.com", format: "markdown" }),
  image: (n) => ({ model: n, prompt: "A cute cat playing piano", n: 1, size: "1024x1024" }),
  tts: (n) => ({ model: n, input: "Hello, this is a test.", voice: "alloy" }),
  embedding: (n) => ({ model: n, input: "The quick brown fox jumps over the lazy dog" }),
  video: (n) => ({ model: n, prompt: "A serene lake at sunset" }),
  stt: (n) => ({ model: n, prompt: "Transcribe this audio" }),
};

/** Map combo.kind to the listing route to go back to. */
export function getListingHref(kind) {
  if (kind === "webSearch" || kind === "webFetch") return "/dashboard/media-providers/web";
  return `/dashboard/media-providers/${kind}`;
}

/** Sentence-case kind label with the same fallbacks as the page. */
export function kindLabelFor(kind, kinds = []) {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  return kinds.find((k) => k.id === kind)?.label || "Combo";
}

/** Parse "providerId/model" or just "providerId" into { providerId, model }. */
export function parseModelEntry(entry) {
  if (typeof entry !== "string") return { providerId: "", model: "" };
  const idx = entry.indexOf("/");
  if (idx < 0) return { providerId: entry, model: "" };
  return { providerId: entry.slice(0, idx), model: entry.slice(idx + 1) };
}

/**
 * Local name validation: mirrors the current page exactly (no trim, exact
 * wording). Differs from shared validateComboName, so do NOT swap it in.
 */
export function validateMediaComboName(value) {
  if (!value?.trim()) return { ok: false, error: "Name is required" };
  if (!VALID_NAME_REGEX.test(value))
    return { ok: false, error: "Only letters, numbers, -, _ and ." };
  return { ok: true, value };
}

/** Mask large b64_json strings to keep the JSON view readable. */
export function maskB64(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskB64);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      k === "b64_json" && typeof v === "string" && v.length > 100
        ? `<${v.length} chars base64>`
        : maskB64(v);
  }
  return out;
}

/** Build the example request body for a combo kind, or null when unknown. */
export function exampleBodyFor(kind, name) {
  if (!kind || !EXAMPLE_BODIES[kind]) return null;
  return EXAMPLE_BODIES[kind](name);
}

/**
 * Build the preview-safe cURL snippet. The live key is never rendered:
 * the line always shows Bearer YOUR_KEY.
 */
export function buildCurl({ origin, kind, name, apiKey }) {
  const path = EXAMPLE_PATHS[kind];
  if (!path || !origin) return "";
  const body = exampleBodyFor(kind, name);
  return (
    `curl -X POST ${origin}${path} \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -H "Authorization: ${previewAuthHeader(apiKey)}" \\\n` +
    `  -d '${JSON.stringify(body)}'`
  );
}
