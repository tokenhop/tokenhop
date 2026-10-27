// Google Gemini embeddings — embedContent / batchEmbedContents
import { googleKeyHeader } from "../../utils/googleKeyHeader.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function modelPath(model) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export default {
  // Key in a header, not ?key= — proxy relays log pathname+search (YAN-1629).
  buildUrl: (model, _creds, { input } = {}) => {
    const path = modelPath(model);
    const op = Array.isArray(input) ? "batchEmbedContents" : "embedContent";
    return `${BASE}/${path}:${op}`;
  },
  buildHeaders: (creds) => ({
    "Content-Type": "application/json",
    ...googleKeyHeader(creds.apiKey || creds.accessToken),
  }),
  buildBody: (model, { input, dimensions }) => {
    const m = modelPath(model);
    const outputDimensionality = Number(dimensions);
    const hasOutputDimensionality =
      Number.isFinite(outputDimensionality) && outputDimensionality > 0;
    if (Array.isArray(input)) {
      return {
        requests: input.map((text) => ({
          model: m,
          content: { parts: [{ text: String(text) }] },
          ...(hasOutputDimensionality ? { outputDimensionality } : {}),
        })),
      };
    }
    return {
      model: m,
      content: { parts: [{ text: String(input) }] },
      ...(hasOutputDimensionality ? { outputDimensionality } : {}),
    };
  },
  normalize: (responseBody, model) => {
    if (responseBody.object === "list" && Array.isArray(responseBody.data)) return responseBody;
    let items = [];
    if (Array.isArray(responseBody.embeddings)) {
      items = responseBody.embeddings.map((emb, idx) => ({
        object: "embedding",
        index: idx,
        embedding: emb.values || [],
      }));
    } else if (responseBody.embedding?.values) {
      items = [{ object: "embedding", index: 0, embedding: responseBody.embedding.values }];
    }
    return {
      object: "list",
      data: items,
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  },
};
