import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import {
  normalizeResponsesInput,
  resolveFunctionToolStrict,
} from "../translator/formats/responsesApi.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_DEFAULT_MODEL,
  GROK_CLI_VERSION,
  supportsGrokCliReasoningEffort,
} from "../config/grokCli.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { resolveSessionId, resolveContinuationId } from "../utils/sessionManager.js";
import { getConsistentMachineId } from "../shared/machineId.js";

// Server-generated item id prefixes that /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types executed server-side by Grok CLI backend
const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "x_search",
  "web_search_preview",
  "file_search",
  "image_generation",
  "code_interpreter",
  "mcp",
  "local_shell",
]);

// Fields accepted by cli-chat-proxy Responses API (mirrors Codex allowlist + Grok extras)
const RESPONSES_API_ALLOWLIST = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "metadata",
  "prompt_cache_key",
]);

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
const GROK_CLI_TURN_STORE_MAX = 5000;
const GROK_CLI_NATIVE_ITEM_ID =
  /^(?:rs|msg|fc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROK_CLI_FREEFORM_TOOL_PARAMETERS = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
};

// ponytail: compaction/recovery headers stay absent until tokenhop implements
// official server-assisted compaction state and recovery semantics.
function isTrustedGrokProxyUrl(url) {
  try {
    return new URL(String(url)).origin === new URL(GROK_CLI_BASE_URL).origin;
  } catch {
    return false;
  }
}

function newTraceparent() {
  let traceId = "";
  let spanId = "";
  while (/^0+$/.test(traceId) || traceId === "") {
    traceId = crypto.randomBytes(16).toString("hex");
  }
  while (/^0+$/.test(spanId) || spanId === "") {
    spanId = crypto.randomBytes(8).toString("hex");
  }
  return `00-${traceId}-${spanId}-00`;
}

function normalizeGrokCliIncludes(include) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(include) ? include : []) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

const REQUEST_STATE = Symbol("grok-cli-request-state");

const GROK_CLI_426_HINT =
  "Upstream requires a newer Grok CLI protocol version. Set GROK_CLI_VERSION to a supported official version and restart tokenhop (including the compose pin when applicable).";

function sanitizeGrokCliErrorDetail(value, maxLen = 300) {
  if (typeof value !== "string") return "";
  const scrubbed = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0/C1 control chars from untrusted upstream error text before logging
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /\b(bearer|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\b["\x27]?\s*(?:[:=]\s*|\s+)\S+/gi,
      "$1: [redacted]",
    )
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/xai-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .trim();
  if (!scrubbed || /^[{[<]/.test(scrubbed)) return "";
  return scrubbed.slice(0, maxLen).trim();
}

function extractGrokCliErrorDetail(bodyText) {
  if (!bodyText || typeof bodyText !== "string") return "";
  const trimmed = bodyText.trim().slice(0, 2000);
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed);
    const candidates = [json?.message, json?.error, json?.error?.message, json?.error?.code];
    for (const candidate of candidates) {
      const detail = sanitizeGrokCliErrorDetail(candidate);
      if (detail) return detail;
    }
    return "";
  } catch {
    return sanitizeGrokCliErrorDetail(trimmed);
  }
}

// Per-session last turn index so multi-turn headers never go backwards within this process
const sessionTurnStore = new Map();
let requestTurnStore = new WeakMap();

/**
 * Count user turns in a Responses `input` array.
 * Official CLI sets x-grok-turn-idx to the 1-based conversation turn (≈ user messages).
 * HAR: first chat turn → "1".
 */
export function countGrokCliUserTurns(input) {
  if (!Array.isArray(input)) return 1;
  let n = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const type = typeof item.type === "string" ? item.type : "";
    // Responses message items (type omitted or "message") with role user
    if (item.role === "user" && (!type || type === "message")) n += 1;
  }
  return Math.max(1, n);
}

/**
 * Resolve monotonic turn index for a session.
 * Prefers user-message count from the payload (full history clients), but never
 * decreases vs the last index observed for the same sessionId in this process.
 */
