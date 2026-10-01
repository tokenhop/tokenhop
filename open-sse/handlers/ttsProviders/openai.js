// OpenAI TTS — model format: "tts-model/voice", a bare TTS model id, or a bare voice
import { Buffer } from "node:buffer";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../providers/index.js";

const DEFAULT_TTS_MODEL = PROVIDER_MEDIA["openai"]?.ttsConfig?.defaultModel;
const TTS_MODEL_IDS = new Set(
  (PROVIDER_MODELS.openai || []).filter((m) => (m.kind || m.type) === "tts").map((m) => m.id),
);

export default {
  async synthesize(text, model, credentials, _responseFormat, options = {}) {
    if (!credentials?.apiKey) throw new Error("No OpenAI API key configured");

    let ttsModel = DEFAULT_TTS_MODEL;
    let voice = "";
    if (model && model.includes("/")) {
      const parts = model.split("/");
      if (parts.length === 2) [ttsModel, voice] = parts;
    } else if (TTS_MODEL_IDS.has(model)) {
      ttsModel = model;
    } else if (model) {
      voice = model;
    }
    // A voice in the model id wins; the OpenAI-style body `voice` fills the gap.
    voice = voice || options.voice || "alloy";
    const format = options.format || "mp3";

    const baseUrl = (credentials.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({ model: ttsModel, voice, input: text, response_format: format }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), format };
  },
};
