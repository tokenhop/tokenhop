import { authorizeGatewayTarget, resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { handleChat } from "@/sse/handlers/chat.js";
import {
  clearAccountError,
  getProviderCredentials,
  markAccountUnavailable,
} from "@/sse/services/auth.js";
import { getModelInfo } from "@/sse/services/model.js";
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";
import { initTranslators } from "open-sse/translator/index.js";
import {
  grantRateLimitResponse,
  releaseGrantReservation,
} from "@/sse/services/grantRateLimiter.js";

let initialized = false;
const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// Gemini model id charset (matches sanitizeGeminiFunctionName); blocks path traversal in upstream URL.
const GEMINI_NATIVE_MODEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1beta/models/{model}:generateContent        — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent  — streaming (SSE)
 *
 * Streaming intent is determined by the URL action suffix (canonical Gemini API
 * convention), NOT by a body field. generationConfig.stream is not a real
 * Gemini API field and Gemini CLI never sets it.
 *
 * The @google/genai SDK always uses :streamGenerateContent?alt=sse for chat.
 * The upstream handleChat returns OpenAI SSE format; we transform it to
 * Gemini SSE format on the fly via transformOpenAISSEToGeminiSSE().
 */
export async function POST(request, { params }) {
  await ensureInitialized();

  try {
    const auth = await resolveGatewayAuth(request);
    if (auth instanceof Response) return auth;
    const gateway = auth.principal;
    const { path } = await params;
    // path = ["provider", "model:action"] or ["model:action"]. Model ids may
    // themselves contain ":" (e.g. "ollama/llama3:8b"), so the action is the
    // text after the LAST ":" and the model is everything before it.
    const full = path.join("/");
    const colonIndex = full.lastIndexOf(":");
    const model = colonIndex === -1 ? full : full.slice(0, colonIndex);
    const actionName = colonIndex === -1 ? "" : full.slice(colonIndex + 1);

    if (
      actionName !== "generateContent" &&
      actionName !== "streamGenerateContent" &&
      actionName !== "countTokens"
    ) {
      return Response.json(
        { error: { message: `Unsupported action: ${actionName}`, code: 400 } },
        { status: 400 },
      );
    }
    // The native TTS path passes `action` with a leading ":" to
    // buildGeminiNativeUrl, which appends it to the upstream model URL.
    const action = `:${actionName}`;

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: { message: "Invalid JSON body", code: 400 } }, { status: 400 });
    }

    if (actionName === "countTokens") {
      return Response.json(
        { totalTokens: countGeminiTextTokens(body) },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (isGeminiNativeTtsRequest(model, body)) {
      return await forwardGeminiNativeRequest(request, body, model, action, gateway);
    }

    // Streaming is determined by URL action suffix:
    //   :streamGenerateContent => stream: true  (SSE)
    //   :generateContent       => stream: false (plain JSON)
    const stream = action === ":streamGenerateContent";

    // Canonical scope check before any upstream work; handleChat re-enforces
    // combos/aliases downstream with the same principal.
    const translatedInfo = await getModelInfo(model, gateway ? { principal: gateway } : {});
    if (translatedInfo?.provider) {
      const denied = authorizeGatewayTarget(gateway, {
        modelId: `${translatedInfo.provider}/${translatedInfo.model}`,
      });
      if (denied) return denied;
    }

    // Convert Gemini request format to OpenAI/internal format
    const convertedBody = convertGeminiToInternal(body, model, stream);

    // Preserve incoming identity/carriers verbatim (headers + ?key= URL) and
    // thread the already-authorized principal so handleChat never re-derives
    // or synthesizes a different authority. Body is forwarded as text: the
    // original request was already consumed once above.
    const newRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(convertedBody),
    });

    const response = await handleChat(
      newRequest,
      null,
      gateway ? { principal: gateway } : undefined,
    );

    if (stream) {
      // Transform OpenAI SSE => Gemini SSE on the fly.
      // The @google/genai SDK always uses :streamGenerateContent?alt=sse and
      // expects Gemini SSE chunks (no [DONE] sentinel — stream just closes).
      return transformOpenAISSEToGeminiSSE(response, model);
    } else {
      // Convert OpenAI JSON response => Gemini GenerateContentResponse
      return await convertOpenAIResponseToGemini(response, model);
    }
  } catch (error) {
    console.log("Error handling Gemini request:", error);
    return Response.json({ error: { message: error.message, code: 500 } }, { status: 500 });
  }
}