export function resolveGrokCliTurnIdx(sessionId, input, requestKey = null) {
  const fromInput = countGrokCliUserTurns(input);
  if (!sessionId) return fromInput;

  if (requestKey && requestTurnStore.has(requestKey)) {
    return requestTurnStore.get(requestKey);
  }

  const now = Date.now();
  const existing = sessionTurnStore.get(sessionId);
  const prev =
    existing && now - existing.lastUsed <= MEMORY_CONFIG.sessionTtlMs ? existing.turn : 0;
  if (existing) sessionTurnStore.delete(sessionId);

  // A new delta-style request advances the turn; retries reuse requestKey.
  const turn = prev > 0 ? Math.max(fromInput, prev + (requestKey ? 1 : 0)) : fromInput;
  while (sessionTurnStore.size >= GROK_CLI_TURN_STORE_MAX) {
    sessionTurnStore.delete(sessionTurnStore.keys().next().value);
  }
  sessionTurnStore.set(sessionId, { turn, lastUsed: now });
  if (requestKey) requestTurnStore.set(requestKey, turn);
  return turn;
}

/** Test helper — clear in-memory turn counters */
export function _resetGrokCliTurnStore() {
  sessionTurnStore.clear();
  requestTurnStore = new WeakMap();
}

export function _getGrokCliTurnStoreSize() {
  return sessionTurnStore.size;
}

export function normalizeGrokCliEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (effort === "max") return "xhigh";
  if (EFFORT_LEVELS.includes(effort)) return effort;
  return "high";
}

export { supportsGrokCliReasoningEffort } from "../config/grokCli.js";

export function resolveGrokCliSessionId(credentials, body) {
  // ponytail: clients without stable thread metadata share one connection session;
  // split further when their wire format exposes a durable conversation id.
  const explicitSessionBody = {
    prompt_cache_key: body?.prompt_cache_key,
    session_id: body?.session_id,
    conversation_id: body?.conversation_id,
    metadata: body?.metadata,
  };
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body: explicitSessionBody,
    connectionId: credentials?.connectionId || credentials?.id,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "grok-cli",
  });
}

function stringifyGrokCliToolOutput(output) {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  return JSON.stringify(output);
}

function isNativeGrokCliItemId(id) {
  return typeof id === "string" && GROK_CLI_NATIVE_ITEM_ID.test(id);
}

function normalizeGrokCliInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { internal_chat_message_metadata_passthrough: _metadata, ...clean } = item;

  if (item.type === "reasoning") {
    if (!isNativeGrokCliItemId(item.id) || typeof item.encrypted_content !== "string") return null;
    return clean;
  }

  if (item.type === "custom_tool_call") {
    const callId = item.call_id || item.id;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!callId || !name) return null;
    return {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify({
        input: stringifyGrokCliToolOutput(item.input ?? item.arguments),
      }),
    };
  }

  if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
    const callId = item.call_id || item.id;
    if (!callId) return null;
    return {
      type: "function_call_output",
      call_id: callId,
      output: stringifyGrokCliToolOutput(item.output),
    };
  }

  if (item.type === "function_call") {
    const callId = item.call_id || item.id;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!callId || !name) return null;
    return {
      type: "function_call",
      ...(isNativeGrokCliItemId(item.id) ? { id: item.id } : {}),
      call_id: callId,
      name,
      arguments:
        typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
    };
  }

  return clean;
}

export function normalizeGrokCliInput(body) {
  if (!Array.isArray(body?.input)) return body;
  const normalized = body.input.map(normalizeGrokCliInputItem).filter(Boolean);
  const callIds = new Set(
    normalized
      .filter((item) => item?.type === "function_call" && item.call_id)
      .map((item) => item.call_id),
  );
  body.input = normalized.filter(
    (item) => item?.type !== "function_call_output" || callIds.has(item.call_id),
  );
  return body;
}

