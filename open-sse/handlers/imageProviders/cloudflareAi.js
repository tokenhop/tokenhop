import { nowSec } from "./_base.js";
import { fetchImageBytes } from "../../translator/concerns/image.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["cloudflare-ai"]?.imageConfig?.baseUrl;

const MULTIPART_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
]);

const OPTIONAL_FIELDS = ["negative_prompt", "guidance", "seed", "num_steps", "steps", "strength"];

function sizeToDimensions(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!match) return {};
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function getDimensions(body) {
  return {
    ...sizeToDimensions(body.size),
    ...(Number.isFinite(Number(body.width)) ? { width: Number(body.width) } : {}),
    ...(Number.isFinite(Number(body.height)) ? { height: Number(body.height) } : {}),
  };
}

// Resolve a caller-supplied image (byte array, data URL, bare base64, or
// http(s) URL) to `{ buf }` or `{ b64 }`, whichever the input already is, so
// no value is decoded or encoded more than once. URLs go through the hardened
// image fetcher.
async function resolveImageInput(value, proxyOptions) {
  if (Array.isArray(value)) return { buf: Buffer.from(value) };
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("http://") || trimmed.toLowerCase().startsWith("https://")) {
    // Validate and fetch through the hardened image fetcher (DNS pinning,
    // private-IP rejection, no redirects, byte cap, magic-byte check).
    const fetched = await fetchImageBytes(trimmed, { proxyOptions });
    if (!fetched) throw new Error("Image input URL could not be fetched");
    return { buf: fetched.buf };
  }
  const match = /^data:image\/[^;]+;base64,(.+)$/i.exec(trimmed);
  return { b64: match ? match[1] : trimmed };
}

function addOptionalFields(target, body, append) {
  for (const key of OPTIONAL_FIELDS) {
    const value = body[key];
    if (value === undefined || value === null || value === "") continue;
    append(target, key, value);
  }
}

async function buildJsonBody(body, proxyOptions) {
  const req = { prompt: body.prompt, ...getDimensions(body) };

  addOptionalFields(req, body, (target, key, value) => {
    target[key] = value;
  });

  // Each input is sent once, in the one field Workers AI reads for it: the
  // source image as `image_b64` (base64 string) and the mask as `mask`
  // (uint8 array; the schema has no base64 mask field).
  const image = await resolveImageInput(body.image, proxyOptions);
  if (image) req.image_b64 = image.b64 ?? image.buf.toString("base64");

  const mask = await resolveImageInput(
    body.mask_image || body.maskImage || body.mask,
    proxyOptions,
  );
  if (mask) req.mask = Array.from(mask.buf ?? Buffer.from(mask.b64, "base64"));

  return req;
}

function buildMultipartBody(body) {
  const form = new FormData();
  form.append("prompt", body.prompt);

  const dimensions = getDimensions(body);
  for (const [key, value] of Object.entries(dimensions)) {
    form.append(key, String(value));
  }

  addOptionalFields(form, body, (target, key, value) => {
    target.append(key, String(value));
  });

  return form;
}

function imageItemFromString(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^data:image\/[^;]+;base64,/i.test(value)) {
    return { b64_json: value.replace(/^data:image\/[^;]+;base64,/i, "") };
  }
  if (/^https?:\/\//i.test(value)) return { url: value };
  return { b64_json: value };
}

function normalizeCloudflareResponse(responseBody) {
  if (responseBody?.created && Array.isArray(responseBody?.data)) return responseBody;

  const result = responseBody?.result ?? responseBody;
  const queuedResponse = Array.isArray(result?.responses)
    ? result.responses.find((item) => item?.success !== false)?.result
    : null;
  if (queuedResponse) return normalizeCloudflareResponse(queuedResponse);

  const image =
    (typeof result === "string" ? result : null) ||
    result?.image ||
    result?.data?.[0]?.b64_json ||
    result?.data?.[0]?.url;

  const item = imageItemFromString(image);
  return {
    created: nowSec(),
    data: item ? [item] : [],
  };
}

export default {
  buildUrl: (model, creds) => {
    const accountId = creds?.providerSpecificData?.accountId;
    if (!accountId) throw new Error("cloudflare-ai requires accountId in providerSpecificData");
    return `${BASE_URL}/${accountId}/ai/run/${model}`;
  },

  buildHeaders: (creds, requestBody) => {
    const headers = {};
    const isMultipart = typeof FormData !== "undefined" && requestBody instanceof FormData;
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
    }
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  },

  buildBody: async (model, body, proxyOptions) =>
    MULTIPART_MODELS.has(model)
      ? buildMultipartBody(body)
      : await buildJsonBody(body, proxyOptions),

  async parseResponse(response) {
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (contentType.startsWith("image/")) {
      const buf = await response.arrayBuffer();
      return {
        created: nowSec(),
        data: [{ b64_json: Buffer.from(buf).toString("base64") }],
      };
    }

    const json = await response.json();
    return normalizeCloudflareResponse(json);
  },

  normalize: normalizeCloudflareResponse,
};