function contentTextLength(content) {
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts.reduce(
    (sum, part) => sum + (typeof part?.text === "string" ? part.text.length : 0),
    0,
  );
}

/**
 * Local token estimate for :countTokens (chars/4, same heuristic as
 * /v1/messages/count_tokens). Accepts both the top-level and the
 * `generateContentRequest` request shapes.
 * ponytail: text-only; inlineData/fileData media parts count as 0. Forward to
 * upstream :countTokens when a client needs exact counts.
 */
function countGeminiTextTokens(body) {
  let chars = 0;
  for (const req of [body, body?.generateContentRequest]) {
    const contents = Array.isArray(req?.contents) ? req.contents : [];
    for (const content of contents) chars += contentTextLength(content);
    chars += contentTextLength(req?.systemInstruction);
  }
  return Math.ceil(chars / 4);
}

function normalizeGeminiNativeModel(model) {
  return String(model || "")
    .replace(/^models\//, "")
    .replace(/^gemini\//, "");
}

function getGeminiTtsModelIds() {
  return new Set([
    ...(PROVIDER_MODELS.gemini || [])
      .filter((model) => (model.kind || model.type) === "tts")
      .map((model) => model.id),
    ...(PROVIDER_MODELS["gemini-tts-models"] || []).map((model) => model.id),
  ]);
}

function hasAudioResponseModality(body) {
  const modalities = body?.generationConfig?.responseModalities;
  return (
    Array.isArray(modalities) &&
    modalities.some((modality) => String(modality).toUpperCase() === "AUDIO")
  );
}

function isGeminiNativeTtsRequest(model, body) {
  const rawModel = String(model || "");
  if (
    rawModel.includes("/") &&
    !rawModel.startsWith("gemini/") &&
    !rawModel.startsWith("models/")
  ) {
    return false;
  }

  const modelId = normalizeGeminiNativeModel(model);
  return hasAudioResponseModality(body) || getGeminiTtsModelIds().has(modelId);
}

function buildGeminiNativeUrl(requestUrl, model, action) {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(
    `${GEMINI_NATIVE_BASE_URL}/${normalizeGeminiNativeModel(model)}${action}`,
  );

  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (key === "key") continue;
    upstreamUrl.searchParams.append(key, value);
  }

  return upstreamUrl.toString();
}

function buildGeminiNativeAuthHeaders(credentials) {
  if (credentials?.apiKey) return { "x-goog-api-key": credentials.apiKey };
  if (credentials?.accessToken) return { Authorization: `Bearer ${credentials.accessToken}` };
  return null;
}

function corsHeadersFrom(response) {
  const headers = new Headers(response.headers);
  // Node fetch may expose a decoded body while preserving upstream compression
  // headers. Forwarding those headers makes clients decompress plain bytes again.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function getSafeGeminiConnectionLabel(credentials) {
  const connectionId = String(credentials?.connectionId || "unknown");
  const shortId = connectionId.slice(0, 8);
  const connectionName = String(credentials?.connectionName || "");
  if (!connectionName || connectionName.includes("@")) return shortId;
  return `${connectionName}:${shortId}`;
}

function getGeminiNativeErrorCode(error) {
  return error?.cause?.code || error?.code || error?.cause?.name || error?.name || "UNKNOWN";
}

function isGeminiNativeTimeoutError(error, timedOut) {
  if (timedOut) return true;
  const code = getGeminiNativeErrorCode(error);
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "HeadersTimeoutError";
}

function getSafeGeminiNativeErrorText(error) {
  const message = error?.message || String(error);
  const code = getGeminiNativeErrorCode(error);
  return `${message} (${code})`;
}

async function forwardGeminiNativeRequest(request, body, model, action, gateway) {
  const modelId = normalizeGeminiNativeModel(model);
  if (!GEMINI_NATIVE_MODEL_PATTERN.test(modelId)) {
    return Response.json({ error: { message: "Invalid model" } }, { status: 400 });
  }
  const denied = authorizeGatewayTarget(gateway, { modelId: `gemini/${modelId}` });
  if (denied) return denied;
  const gatewayCreds = gateway ? { principal: gateway } : {};
  const excludeConnectionIds = new Set();
  const bodyText = JSON.stringify(body);
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(
      "gemini",
      excludeConnectionIds,
      modelId,
      gatewayCreds,
    );
    if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
    if (!credentials || credentials.allRateLimited) {
      console.log(
        `[GEMINI_NATIVE] exhausted model=${modelId} status=${lastStatus || Number(credentials?.lastErrorCode) || 503} error=${lastError || credentials?.lastError || "No active credentials for provider: gemini"}`,
      );
      return Response.json(
        {
          error: {
            message:
              lastError || credentials?.lastError || "No active credentials for provider: gemini",
          },
        },
        { status: lastStatus || Number(credentials?.lastErrorCode) || 503 },
      );
    }

    const authHeaders = buildGeminiNativeAuthHeaders(credentials);
    if (!authHeaders) {
      return Response.json({ error: { message: "No Gemini API key configured" } }, { status: 404 });
    }

    const safeConnection = getSafeGeminiConnectionLabel(credentials);
    const startedAt = Date.now();
    const upstreamUrl = buildGeminiNativeUrl(request.url, modelId, action);
    const attemptController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS);
    const abortAttempt = () => attemptController.abort();

    if (request.signal?.aborted) {
      console.log(`[GEMINI_NATIVE] client aborted model=${modelId} ms=0 conn=${safeConnection}`);
      return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
    }

    request.signal?.addEventListener("abort", abortAttempt, { once: true });
    console.log(
      `[GEMINI_NATIVE] start model=${modelId} action=${action} conn=${safeConnection} body=${Buffer.byteLength(bodyText)}B timeout=${GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS}`,
    );

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("Content-Type") || "application/json",
          ...authHeaders,
        },
        body: bodyText,
        signal: attemptController.signal,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (request.signal?.aborted && !timedOut) {
        console.log(
          `[GEMINI_NATIVE] client aborted model=${modelId} ms=${durationMs} conn=${safeConnection}`,
        );
        return Response.json({ error: { message: "Client closed request" } }, { status: 499 });
      }

      const status = isGeminiNativeTimeoutError(error, timedOut) ? 504 : 502;
      const errorText = getSafeGeminiNativeErrorText(error);
      console.log(
        `[GEMINI_NATIVE] fetch failed model=${modelId} status=${status} ms=${durationMs} conn=${safeConnection} error=${errorText}`,
      );

      releaseGrantReservation(credentials.grantReservation);

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        status,
        errorText,
        "gemini",
        modelId,
        null,
        { grantId: credentials.grantId },
      );

      if (shouldFallback) {
        excludeConnectionIds.add(credentials.connectionId);
        lastError = errorText;
        lastStatus = status;
        console.log(
          `[GEMINI_NATIVE] fallback model=${modelId} status=${status} conn=${safeConnection} exclude=${excludeConnectionIds.size}`,
        );
        continue;
      }

      return Response.json({ error: { message: errorText } }, { status });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortAttempt);
    }

    console.log(
      `[GEMINI_NATIVE] upstream model=${modelId} status=${upstreamResponse.status} ms=${Date.now() - startedAt} conn=${safeConnection} ct=${upstreamResponse.headers.get("content-type") || "?"} cl=${upstreamResponse.headers.get("content-length") || "?"}`,
    );

    if (upstreamResponse.ok) {
      await clearAccountError(credentials.connectionId, credentials, modelId);
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: corsHeadersFrom(upstreamResponse),
      });
    }

    const errorText = await upstreamResponse.text();
    releaseGrantReservation(credentials.grantReservation);
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      upstreamResponse.status,
      errorText,
      "gemini",
      modelId,
      null,
      { grantId: credentials.grantId },
    );

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorText;
      lastStatus = upstreamResponse.status;
      continue;
    }

    return new Response(errorText, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: corsHeadersFrom(upstreamResponse),
    });
  }
}

