import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import {
  ANTHROPIC_API_VERSION,
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  selectAnthropicBeta,
  isFastModeRequest,
} from "../providers/shared.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { EXTRA_USAGE_EXHAUSTED_TEXT } from "../config/errorConfig.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { buildClineHeaders } from "../shared/clineAuth.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";
import { CLAUDE_CODE_SESSION_HEADER, extractClaudeCodeSession } from "../utils/sessionManager.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { refreshMetaCodeToken } from "../services/tokenRefresh.js";

// Auth header descriptors — derived from registry transport.auth, fallback to hardcoded defaults.
const BEARER = { combined: true, header: "Authorization", scheme: "bearer" };
const XAPIKEY = { combined: true, header: "x-api-key", scheme: "raw" };
const AUTH_DESCRIPTORS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, t]) => t.auth)
    .map(([id, t]) => [id, t.auth]),
);

// Apply a token to a header per scheme (matches legacy: combined always sets, even when undefined).
function setAuth(headers, spec, token) {
  headers[spec.header] = spec.scheme === "bearer" ? `Bearer ${token}` : token;
}

// Responses API has no top-level `reasoning_effort` (strict upstreams like Meta 400 on it);
// applyThinking emits the Chat-style field, so fold it into `reasoning.effort`.
function foldReasoningEffort(body) {
  if (body.reasoning_effort === undefined) return;
  const reasoning =
    body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? body.reasoning
      : {};
  body.reasoning = { summary: "auto", ...reasoning, effort: body.reasoning_effort };
  delete body.reasoning_effort;
}

// Resolve auth onto headers from a descriptor.
function applyAuth(headers, desc, credentials) {
  if (desc.combined) {
    // combined providers always set the header (legacy behavior, incl. noAuth → "Bearer undefined")
    setAuth(headers, desc, credentials.apiKey || credentials.accessToken);
    if (desc.anthropicVersion && !headers["anthropic-version"])
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return;
  }
  // split apiKey/oauth: set only the matching branch (legacy: anthropic-compatible skips when both absent)
  if (credentials.apiKey) setAuth(headers, desc.apiKey, credentials.apiKey);
  else if (credentials.accessToken) setAuth(headers, desc.oauth, credentials.accessToken);
  if (desc.anthropicVersion && !headers["anthropic-version"])
    headers["anthropic-version"] = ANTHROPIC_API_VERSION;
}

// Provider-specific header quirks kept as small hooks (not pure auth).
const HEADER_HOOKS = {
  // Stable device_id from OAuth connection (CLIProxyAPI KimiTokenStorage.DeviceID)
  kimiHeaders: (h, c) => Object.assign(h, buildKimiHeaders(c?.providerSpecificData?.deviceId)),
  clineHeaders: (h, c) => Object.assign(h, buildClineHeaders(c.apiKey || c.accessToken)),
  kilocodeOrg: (h, c) => {
    if (c.providerSpecificData?.orgId)
      h["X-Kilocode-OrganizationID"] = c.providerSpecificData.orgId;
  },
};

