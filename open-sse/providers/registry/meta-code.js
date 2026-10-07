/**
 * Meta Code (Muse Spark) — Meta Model API (api.meta.ai/v1)
 *
 * Dual auth (same pattern as kimi):
 *  - OAuth: muse CLI device-code flow → the `dca:` token mints the subscription API
 *    key (accessToken) at /muse-code/key; the dca token is kept as refreshToken to
 *    re-mint on 401. Quota is only available for OAuth connections.
 *  - API key: pay-as-you-go key, or the key copied from ~/.config/muse/auth.json.
 *
 * clientId intentionally omitted — injected from META_CODE_OAUTH_CLIENT_ID at runtime
 * (src/lib/oauth/constants/oauth.js).
 */
export default {
  id: "meta-code",
  priority: 285,
  alias: "mc",
  display: {
    name: "Meta Code",
    icon: "auto_awesome",
    color: "#0668E1",
    textIcon: "MC",
    website: "https://dev.meta.ai",
    notice: {
      apiKeyUrl: "https://dev.meta.ai",
      signupUrl: "https://dev.meta.ai/docs/muse-code/subscriptions",
    },
  },
  category: "oauth",
  sharing: "personal",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.meta.ai/v1/responses",
    format: "openai-responses",
    // Responses translator always sends stream:true; route JSON clients through SSE→JSON.
    forceStream: true,
    // Meta 400s on Chat-style top-level `reasoning_effort`; move it to `reasoning.effort`.
    quirks: { foldReasoningEffort: true },
    // Bearer accessToken||apiKey is the BaseExecutor default — no auth block needed.
    validateUrl: "https://api.meta.ai/v1/models",
  },
  oauth: {
    deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
    mintUrl: "https://api.meta.ai/muse-code/key",
  },
  models: [
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2", name: "Muse Spark 1.2", targetFormat: "openai-responses" },
    { id: "muse-spark-1.1", name: "Muse Spark 1.1", targetFormat: "openai-responses" },
    {
      id: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 Contributor",
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      targetFormat: "openai-responses",
    },
  ],
  features: {
    usage: true,
    // No usageApikey: quota comes from the mint response, which only accepts the dca token.
  },
};