/**
 * Convert Gemini request format to OpenAI/internal format.
 *
 * @param {object} geminiBody  - parsed Gemini request body
 * @param {string} model       - resolved model string (e.g. "gemini-pro-high")
 * @param {boolean} stream     - whether to stream (from URL action)
 */
function convertGeminiToInternal(geminiBody, model, stream) {
  const messages = [];

  // Convert system instruction
  if (geminiBody.systemInstruction) {
    const systemText = geminiBody.systemInstruction.parts?.map((p) => p.text).join("\n") || "";
    if (systemText) {
      messages.push({ role: "system", content: systemText });
    }
  }

  // Convert contents to messages
  if (geminiBody.contents) {
    for (const content of geminiBody.contents) {
      const role = content.role === "model" ? "assistant" : "user";
      const text = content.parts?.map((p) => p.text).join("\n") || "";
      messages.push({ role, content: text });
    }
  }

  return {
    model,
    messages,
    stream,
    max_tokens: geminiBody.generationConfig?.maxOutputTokens,
    temperature: geminiBody.generationConfig?.temperature,
    top_p: geminiBody.generationConfig?.topP,
  };
}

/** Map OpenAI finish_reason => Gemini finishReason */
const FINISH_REASON_MAP = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  content_filter: "SAFETY",
};