// Config-driven OAuth refresh grants — derived from registry oauth.refresh.
const REFRESH_GRANTS = Object.fromEntries(
  Object.entries(PROVIDER_OAUTH)
    .filter(([, o]) => o.refresh)
    .map(([id, o]) => {
      const tokenUrl = o.tokenUrl;
      const encoding = o.refresh.encoding;
      const extraParams = o.refresh.scope ? { scope: o.refresh.scope } : {};
      return [
        id,
        {
          encoding,
          url: () => tokenUrl,
          params: (ex) =>
            id === "gemini"
              ? {
                  client_id: ex.config.clientId,
                  client_secret: ex.config.clientSecret,
                  ...extraParams,
                }
              : { client_id: o.clientId, ...extraParams },
        },
      ];
    }),
);

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  // Whether requests for `model` carry Anthropic beta flags (incl. fast mode).
  // anthropic-compatible-* nodes serving a real Claude model sit in front of
  // Anthropic itself (a rotating multi-account proxy, a corporate gateway),
  // so the request needs the same beta flags the `claude` provider sends:
  // without `context-management-2025-06-27` upstream rejects the
  // `context_management` block Claude Code puts in every request with
  // "context_management: Extra inputs are not permitted" (HTTP 400), and the
  // combo silently falls through to the next model. The model id gates this:
  // a node fronting Kimi or GLM answers on its own ids and never matches, so
  // gateways that would choke on unknown beta flags are left untouched.
  usesClaudeBetas(model) {
    const isClaudeModel = typeof model === "string" && /^claude-/.test(model);
    return Boolean(
      model &&
        (this.provider === "claude" ||
          (this.provider?.startsWith?.("anthropic-compatible-") && isClaudeModel)),
    );
  }

  // Fast mode is billed only to extra usage, even with plan usage left. When
  // that runs out, retry once at standard speed like Claude Code does; dropping
  // `speed` also drops the fast-mode beta, which selectAnthropicBeta sends only
  // for speed:"fast" requests. Gated on usesClaudeBetas so only providers that
  // can send the fast-mode beta ever take this path.
  async execute(args) {
    const result = await super.execute(args);
    if (
      !this.usesClaudeBetas(args.model) ||
      !isFastModeRequest(args.body) ||
      result.response.status !== HTTP_STATUS.BAD_REQUEST
    )
      return result;
    // Read a clone so the original response stays readable for the caller.
    const text = await result.response
      .clone()
      .text()
      .catch(() => "");
    if (!text.toLowerCase().includes(EXTRA_USAGE_EXHAUSTED_TEXT)) return result;
    args.log?.warn?.("FAST_MODE", "out of extra usage — retrying at standard speed");
    const { speed, ...standardBody } = args.body;
    // Release the dropped 400's body (and its connection) before retrying.
    await result.response.body?.cancel().catch(() => {});
    return super.execute({ ...args, body: standardBody });
  }

  transformRequest(model, body) {
    const transformed = this.applyJsonSchemaFallback(body);

    if (transformed && typeof transformed === "object") {
      // quirk: some openai-compatible providers reject Anthropic's client_metadata field
      if (this.config.quirks?.dropClientMetadata) {
        delete transformed.client_metadata;
      }
      stripUnsupportedParams(this.provider, model, transformed);
      if (this.config.format === "openai-responses") {
        if (this.config.quirks?.foldReasoningEffort) foldReasoningEffort(transformed);
        // chatCore always reads forceStream upstreams as SSE; a same-format client
        // body can still carry stream:false, which would return JSON instead.
        if (this.config.forceStream) transformed.stream = true;
      }
    }

    return injectReasoningContent({ provider: this.provider, model, body: transformed });
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : [];
    const sys = messages.find((m) => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content))
        sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Runtime transport (multi-endpoint providers): use the sourceFormat-matched endpoint
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path =
        resolveOpenAICompatibleApiType(this.provider, credentials) === "responses"
          ? "/responses"
          : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    // gemini-format: build :streamGenerateContent / :generateContent path
    if (this.config.format === "gemini") {
      return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }
    // urlSuffix (e.g. ?beta=true) declared per-provider in registry
    if (this.config.urlSuffix) {
      return `${this.config.baseUrl}${this.config.urlSuffix}`;
    }
    const url = this.config.baseUrl;
    if (url?.includes("{accountId}")) {
      const accountId = credentials?.providerSpecificData?.accountId;
      if (!accountId)
        throw new Error(`${this.provider} requires accountId in providerSpecificData`);
      return url.replace("{accountId}", accountId);
    }
    return url;
  }

  // Fallback descriptor for providers without an explicit entry in AUTH_DESCRIPTORS.
  resolveAuthDescriptor() {
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      return {
        apiKey: { header: "x-api-key", scheme: "raw" },
        oauth: { header: "Authorization", scheme: "bearer" },
        anthropicVersion: true,
      };
    }
    if (this.config?.format === "claude") {
      return { ...XAPIKEY, anthropicVersion: true };
    }
    return BEARER;
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const rt = credentials?.runtimeTransport;
    const headers = {
      "Content-Type": "application/json",
      ...(rt ? rt.headers : this.config.headers),
    };
    const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();
    // Hooks run BEFORE auth so dynamic overlays can't clobber the token.
    for (const hook of desc.hooks || []) HEADER_HOOKS[hook]?.(headers, credentials);
    applyAuth(headers, desc, credentials);

    if (this.usesClaudeBetas(model)) {
      headers["Anthropic-Beta"] = selectAnthropicBeta(model, body);
      // Native Claude Code passthrough copies new body fields verbatim (e.g.
      // `safeguards`); Anthropic 400s on them unless the client's own beta flag
      // rides along. Merge only for official Anthropic: third-party gateways
      // may reject unknown flags.
      const clientBeta =
        credentials?.rawHeaders?.["anthropic-beta"] || credentials?.rawHeaders?.["Anthropic-Beta"];
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficial =
        this.provider === "claude" || baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (
        clientBeta &&
        isOfficial &&
        isNativePassthrough(detectClientTool(credentials.rawHeaders), this.provider)
      ) {
        headers["Anthropic-Beta"] = [
          ...new Set(
            `${headers["Anthropic-Beta"]},${clientBeta}`
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ].join(",");
      }
      // Real Claude Code sends its session id as a header too, matching the
      // session_id inside metadata.user_id (set by applyCloaking or the client).
      const sessionId = extractClaudeCodeSession(body?.metadata?.user_id);
      if (sessionId) headers[CLAUDE_CODE_SESSION_HEADER] = sessionId;
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        // Some third-party Anthropic-compatible gateways require Bearer auth in
        // addition to x-api-key. Send both (x-api-key already set above) so
        // gateways that read either header succeed.
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        delete headers[CLAUDE_CODE_SESSION_HEADER];
        // Strip claude-code-20250219 from Anthropic-Beta / anthropic-beta
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map((s) => s.trim())
              .filter((f) => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) {
              headers[betaKey] = filtered;
            } else {
              delete headers[betaKey];
            }
          }
        }
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  // Generic OAuth refresh for the common {grant_type, refresh_token, client_id[, ...]} shape.
  // grant = REFRESH_GRANTS[provider]; client creds resolved from PROVIDERS or this.config.
  refreshFromGrant(credentials, proxyOptions) {
    const grant = REFRESH_GRANTS[this.provider];
    const params = {
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      ...grant.params(this),
    };
    return grant.encoding === "json"
      ? this.refreshWithJSON(grant.url(), params, proxyOptions)
      : this.refreshWithForm(grant.url(), params, proxyOptions);
  }

  // Per-credential refresh capability for 401/403 handlers: true only when a
  // refresh could actually produce a token — the provider has an entry in the
  // refresher map AND the credential carries a refreshToken. Mirrors
  // refreshCredentials' early exits (no refreshToken → null; no map entry →
  // null), so handlers can skip the futile refreshWithRetry path (~3s of
  // 1s+2s waits) for API-key-only credentials and unknown providers. Only
  // DefaultExecutor (and subclasses) expose this; specialized executors
  // (vertex, github, …) keep the legacy always-attempt path. Subclasses that
  // override refreshCredentials with different requirements override this too.
  canRefreshCredentials(credentials) {
    return Boolean(credentials?.refreshToken && this.buildRefreshers(credentials)[this.provider]);
  }

  // Single source of truth for the provider refresher map, shared by
  // canRefreshCredentials and refreshCredentials. The closures only run when
  // invoked, so consulting the map for capability costs nothing.
  buildRefreshers(credentials, log = null, proxyOptions = null) {
    return {
      claude: () => this.refreshFromGrant(credentials, proxyOptions),
      codex: () => this.refreshFromGrant(credentials, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshFromGrant(credentials, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      cline: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      clinepass: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      kimi: () => this.refreshKimi(credentials, proxyOptions),
      "kimi-coding": () => this.refreshKimi(credentials, proxyOptions),
      // No refresh grant: refreshToken is the `dca:` device token, re-mint the key.
      "meta-code": () => refreshMetaCodeToken(credentials.refreshToken, log),
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refresher = this.buildRefreshers(credentials, log, proxyOptions)[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result?.accessToken) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || body.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(params),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || params.refresh_token,
      expiresIn: tokens.expires_in,
    };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(
      OAUTH_ENDPOINTS.iflow.token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: PROVIDERS.iflow.clientId,
          client_secret: PROVIDERS.iflow.clientSecret,
        }),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(
      PROVIDERS.kiro.tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "kiro-cli/1.0.0",
        },
        body: JSON.stringify({ refreshToken }),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const tokens = await response.json();
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
    };
  }

  async refreshCline(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(
      PROVIDERS.cline.refreshUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" }),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const data = payload?.data || payload;
    const expiresAtIso = data?.expiresAt;
    const expiresIn = expiresAtIso
      ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000))
      : undefined;
    let accessToken = data?.accessToken;
    if (accessToken && !accessToken.startsWith("workos:")) {
      accessToken = `workos:${accessToken}`;
    }
    return { accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
  }

  // CLIProxyAPI DeviceFlowClient.RefreshToken — form body + X-Msh-* headers + stable device_id
  async refreshKimi(credentials, proxyOptions = null) {
    const refreshToken = credentials.refreshToken;
    const cfg = PROVIDERS.kimi || PROVIDERS["kimi-coding"];
    if (!cfg?.refreshUrl || !cfg?.clientId) return null;
    const kimiHeaders = buildKimiHeaders(credentials?.providerSpecificData?.deviceId);
    const response = await proxyAwareFetch(
      cfg.refreshUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...kimiHeaders,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: cfg.clientId,
        }),
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    const tokens = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  }
}

export default DefaultExecutor;
