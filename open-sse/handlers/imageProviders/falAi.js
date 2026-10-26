// Fal.ai — async submit + queue polling
import {
  sleep,
  nowSec,
  sizeToAspectRatio,
  assertProviderUrl,
  upstreamErrorText,
  NO_REDIRECT,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const BASE_URL = PROVIDER_MEDIA["fal-ai"]?.imageConfig?.baseUrl;
// Queue status/result URLs are only followed on the queue host itself.
const QUEUE_HOST = BASE_URL ? new URL(BASE_URL).hostname : "queue.fal.run";
const isQueueHost = (host) => host === QUEUE_HOST;

export default {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", Authorization: `Key ${key}` };
  },
  buildBody: (_model, body) => {
    const req = { prompt: body.prompt, num_images: body.n || 1 };
    if (body.size) req.image_size = sizeToAspectRatio(body.size);
    if (body.image) req.image_url = body.image;
    return req;
  },
  async parseResponse(response, { headers, proxyOptions }) {
    const data = await response.json();
    const statusUrl = assertProviderUrl(data.status_url, isQueueHost, "Fal");
    const responseUrl = assertProviderUrl(data.response_url, isQueueHost, "Fal");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await proxyAwareFetch(statusUrl, { headers, ...NO_REDIRECT }, proxyOptions);
      if (!r.ok) throw new Error(`Fal status ${r.status}`);
      const s = await r.json();
      if (s.status === "COMPLETED") {
        const fr = await proxyAwareFetch(responseUrl, { headers, ...NO_REDIRECT }, proxyOptions);
        return await fr.json();
      }
      if (s.status === "FAILED")
        throw new Error(upstreamErrorText(s.error, "Fal generation failed"));
    }
    throw new Error("Fal polling timeout");
  },
  normalize: (responseBody) => {
    const images = Array.isArray(responseBody.images)
      ? responseBody.images
      : responseBody.image
        ? [responseBody.image]
        : [];
    return { created: nowSec(), data: images.map((img) => ({ url: img.url || img })) };
  },
};