function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (
        typeof item.id === "string" &&
        SERVER_ID_PATTERN.test(item.id) &&
        !isNativeGrokCliItemId(item.id)
      )
        delete item.id;
    }
    return true;
  });
}

/**
 * Flatten Chat Completions tool shape → Responses flat format.
 * Keep hosted tools (web_search / x_search) passthrough.
 */
function normalizeGrokCliTools(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
    return;
  }
  const validNames = new Set();
  const hostedTypes = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";

    if (type !== "function") {
      // Hosted tools: { type: "web_search" } / { type: "x_search" }
      if (HOSTED_TOOL_TYPES.has(type)) {
        hostedTypes.add(type);
        return true;
      }
      // Nested function shape without type
      if (!type && tool.function) {
        // fall through to function flatten below
      } else if (!type || typeof tool.name === "string") {
        // treat as bare function if name present
      } else {
        return false;
      }
    }

    const isFunction =
      type === "function" || type === "" || tool.function || typeof tool.name === "string";
    if (!isFunction || HOSTED_TOOL_TYPES.has(type)) {
      return HOSTED_TOOL_TYPES.has(type);
    }

    const fn =
      tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
        ? tool.function
        : null;
    const rawName =
      typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
    const name = rawName.trim();
    if (!name) return false;

    const description =
      typeof tool.description === "string"
        ? tool.description
        : typeof fn?.description === "string"
          ? fn.description
          : "";
    const parameters =
      type === "custom"
        ? GROK_CLI_FREEFORM_TOOL_PARAMETERS
        : tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
          ? tool.parameters
          : fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
            ? fn.parameters
            : { type: "object", properties: {} };

    const strict = resolveFunctionToolStrict(tool);
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    if (strict !== undefined) tool.strict = strict;
    validNames.add(tool.name);
    return true;
  });

  if (body.tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
    return;
  }

  if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    !Array.isArray(body.tool_choice)
  ) {
    const choiceType = typeof body.tool_choice.type === "string" ? body.tool_choice.type : "";
    if (choiceType === "function" || choiceType === "custom") {
      const rawName = body.tool_choice.name ?? body.tool_choice.function?.name;
      const name = typeof rawName === "string" ? rawName.trim().slice(0, 128) : "";
      if (!name || !validNames.has(name)) delete body.tool_choice;
      else body.tool_choice = { type: "function", name };
    } else if (!hostedTypes.has(choiceType)) {
      delete body.tool_choice;
    }
  }
}

function resolveEffortFromModel(modelId) {
  if (!modelId || typeof modelId !== "string") return null;
  for (const level of EFFORT_LEVELS) {
    if (modelId.endsWith(`-${level}`)) return level;
  }
  return null;
}

/**
 * Grok CLI Executor — OpenAI Responses API on cli-chat-proxy.grok.com
 * Auth: OAuth device-code access token (xai-grok-cli).
 */
export class GrokCliExecutor extends BaseExecutor {
  constructor() {
    super("grok-cli", PROVIDERS["grok-cli"]);
    this._currentSessionId = null;
    this._currentReqId = null;
    this._currentTurnIdx = 1;
    this._agentId = null;
    this._machineAgentId = null;
  }

  buildUrl() {
    return this.config.baseUrl;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("grok-cli", credentials, log, proxyOptions);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("grok-cli", credentials);
  }

