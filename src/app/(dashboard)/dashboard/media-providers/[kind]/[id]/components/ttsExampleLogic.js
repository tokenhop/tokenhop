/**
 * Pure builders for the TTS example card (YAN-402). No JSX, no hooks — safe
 * to import in node unit tests. Behaviour mirrors the original inline IIFEs
 * in `TtsExampleCard.js`.
 */
import { previewAuthHeader } from "@/shared/constants/previewAuth";

/**
 * Resolve the initial TTS model: provider ttsConfig models win, else the
 * first model behind `config.modelKey`, else empty.
 */
export function initialTtsModel({ cfgModels = [], modelKeyModels = [], config = {} }) {
  if (cfgModels.length) return cfgModels[0].id;
  if (config.hasModelSelector && config.modelKey) return modelKeyModels[0]?.id || "";
  return "";
}

/**
 * Preselect default voices for `hardcoded` voice sources. Returns null when
 * nothing is preselected. `perModelVoices`/`flatVoices` are injected so this
 * stays pure (the hook supplies `getTtsVoicesForModel` / `getModelsByProviderId`).
 */
export function defaultTtsSelection({
  config,
  defaultModel,
  perModelVoices = [],
  flatVoices = [],
}) {
  const voices = config.voicesPerModel && defaultModel ? perModelVoices : flatVoices;
  if (!voices.length) return null;
  if (config.hasBrowseButton) {
    const defaultVoice = voices.find((v) => v.id === "en") || voices[0];
    return {
      lang: defaultVoice.id,
      voiceId: defaultVoice.id,
      voices: [{ id: defaultVoice.id, name: defaultVoice.name }],
    };
  }
  return { lang: "", voiceId: voices[0].id, voices };
}

/** Build the `{ byLang, languages }` maps from static hardcoded voice models. */
export function buildHardcodedLanguages(voices = []) {
  const byLang = {};
  for (const v of voices) {
    if (!byLang[v.id])
      byLang[v.id] = { code: v.id, name: v.name, voices: [{ id: v.id, name: v.name }] };
  }
  const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));
  return { byLang, languages };
}

/** Case-insensitive language filter for the picker modal. */
export function filterLanguages(list, query) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
}

/** Build the `provider/model/voice` identifier sent as the request model. */
export function buildTtsModelFull({ alias, config = {}, model, voiceId }) {
  if (config.hasModelSelector && model && voiceId) return `${alias}/${model}/${voiceId}`;
  if (config.hasModelSelector && model) return `${alias}/${model}`;
  if (voiceId) return `${alias}/${voiceId}`;
  return "";
}

/** Build the TTS JSON request body (input kept as-is; the runner trims on send). */
export function buildTtsBody({ modelFull, input, config = {}, languageHint, style }) {
  const body = { model: modelFull, input };
  if (config.hasLanguageHint && languageHint) body.language = languageHint;
  if (config.hasStyleInput && typeof style === "string" && style.trim()) body.style = style.trim();
  return body;
}

/**
 * Build the preview-safe cURL snippet. The rendered/copied output always
 * shows `Bearer YOUR_KEY`; the live key only goes in the fetch header.
 */
export function buildTtsCurl({ endpoint, responseFormat, apiKey, body }) {
  return `curl -X POST ${endpoint}/v1/audio/speech${responseFormat === "json" ? "?response_format=json" : ""} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: ${previewAuthHeader(apiKey)}" \\
  -d '${JSON.stringify(body)}' \\
  ${responseFormat === "json" ? "" : "--output speech.mp3"}`;
}