/** Convert one OpenAI SSE line to a Gemini chunk, or null to skip it. */
function openAISSELineToGeminiChunk(line, model) {
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trim();

  // Drop empty lines and the OpenAI [DONE] sentinel.
  // Gemini SSE ends by stream close, no sentinel needed.
  if (!data || data === "[DONE]") return null;

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  const choice = parsed.choices?.[0];
  if (!choice) return null;

  const delta = choice.delta || {};

  const parts = [];
  if (delta.reasoning_content) {
    parts.push({ text: delta.reasoning_content, thought: true });
  }
  if (delta.content) {
    parts.push({ text: delta.content });
  }

  // Skip pure role-only deltas with no content and no finish signal
  if (parts.length === 0 && !choice.finish_reason) return null;

  const candidate = {
    content: {
      role: "model",
      parts: parts.length > 0 ? parts : [{ text: "" }],
    },
    index: 0,
  };

  if (choice.finish_reason) {
    candidate.finishReason = FINISH_REASON_MAP[choice.finish_reason] || "STOP";
  }

  const geminiChunk = { candidates: [candidate] };

  // Attach usage + modelVersion on the final chunk (when finish_reason is set)
  if (choice.finish_reason && parsed.usage) {
    geminiChunk.usageMetadata = {
      promptTokenCount: parsed.usage.prompt_tokens || 0,
      candidatesTokenCount: parsed.usage.completion_tokens || 0,
      totalTokenCount: parsed.usage.total_tokens || 0,
    };
    const reasoningTokens = parsed.usage.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      geminiChunk.usageMetadata.thoughtsTokenCount = reasoningTokens;
    }
    geminiChunk.modelVersion = parsed.model || model;
  }

  return geminiChunk;
}

/**
 * Transform an OpenAI SSE stream into a Gemini SSE stream.
 *
 * OpenAI SSE format (what handleChat returns):
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Gemini SSE format (what @google/genai SDK expects):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"index":0}]}
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
 *   (stream closes — no [DONE])
 *
 * Lines are buffered across chunks, so an event split by the network is
 * converted once it is complete.
 */
function transformOpenAISSEToGeminiSSE(upstreamResponse, model) {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // Network chunks can end mid-line; carry the partial line to the next chunk.
  let buffer = "";

  const emitLine = (line, controller) => {
    const geminiChunk = openAISSELineToGeminiChunk(line.replace(/\r$/, ""), model);
    if (geminiChunk) {
      controller.enqueue(encoder.encode("data: " + JSON.stringify(geminiChunk) + "\r\n\r\n"));
    }
  };

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) emitLine(line, controller);
    },
    // Gemini SSE ends by stream close (no sentinel); just drain the last line.
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) emitLine(buffer, controller);
    },
  });

  return new Response(upstreamResponse.body.pipeThrough(transformStream), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Convert an OpenAI chat.completion JSON response into a Gemini
 * GenerateContentResponse so that Gemini CLI can parse it.
 */
async function convertOpenAIResponseToGemini(response, model) {
  if (!response.ok) return response;

  let body;
  try {
    body = await response.json();
  } catch {
    return response;
  }

  if (body.candidates)
    return Response.json(body, {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });

  if (body.error)
    return Response.json(body, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });

  const choice = body.choices?.[0];
  if (!choice) {
    return Response.json(body, {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const { message, finish_reason } = choice;

  const parts = [];
  if (message.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }
  parts.push({ text: message.content || "" });

  const finishReason = FINISH_REASON_MAP[finish_reason] || "STOP";

  const geminiResponse = {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    modelVersion: body.model || model,
  };

  if (body.usage) {
    geminiResponse.usageMetadata = {
      promptTokenCount: body.usage.prompt_tokens || 0,
      candidatesTokenCount: body.usage.completion_tokens || 0,
      totalTokenCount: body.usage.total_tokens || 0,
    };
    const reasoningTokens = body.usage.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      geminiResponse.usageMetadata.thoughtsTokenCount = reasoningTokens;
    }
  }

  return Response.json(geminiResponse, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
