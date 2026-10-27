// Google Gemini adapter (Nano Banana models)
import { nowSec } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["gemini"]?.imageConfig?.baseUrl;

export default {
  buildUrl: (model) => {
    const modelId = model.replace(/^models\//, "");
    return `${BASE_URL}/${modelId}:generateContent`;
  },
  // Key in a header, not ?key= — proxy relays log pathname+search (YAN-1629).
  buildHeaders: (creds) => ({
    "Content-Type": "application/json",
    "x-goog-api-key": creds?.apiKey || creds?.accessToken,
  }),
  buildBody: (_model, body) => ({
    contents: [{ parts: [{ text: body.prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  }),
  normalize: (responseBody, prompt) => {
    const parts = responseBody.candidates?.[0]?.content?.parts || [];
    const images = parts
      .filter((p) => p.inlineData?.data)
      .map((p) => ({ b64_json: p.inlineData.data }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};
