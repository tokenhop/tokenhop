import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProvidersByKind, getProviderAlias } from "@/shared/constants/providers";

/**
 * Playground kind defaults: label, prefilled input and API path.
 * Mirrors the per-kind example runner defaults (embedding/image/tts/stt/generic).
 */
export const PLAYGROUND_KIND_DEFAULTS = {
  embedding: {
    inputLabel: "Input",
    defaultInput: "The quick brown fox jumps over the lazy dog",
    path: "/v1/embeddings",
  },
  image: {
    inputLabel: "Prompt",
    defaultInput:
      "A tiny robot sorting mail at a busy switchboard, risograph print, coral and lime",
    path: "/v1/images/generations",
  },
  video: {
    inputLabel: "Prompt",
    defaultInput: "A serene lake at sunset with gentle ripples",
    path: "/v1/videos/generations",
  },
  tts: {
    inputLabel: "Input",
    defaultInput: "Hello, this is a text to speech test on 9router.",
    path: "/v1/audio/speech",
  },
  stt: {
    inputLabel: "Prompt",
    defaultInput: "Transcribe spoken audio accurately",
    path: "/v1/audio/transcriptions",
  },
  webSearch: {
    inputLabel: "Query",
    defaultInput: "What is the latest news about AI?",
    path: "/v1/search",
  },
  webFetch: {
    inputLabel: "URL",
    defaultInput: "https://example.com",
    path: "/v1/web/fetch",
  },
};

/**
 * Resolve kind defaults with the image fallback for unknown kinds.
 * @param {string} kind
 * @returns {{ inputLabel: string, defaultInput: string, path: string }}
 */
export function playgroundDefaults(kind) {
  return PLAYGROUND_KIND_DEFAULTS[kind] || PLAYGROUND_KIND_DEFAULTS.image;
}

/**
 * Build model dropdown options for a kind from registry providers + static models.
 * @param {string} kind
 * @returns {Array<{ value: string, label: string }>}
 */
export function playgroundModelOptions(kind) {
  const options = [];
  for (const p of getProvidersByKind(kind)) {
    const pAlias = getProviderAlias(p.id) || p.id;
    const pModels = getModelsByProviderId(p.id).filter((m) => getModelKind(m) === kind);
    if (pModels.length > 0) {
      for (const m of pModels) {
        options.push({ value: `${pAlias}/${m.id}`, label: `${p.name} · ${m.name || m.id}` });
      }
    } else {
      options.push({ value: pAlias, label: p.name });
    }
  }
  return options;
}

/**
 * Pick a valid model value: keep the current one when still available,
 * otherwise fall back to the first option.
 * @param {string} current
 * @param {Array<{ value: string }>} options
 * @returns {string}
 */
export function resolvePlaygroundModel(current, options) {
  if (!options || options.length === 0) return current || "";
  const exists = options.some((m) => m.value === current);
  return exists ? current : options[0].value;
}

/**
 * Build the request payload for a playground run (parity with the kind runners).
 * @param {object} fields
 * @returns {object}
 */
export function buildPlaygroundBody(fields) {
  const {
    kind,
    model,
    input,
    imageSize,
    dimensions,
    ttsVoice,
    ttsLanguage,
    ttsStyle,
    sttLanguage,
    sttTemp,
    sttFormat,
    refImage,
    maskImage,
  } = fields;
  const body = { model };
  const text = (input || "").trim();
  if (kind === "embedding") {
    body.input = text;
    const dim = Number(dimensions);
    if (dimensions && Number.isFinite(dim) && dim > 0) body.dimensions = dim;
  } else if (kind === "image") {
    body.prompt = text;
    if (imageSize) body.size = imageSize;
    if ((refImage || "").trim()) body.image = refImage.trim();
    if ((maskImage || "").trim()) body.mask_image = maskImage.trim();
  } else if (kind === "video") {
    body.prompt = text;
  } else if (kind === "tts") {
    body.input = text;
    if (ttsVoice) body.voice = ttsVoice;
    if (ttsLanguage) body.language = ttsLanguage;
    if ((ttsStyle || "").trim()) body.style = ttsStyle.trim();
  } else if (kind === "stt") {
    body.prompt = text;
    if (sttLanguage) body.language = sttLanguage;
    if (sttTemp) body.temperature = Number(sttTemp);
    if (sttFormat) body.response_format = sttFormat;
  } else if (kind === "webSearch") {
    body.query = text;
  } else if (kind === "webFetch") {
    body.url = text;
  }
  return body;
}

/**
 * Build the multipart field list for an STT playground run, shared by the
 * FormData builder and the truthful -F cURL preview.
 * @param {object} fields
 * @returns {{ fileName: string, model: string, language: string, temperature: string, responseFormat: string, prompt: string }}
 */
export function sttFormFields(fields) {
  const { model, input, sttFile, sttLanguage, sttTemp, sttFormat } = fields;
  return {
    fileName: sttFile?.name || "audio.mp3",
    model: model || "",
    language: sttLanguage || "",
    temperature: sttTemp || "",
    responseFormat: sttFormat || "",
    prompt: (input || "").trim(),
  };
}

/**
 * Build multipart form data for an STT playground run.
 * @param {object} fields
 * @returns {FormData}
 */
export function buildSttFormData(fields) {
  const { sttFile } = fields;
  const { model, language, temperature, responseFormat, prompt } = sttFormFields(fields);
  const fd = new FormData();
  fd.append("file", sttFile);
  fd.append("model", model);
  if (language) fd.append("language", language);
  if (temperature) fd.append("temperature", temperature);
  if (responseFormat) fd.append("response_format", responseFormat);
  if (prompt) fd.append("prompt", prompt);
  return fd;
}

/**
 * Auth + connection-pin headers for a playground run.
 * @param {string} apiKey
 * @param {string} connectionId
 * @param {boolean} [json=true] Include the JSON content type.
 * @returns {Record<string, string>}
 */
export function playgroundHeaders(apiKey, connectionId, json = true) {
  const headers = json ? { "Content-Type": "application/json" } : {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (connectionId) headers["x-connection-id"] = connectionId;
  return headers;
}

/**
 * Derive preview URLs from a JSON playground response.
 * @param {object|null} data
 * @returns {{ imageUrl: string, audioUrl: string }}
 */
export function playgroundPreviews(data) {
  if (!data || typeof data !== "object") return { imageUrl: "", audioUrl: "" };
  if (data?.data?.[0]?.b64_json) {
    return { imageUrl: `data:image/png;base64,${data.data[0].b64_json}`, audioUrl: "" };
  }
  if (data?.data?.[0]?.url) return { imageUrl: data.data[0].url, audioUrl: "" };
  if (data?.audio) return { imageUrl: "", audioUrl: `data:audio/mp3;base64,${data.audio}` };
  return { imageUrl: "", audioUrl: "" };
}
