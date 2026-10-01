/**
 * Wrap chat-completions endpoints (with built-in web search) into the unified
 * /v1/search response format. Supports gemini, antigravity, openai, xai, kimi,
 * minimax, perplexity.
 */
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../providers/shared.js";
import { buildKimiHeaders } from "../../config/appConstants.js";

// Default search model + endpoint derive from registry searchViaChat (single source)
const searchModel = (id) => PROVIDER_MEDIA[id]?.searchViaChat?.defaultModel;
const searchEndpoint = (id, model) =>
  (PROVIDER_MEDIA[id]?.searchViaChat?.endpoint || "").replace("{model}", model || "");

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 10;

/**
 * Normalize a citation entry into the unified result shape.
 * @param {{url:string, title?:string, snippet?:string}} c
 * @param {number} index
 * @param {string} provider
 * @param {string} retrievedAt
 */
function toResult(c, index, provider, retrievedAt) {
  return {
    title: c.title || "",
    url: c.url,
    snippet: c.snippet || "",
    position: index + 1,
    score: null,
    published_at: null,
    favicon_url: null,
    content: c.content || null,
    metadata: {},
    citation: { provider, retrieved_at: retrievedAt, rank: index + 1 },
    provider_raw: null,
  };
}

// Antigravity search request envelope (mirrors the IDE client)
const AG_CLIENT_NAME = "antigravity";
const AG_SEARCH_GENERATION_CONFIG = { temperature: 1.0, maxOutputTokens: 8192 };
const AG_CONTEXT_BEFORE = 150;
const AG_CONTEXT_AFTER = 250;

