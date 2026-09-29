/**
 * Pure builders for the generic media example card (YAN-402). No JSX, no
 * hooks — safe to import in node unit tests. Behaviour mirrors the original
 * inline derivations in `GenericExampleCard.js`.
 */
import { previewAuthHeader } from "@/shared/constants/previewAuth";

export const CLOUDFLARE_TEST_IMAGE_URL =
  "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog.png";
export const CLOUDFLARE_TEST_MASK_URL =
  "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog-mask.png";

/** Kinds that need a model identifier in the request (image/video/music). Module scope — not recreated per render. */
export const KIND_NEEDS_MODEL = new Set(["image", "video", "music", "imageToText"]);

/** Image-edit placeholder defaults for cloudflare test models. */
export function getImageEditDefaults(providerId, modelId) {
  if (providerId !== "cloudflare-ai") return {};
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-img2img") {
    return { image: CLOUDFLARE_TEST_IMAGE_URL };
  }
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-inpainting") {
    return { image: CLOUDFLARE_TEST_IMAGE_URL, mask_image: CLOUDFLARE_TEST_MASK_URL };
  }
  return {};
}

/** Accept data:, http(s): and bare base64 image values; normalise bare values to a data URL. */
export function toImagePreviewSrc(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  if (/^(data:image\/|https?:\/\/)/i.test(trimmed)) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

/**
 * Build the request model id. webSearch/webFetch always use the provider
 * alias; media kinds append the selected model when present.
 */
export function buildGenericModelFull({ alias, needsModel, selectedModel, allowManualModel }) {
  if (!needsModel) return alias;
  if (selectedModel) return `${alias}/${selectedModel}`;
  return allowManualModel ? "" : alias;
}

/** Keep only non-empty extra fields; NaN numbers are dropped. */
export function buildExtraBody(extraValues = {}) {
  return Object.entries(extraValues).reduce((acc, [k, v]) => {
    if (v === "" || v === null || v === undefined) return acc;
    if (typeof v === "number" && Number.isNaN(v)) return acc;
    acc[k] = v;
    return acc;
  }, {});
}

/** Merge model + body key + static/extra fields + edit images into the request body. */
export function buildGenericRequestBody({
  modelFull,
  input,
  bodyKey,
  extraBody = {},
  extraValues = {},
  supportsEdit,
  supportsMask,
  effectiveRefImage,
  effectiveMaskImage,
}) {
  return {
    model: modelFull,
    [bodyKey]: input,
    ...extraBody,
    ...buildExtraBody(extraValues),
    ...(supportsEdit && effectiveRefImage ? { image: effectiveRefImage } : {}),
    ...(supportsMask && effectiveMaskImage ? { mask_image: effectiveMaskImage } : {}),
  };
}

/**
 * Build the preview-safe cURL snippet. The rendered/copied output always
 * shows `Bearer YOUR_KEY`; the live key only goes in the fetch header.
 */
export function buildGenericCurl({
  method,
  endpoint,
  apiPathWithQuery,
  apiKey,
  pinnedConnectionId,
  useStreaming,
  wantBinary,
  body,
}) {
  const connectionLine = pinnedConnectionId
    ? ` \\\n  -H "x-connection-id: ${pinnedConnectionId}"`
    : "";
  const streamLine = useStreaming ? ` \\\n  -H "Accept: text/event-stream"` : "";
  return `curl -X ${method} ${endpoint}${apiPathWithQuery} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: ${previewAuthHeader(apiKey)}"${connectionLine}${streamLine} \\
  -d '${JSON.stringify(body)}'${wantBinary ? " \\\n  --output image.png" : ""}`;
}

/**
 * Filter extra fields by model params. Kinds without a model concept
 * (no kind models) show every field; others show only declared params.
 */
export function visibleExtraFields(extraFields = [], kindModels = [], modelObj) {
  return extraFields.filter(
    (f) =>
      kindModels.length === 0 ||
      (Array.isArray(modelObj?.params) && modelObj.params.includes(f.key)),
  );
}

/**
 * Parse complete SSE `event:/data:` blocks out of a stream buffer.
 * Returns `{ events, rest }`; `rest` keeps the trailing incomplete chunk
 * for the next read. Data lines without an `event:` line are skipped.
 * Malformed JSON payloads are skipped (original stream handler used an
 * empty catch here too).
 */
export function parseSseBlocks(buf) {
  const events = [];
  let rest = buf;
  let sep = rest.indexOf("\n\n");
  while (sep !== -1) {
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let type = null;
    let dataStr = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (type) {
      try {
        events.push({ type, payload: dataStr ? JSON.parse(dataStr) : {} });
      } catch {
        // Skip unparseable payloads, mirroring the original empty catch.
      }
    }
    sep = rest.indexOf("\n\n");
  }
  return { events, rest };
}

/** Mask long `b64_json` strings in a result tree so the JSON view stays readable. */
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

/** Single image source for the generic result preview + download link (was duplicated). */
export function resultImageSrc(binaryImageUrl, result) {
  if (binaryImageUrl) return binaryImageUrl;
  const first = result?.data?.data?.[0];
  if (!first) return "";
  if (first.b64_json) return `data:image/png;base64,${first.b64_json}`;
  return first.url || "";
}
