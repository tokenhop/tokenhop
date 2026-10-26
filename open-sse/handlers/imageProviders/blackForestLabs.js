// Black Forest Labs (FLUX) — async submit + polling_url
import {
  sleep,
  nowSec,
  assertProviderUrl,
  upstreamErrorText,
  NO_REDIRECT,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
} from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const BASE_URL = PROVIDER_MEDIA["black-forest-labs"]?.imageConfig?.baseUrl;
// polling_url points at the global or a regional API host (api.bfl.ai, api.us1.bfl.ai);
// no other bfl.ai host is followed.
const isApiHost = (host) => host === "api.bfl.ai" || /^api\.[a-z0-9-]+\.bfl\.ai$/.test(host);

export default {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", "x-key": key };
  },
  buildBody: (_model, body) => {
    const req = { prompt: body.prompt };
    if (body.size) {
      const [w, h] = body.size.split("x").map(Number);
      if (w) req.width = w;
      if (h) req.height = h;
    }
    if (body.image) req.image_prompt = body.image;
    return req;
  },
  async parseResponse(response, { headers, proxyOptions }) {
    const data = await response.json();
    if (!data.polling_url) throw new Error("BFL: no polling_url returned");
    const pollingUrl = assertProviderUrl(data.polling_url, isApiHost, "BFL");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await proxyAwareFetch(
        pollingUrl,
        { headers: { "x-key": headers["x-key"], Accept: "application/json" }, ...NO_REDIRECT },
        proxyOptions,
      );
      if (!r.ok) throw new Error(`BFL status ${r.status}`);
      const s = await r.json();
      if (s.status === "Ready") return s;
      if (s.status === "Error" || s.status === "Failed")
        throw new Error(upstreamErrorText(s.error, "BFL generation failed"));
    }
    throw new Error("BFL polling timeout");
  },
  normalize: (responseBody) => {
    const sample = responseBody.result?.sample;
    if (sample) return { created: nowSec(), data: [{ url: sample }] };
    return { created: nowSec(), data: [] };
  },
};