/** Widen a grounded segment to its surrounding sentence(s) in the answer text. */
function expandSegment(text, segment) {
  const { startIndex, endIndex } = segment || {};
  if (!text || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return "";
  const start = Math.max(0, startIndex - AG_CONTEXT_BEFORE);
  const end = Math.min(text.length, endIndex + AG_CONTEXT_AFTER);
  let out = text.slice(start, end).trim();
  // Drop the partial words the window cut off at either edge
  if (start > 0) out = `...${out.replace(/^\S+/, "")}`;
  if (end < text.length) out = `${out.replace(/\S+$/, "")}...`;
  return out.trim();
}

/** Join deduped grounding pieces, skipping empties. */
function joinPieces(set, sep) {
  return [...(set || [])].filter(Boolean).join(sep).trim();
}

/** Coerce a citation that might be a raw URL string or an object. */
function normalizeCitation(c) {
  if (!c) return null;
  if (typeof c === "string") return { url: c };
  if (typeof c === "object" && c.url) return c;
  return null;
}

/**
 * Provider-specific configuration map. All providers must implement:
 * { endpoint, defaultModel, buildBody, buildHeaders, extractAnswer }
 * Optional: requireCredentials(credentials) → error string when a provider needs
 * more than a token (returns null when satisfied).
 */
const CHAT_SEARCH_CONFIG = {
  gemini: {
    endpoint: (model) => searchEndpoint("gemini", model),
    buildBody: (query) => ({
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      "x-goog-api-key": token,
    }),
    extractAnswer: (data) => {
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = parts
        .map((p) => p?.text || "")
        .filter(Boolean)
        .join("");
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const citations = chunks
        .map((ch) => ch?.web)
        .filter(Boolean)
        .map((w) => ({ url: w.uri || w.url, title: w.title || "" }))
        .filter((c) => c.url);
      const tokens = data?.usageMetadata?.totalTokenCount || 0;
      return { text, citations, tokens };
    },
  },

  antigravity: {
    endpoint: () => searchEndpoint("antigravity"),
    // Upstream 403s on a missing or fabricated project — surface the real cause
    requireCredentials: (credentials) =>
      credentials?.projectId
        ? null
        : "Antigravity account has no projectId — reconnect the account",
    buildBody: (query, model, credentials) => ({
      project: credentials.projectId,
      model,
      userAgent: AG_CLIENT_NAME,
      requestType: "search",
      request: {
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: AG_SEARCH_GENERATION_CONFIG,
      },
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    }),
    extractAnswer: (data) => {
      // Antigravity wraps the Gemini payload in { response: {...} }
      const response = data?.response || data;
      const candidate = response?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const text = parts
        .map((p) => p?.text || "")
        .filter(Boolean)
        .join("");
      const grounding = candidate?.groundingMetadata || {};
      const chunks = grounding.groundingChunks || [];
      const supports = grounding.groundingSupports || [];

      // Upstream repeats the same source across chunks — key by URL so it stays one citation.
      // Map, not a plain object: both the index and the URL come from upstream.
      const sources = new Map();
      const byIndex = chunks.map((ch) => {
        const web = ch?.web;
        const url = web?.uri || web?.url || "";
        if (!url) return null;
        if (!sources.has(url))
          sources.set(url, { title: web.title || "", snippets: new Set(), contexts: new Set() });
        return sources.get(url);
      });

      // Each support ties a sentence of the answer back to the chunks that grounded it
      for (const s of supports) {
        const segment = s?.segment;
        const grounded = segment?.text || "";
        const expanded = expandSegment(text, segment) || grounded;
        for (const idx of s?.groundingChunkIndices || []) {
          const source = Number.isInteger(idx) ? byIndex[idx] : null;
          if (!source) continue;
          if (grounded) source.snippets.add(grounded);
          if (expanded) source.contexts.add(expanded);
        }
      }

      const citations = [...sources].map(([url, src]) => {
        const snippet = joinPieces(src.snippets, " | ") || src.title;
        return {
          url,
          title: src.title,
          snippet,
          content: joinPieces(src.contexts, "\n\n") || snippet,
        };
      });

      const tokens = response?.usageMetadata?.totalTokenCount || 0;
      return { text, citations, tokens };
    },
  },

  openai: {
    endpoint: () => searchEndpoint("openai"),
    buildBody: (query, model) => {
      const body = {
        model,
        messages: [{ role: "user", content: query }],
      };
      // Non-search-preview models need explicit web_search tool
      if (!/search/i.test(model)) {
        body.tools = [{ type: "web_search" }];
      }
      return body;
    },
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const fromAnn = annotations
        .map((a) => a?.url_citation)
        .filter(Boolean)
        .map((u) => ({ url: u.url, title: u.title || "" }));
      const fromTop = Array.isArray(data?.citations)
        ? data.citations.map(normalizeCitation).filter(Boolean)
        : [];
      const citations = fromAnn.length ? fromAnn : fromTop;
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },

  xai: {
    endpoint: () => searchEndpoint("xai"),
    buildBody: (query, model) => ({
      model,
      input: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }],
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    extractAnswer: (data) => {
      // /v1/responses returns output[] array of message/tool blocks
      const output = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      const citations = [];
      for (const item of output) {
        const parts = Array.isArray(item?.content) ? item.content : [];
        for (const p of parts) {
          if (typeof p?.text === "string") text += p.text;
          const anns = Array.isArray(p?.annotations) ? p.annotations : [];
          for (const a of anns) {
            const c = normalizeCitation(a?.url ? a : a?.url_citation);
            if (c) citations.push(c);
          }
        }
      }
      // Fallback: top-level citations array (some response variants)
      if (!citations.length && Array.isArray(data?.citations)) {
        for (const c of data.citations) {
          const n = normalizeCitation(c);
          if (n) citations.push(n);
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },

  kimi: {
    // OAuth (Kimi Code) tokens are only valid on api.kimi.com/coding + X-Msh-* headers;
    // API keys keep the platform endpoint.
    endpoint: (_model, credentials) =>
      credentials?.authType === "oauth"
        ? PROVIDER_MEDIA.kimi.searchViaChat.oauthEndpoint
        : searchEndpoint("kimi"),
    model: (useModel, credentials) =>
      credentials?.authType === "oauth"
        ? PROVIDER_MEDIA.kimi.searchViaChat.oauthModel || useModel
        : useModel,
    extraHeaders: (credentials) =>
      credentials?.authType === "oauth"
        ? buildKimiHeaders(credentials?.providerSpecificData?.deviceId)
        : {},
    // OAuth (Kimi Code) path: k3 is search-native — no client-injected
    // builtin_function, which the coding endpoint rejects ("tokenization failed").
    // Citations/text arrive inline in a single turn.
    buildBody: (query, model, credentials) => {
      const body = { model, messages: [{ role: "user", content: query }] };
      if (credentials?.authType !== "oauth") {
        body.tools = [{ type: "builtin_function", function: { name: "$web_search" } }];
      }
      return body;
    },
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    // Tool echo only runs for API-key (platform) connections.
    executeTools: async (toolCalls, { credentials }) =>
      credentials?.authType === "oauth"
        ? null
        : toolCalls.map((call) => ({
            toolCallId: call.id,
            content: call?.function?.arguments || "{}",
          })),
    followUp: (body, firstData, toolResults) => ({
      ...body,
      messages: [
        ...body.messages,
        // Echo only fields upstream accepts in a tool-calling assistant
        // message; k3 thinking models reject a verbatim round-trip
        // (reasoning_content) with "tokenization failed".
        {
          role: "assistant",
          content: firstData.choices[0].message.content ?? "",
          tool_calls: firstData.choices[0].message.tool_calls,
        },
        ...toolResults.map((t) => ({
          role: "tool",
          tool_call_id: t.toolCallId,
          content: t.content,
        })),
      ],
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const citations = [];
      for (const call of calls) {
        const argStr = call?.function?.arguments;
        if (!argStr) continue;
        let parsed;
        try {
          parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
        } catch {
          continue;
        }
        // Moonshot variants: {search_results:[...]}, {results:[...]}, or the
        // bare results array as the arguments payload itself.
        const items = Array.isArray(parsed)
          ? parsed
          : parsed?.search_results || parsed?.results || parsed?.references || [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const url = it?.url || it?.link;
            if (!url) continue;
            citations.push({
              url,
              title: it.title || "",
              snippet: it.snippet || it.summary || "",
            });
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },

  minimax: {
    endpoint: () => searchEndpoint("minimax"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }],
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const citations = [];
      const direct = Array.isArray(data?.web_search_results) ? data.web_search_results : [];
      for (const it of direct) {
        const url = it?.url || it?.link;
        if (url) {
          citations.push({
            url,
            title: it.title || "",
            snippet: it.snippet || it.summary || "",
          });
        }
      }
      if (!citations.length) {
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const call of calls) {
          const argStr = call?.function?.arguments;
          if (!argStr) continue;
          let parsed;
          try {
            parsed = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
          } catch {
            continue;
          }
          const items = parsed?.results || parsed?.search_results || [];
          if (Array.isArray(items)) {
            for (const it of items) {
              const url = it?.url || it?.link;
              if (!url) continue;
              citations.push({
                url,
                title: it.title || "",
                snippet: it.snippet || "",
              });
            }
          }
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },

  perplexity: {
    endpoint: () => searchEndpoint("perplexity"),
    buildBody: (query, model) => ({
      model,
      messages: [{ role: "user", content: query }],
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    extractAnswer: (data) => {
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || "";
      const raw = data?.citations || [];
      const citations = Array.isArray(raw) ? raw.map(normalizeCitation).filter(Boolean) : [];
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },

  "perplexity-agent": {
    endpoint: () => searchEndpoint("perplexity-agent"),
    buildBody: (query, model) => ({
      model,
      input: query,
      tools: [{ type: "web_search" }],
    }),
    buildHeaders: (token) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    extractAnswer: (data) => {
      const output = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      const citations = [];
      for (const item of output) {
        const parts = Array.isArray(item?.content) ? item.content : [];
        for (const p of parts) {
          if (typeof p?.text === "string") text += p.text;
          const anns = Array.isArray(p?.annotations) ? p.annotations : [];
          for (const a of anns) {
            const c = normalizeCitation(a?.url ? a : a?.url_citation);
            if (c) citations.push(c);
          }
        }
        const results = Array.isArray(item?.results) ? item.results : [];
        for (const r of results) {
          const url = r?.url || r?.link;
          if (!url) continue;
          citations.push({
            url,
            title: r?.title || "",
            snippet: r?.snippet || "",
          });
        }
      }
      if (!citations.length && Array.isArray(data?.citations)) {
        for (const c of data.citations) {
          const n = normalizeCitation(c);
          if (n) citations.push(n);
        }
      }
      const tokens = data?.usage?.total_tokens || 0;
      return { text, citations, tokens };
    },
  },
};

/**
 * Execute a chat-search request against the chosen provider.
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.query
 * @param {number} [params.maxResults]
 * @param {string} [params.model]
 * @param {{apiKey?:string, accessToken?:string}} params.credentials
 * @param {{info?:Function, warn?:Function, error?:Function}} [params.log]
 * @returns {Promise<{success:boolean, status?:number, error?:string, data?:object}>}
 */
export async function handleChatSearch({ provider, query, maxResults, model, credentials, log }) {
  const startTime = Date.now();
  const cfg = CHAT_SEARCH_CONFIG[provider];

  if (!cfg) {
    return {
      success: false,
      status: 400,
      error: `Unsupported chat-search provider: ${provider}`,
    };
  }

  if (!query || typeof query !== "string") {
    return { success: false, status: 400, error: "Missing query" };
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return {
      success: false,
      status: 401,
      error: "Missing credentials (apiKey or accessToken)",
    };
  }

  const credentialError = cfg.requireCredentials?.(credentials);
  if (credentialError) {
    return { success: false, status: 401, error: credentialError };
  }

  const limit =
    Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : DEFAULT_MAX_RESULTS;
  const useModel = cfg.model
    ? cfg.model(model || searchModel(provider), credentials)
    : model || searchModel(provider);
  const url = cfg.endpoint(useModel, credentials);
  const body = cfg.buildBody(query, useModel, credentials);
  const headers = { ...cfg.buildHeaders(token), ...cfg.extraHeaders?.(credentials) };

  // Covers direct + follow-up turns; cleared via fail() or the finally block.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Single-turn request helper shared by direct + follow-up fetches
  const doFetch = async (reqBody) => {
    const upstreamStart = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      const d = await r.json().catch(() => null);
      return { resp: r, data: d, latency: Date.now() - upstreamStart };
    } catch (err) {
      return { err };
    }
  };

  const fail = (err) => {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      log?.warn?.(`[chatSearch] timeout provider=${provider}`);
      return { success: false, status: 504, error: "Upstream timeout" };
    }
    log?.error?.(`[chatSearch] network error provider=${provider}: ${err?.message}`);
    return {
      success: false,
      status: 502,
      error: `Network error: ${err?.message || "unknown"}`,
    };
  };

  const { resp, data, latency: upstreamLatency, err: fetchErr } = await doFetch(body);
  if (fetchErr) return fail(fetchErr);

  if (data === null) {
    return {
      success: false,
      status: 502,
      error: `Invalid upstream response (status ${resp.status})`,
    };
  }

  if (!resp.ok) {
    const errMsg =
      data?.error?.message || data?.error || data?.message || `Upstream HTTP ${resp.status}`;
    log?.warn?.(`[chatSearch] upstream error provider=${provider} status=${resp.status}`);
    return {
      success: false,
      status: resp.status,
      error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
    };
  }

  // Tool-mediated search: the upstream usually answers in a single turn with
  // results inline in the tool_call arguments. Only run the follow-up turn
  // when turn 1 produced neither text nor citations (some hosts require the
  // client to echo tool_calls back before searching server-side).
  try {
    let finalData = data;
    let extraLatency = 0;
    const first = cfg.extractAnswer(data);
    if (cfg.executeTools && !first.text && !(first.citations || []).length) {
      const toolCalls = finalData?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        const toolResults = await cfg.executeTools(toolCalls, {
          query,
          headers,
          url,
          log,
          credentials,
        });
        if (toolResults?.length) {
          const followUpBody = cfg.followUp(body, finalData, toolResults);
          const second = await doFetch(followUpBody);
          if (second.err) return fail(second.err);
          if (second.data === null || !second.resp.ok) {
            const msg =
              second.data?.error?.message ||
              second.data?.error ||
              `Upstream HTTP ${second.resp.status}`;
            return {
              success: false,
              status: second.resp.status,
              error: typeof msg === "string" ? msg : JSON.stringify(msg),
            };
          }
          finalData = second.data;
          extraLatency = second.latency;
        }
      }
    }

    // Citations live in turn-1 tool_call args, answer text in the final turn: merge.
    const last = finalData === data ? first : cfg.extractAnswer(finalData);
    const text = last.text || first.text;
    const citations = last.citations?.length ? last.citations : first.citations;
    if (!text && !(citations || []).length) {
      // Surface the raw upstream payload so unparsed shapes are diagnosable.
      log?.warn?.(
        `[chatSearch] ${provider} returned no text/citations — raw: ${JSON.stringify(finalData).slice(0, 500)}`,
      );
    }
    const tokens = finalData === data ? first.tokens : (first.tokens || 0) + (last.tokens || 0);
    const retrievedAt = new Date().toISOString();
    const limited = (citations || []).slice(0, limit);
    const results = limited.map((c, i) => toResult(c, i, provider, retrievedAt));

    return {
      success: true,
      status: 200,
      data: {
        provider,
        query,
        results,
        answer: { source: provider, text: text || "", model: useModel },
        usage: { queries_used: 1, search_cost_usd: 0, llm_tokens: tokens || 0 },
        metrics: {
          response_time_ms: Date.now() - startTime,
          upstream_latency_ms: upstreamLatency + extraLatency,
          total_results_available: null,
        },
        errors: [],
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export { CHAT_SEARCH_CONFIG };