  buildHeaders(credentials, stream = true, url = this.config.baseUrl, _model = null, body = null) {
    const headers = super.buildHeaders(credentials, stream);
    const state = body?.[REQUEST_STATE];
    const trusted = isTrustedGrokProxyUrl(url);
    headers.traceparent = newTraceparent();
    // Endpoint-specific Responses fingerprint: token auth, authenticate-response,
    // and client mode only for the built-in trusted proxy origin.
    if (trusted) {
      headers["x-xai-token-auth"] = "xai-grok-cli";
      headers["x-authenticateresponse"] = "authenticate-response";
      headers["x-grok-client-mode"] = "headless";
    }

    // Static fingerprint from registry
    const staticHeaders = this.config.headers || {};
    for (const [k, v] of Object.entries(staticHeaders)) {
      if (v != null && headers[k] === undefined) headers[k] = v;
    }

    headers["x-grok-client-identifier"] =
      this.config.clientIdentifier ||
      headers["x-grok-client-identifier"] ||
      GROK_CLI_CLIENT_IDENTIFIER;
    headers["x-grok-client-version"] =
      this.config.clientVersion || headers["x-grok-client-version"] || GROK_CLI_VERSION;

    const sessionId = state?.sessionId || this._currentSessionId || crypto.randomUUID();
    const reqId = state?.reqId || crypto.randomUUID();
    const turnIdx = state?.turnIdx ?? this._currentTurnIdx ?? 1;
    const agentId = state ? state.agentId : this._agentId;
    const modelOverride = state?.modelOverride ?? this._currentModel;
    headers["x-grok-session-id"] = sessionId;
    // CLI uses the same id for conv + session on chat turns
    headers["x-grok-conv-id"] = sessionId;
    if (state?.convGroupId && trusted) {
      headers["x-grok-conv-group-id"] = state.convGroupId;
    }
    headers["x-grok-req-id"] = reqId;
    headers["x-grok-turn-idx"] = String(turnIdx || 1);

    if (agentId) headers["x-grok-agent-id"] = agentId;

    // Surface model override (CLI always sets this)
    if (modelOverride) headers["x-grok-model-override"] = modelOverride;

    // Models/usage retain identity headers; Responses construction omits email/user.
    // `postExchange` still stores user identity for those discovery flows.

    return headers;
  }

  parseError(response, bodyText) {
    // 402 personal-team-blocked:spending-limit → surface as payment/quota for fallback
    if (response.status === 402 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const code = json?.code || "";
        const msg = json?.error || json?.message || bodyText;
        return {
          status: 402,
          message: typeof msg === "string" ? msg : bodyText,
          code: typeof code === "string" ? code : undefined,
        };
      } catch {
        /* fall through */
      }
    }
    // 426 version gate → actionable GROK_CLI_VERSION guidance, redacted detail
    if (response.status === 426) {
      const detail = extractGrokCliErrorDetail(bodyText);
      return {
        status: 426,
        message: detail
          ? `HTTP 426: ${detail} — ${GROK_CLI_426_HINT}`
          : `HTTP 426 — ${GROK_CLI_426_HINT}`,
      };
    }
    return super.parseError(response, bodyText);
  }

  transformRequest(model, body, stream, credentials) {
    // Session / request ids for headers — stable per client conversation when possible.
    // Prompt_cache_key: falsy/malformed keys dropped BEFORE session resolve so a
    // rejected value never influences the identity; valid keys resolve FIRST.
    const requestKey = body;
    body = { ...body };
    if (
      body?.prompt_cache_key != null &&
      (typeof body.prompt_cache_key !== "string" ||
        !body.prompt_cache_key.trim() ||
        body.prompt_cache_key.length > 256 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately rejects cache keys containing C0/C1 control characters
        /[\u0000-\u001f\u007f-\u009f]/.test(body.prompt_cache_key))
    ) {
      delete body.prompt_cache_key;
    }
    this._currentSessionId = resolveGrokCliSessionId(credentials, body);
    this._currentReqId = crypto.randomUUID();
    // Executor is a shared singleton: fall back to the machine id, never to the
    // previous request's connection id.
    this._agentId =
      credentials?.providerSpecificData?.deviceId ||
      credentials?.providerSpecificData?.agentId ||
      this._machineAgentId;
    // Insert resolved identity only when the caller gave no valid cache key.
    if (body.prompt_cache_key == null) body.prompt_cache_key = this._currentSessionId;

    // Normalize Responses input
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Chat Completions clients arrive with messages[] — translator should have
    // converted already, but guard empty input.
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      if (Array.isArray(body.messages) && body.messages.length > 0) {
        // Soft fallback: map messages → input messages (string content only)
        body.input = body.messages.map((m) => ({
          type: "message",
          role: m.role || "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        }));
        delete body.messages;
      } else {
        body.input = [{ type: "message", role: "user", content: "..." }];
      }
    }

    // Keep role:"system" as-is — official grok-pager HAR sends system, not developer
    // (Codex converts system→developer; Grok CLI does not).
    normalizeGrokCliInput(body);
    stripStoredItemReferences(body);
    normalizeGrokCliTools(body);

    // Turn index after input is finalized (user-message count, monotonic per session)
    this._currentTurnIdx = resolveGrokCliTurnIdx(this._currentSessionId, body.input, requestKey);

    body.stream = true;
    body.store = false;

    // Resolve upstream model id (strip effort suffix virtual models)
    const modelEffort = resolveEffortFromModel(body.model || model);
    let resolvedModel = body.model || model || GROK_CLI_DEFAULT_MODEL;
    if (modelEffort) {
      resolvedModel = resolvedModel.replace(new RegExp(`-${modelEffort}$`), "");
    }
    resolvedModel = getModelUpstreamId("gcli", resolvedModel) || resolvedModel;
    // Also try provider id key
    if (resolvedModel === (body.model || model)) {
      resolvedModel = getModelUpstreamId("grok-cli", resolvedModel) || resolvedModel;
    }
    body.model = resolvedModel;
    this._currentModel = resolvedModel;

    // Reasoning effort priority: explicit > reasoning_effort > model suffix > default high.
    // grok-build and Composer reject reasoningEffort but still accept summary/encrypted continuity.
    const supportsReasoningEffort = supportsGrokCliReasoningEffort(resolvedModel);
    body.reasoning =
      body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? { ...body.reasoning }
        : {};
    if (supportsReasoningEffort) {
      body.reasoning.effort = normalizeGrokCliEffort(
        body.reasoning.effort || body.reasoning_effort || modelEffort,
      );
    } else {
      delete body.reasoning.effort;
    }
    if (body.reasoning.summary === "none") delete body.reasoning.summary;
    else if (!body.reasoning.summary) body.reasoning.summary = "concise";
    delete body.reasoning_effort;

    body.include = normalizeGrokCliIncludes([
      ...(Array.isArray(body.include) ? body.include : []),
      "reasoning.encrypted_content",
      ...(isTrustedGrokProxyUrl(this.config.baseUrl) ? ["no_inline_citations"] : []),
    ]);

    // Drop Chat Completions leftovers that Responses rejects
    delete body.messages;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.n;
    delete body.seed;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logit_bias;
    delete body.user;
    delete body.stream_options;
    delete body.prompt_cache_retention;
    delete body.safety_identifier;
    delete body.previous_response_id; // store=false → cannot resolve

    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    Object.defineProperty(body, REQUEST_STATE, {
      value: {
        sessionId: this._currentSessionId,
        reqId: this._currentReqId,
        turnIdx: this._currentTurnIdx,
        agentId: this._agentId,
        modelOverride: resolvedModel,
        convGroupId: resolveContinuationId({
          sessionId: this._currentSessionId,
          connectionId: credentials?.connectionId || credentials?.id,
          scope: "grok-cli",
        }),
      },
    });
    return body;
  }

  async execute(args) {
    // Resolve the stable machine agent id once per process; transformRequest
    // uses it for connections without deviceId/agentId.
    if (!this._machineAgentId) {
      try {
        // getConsistentMachineId returns 16 hex chars; stretch to 32 for a UUID layout.
        const mid = await getConsistentMachineId("grok-cli-agent");
        const hex = crypto.createHash("sha256").update(mid).digest("hex");
        this._machineAgentId = [
          hex.slice(0, 8),
          hex.slice(8, 12),
          "5" + hex.slice(13, 16),
          "a" + hex.slice(17, 20),
          hex.slice(20, 32),
        ].join("-");
      } catch {
        this._machineAgentId = crypto.randomUUID();
      }
    }

    return super.execute(args);
  }
}

export default GrokCliExecutor;
