import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import {
  buildRequestDetail,
  extractRequestConfig,
  extractUsageFromResponse,
  saveUsageStats,
  formatDoneLine,
} from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { openAICompletionToClientFormat } from "./completionToClient.js";
import { toOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { geminiUsageCounts } from "../../translator/concerns/usage.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { GEMINI_FINISH, OPENAI_FINISH } from "../../translator/schema/finishReasons.js";

/**
 * Translate a non-streaming provider body into the client's format (pivoting
 * through OpenAI chat.completion).
 */
export function translateNonStreamingResponse(
  responseBody,
  targetFormat,
  sourceFormat,
  customToolNames = null,
) {
  if (targetFormat === sourceFormat) return responseBody;
  // Provider responded in OpenAI Chat Completions shape — convert to the
  // client's format so tool_calls/text surface natively.
  if (targetFormat === FORMATS.OPENAI)
    return openAICompletionToClientFormat(responseBody, sourceFormat, customToolNames);

  // Gemini / Antigravity
  if (
    targetFormat === FORMATS.GEMINI ||
    targetFormat === FORMATS.ANTIGRAVITY ||
    targetFormat === FORMATS.GEMINI_CLI ||
    targetFormat === FORMATS.VERTEX
  ) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "",
      reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = toOpenAIFinish(candidate.finishReason || GEMINI_FINISH.STOP, "gemini");
    if (finishReason === OPENAI_FINISH.STOP && toolCalls.length > 0)
      finishReason = OPENAI_FINISH.TOOL_CALLS;

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }],
    };

    if (usage) {
      // Gemini excludes thoughts from candidatesTokenCount: thoughts go on the completion side.
      const counts = geminiUsageCounts(usage);
      result.usage = {
        prompt_tokens: counts.prompt,
        completion_tokens: counts.completion,
        total_tokens: counts.total || counts.prompt + counts.completion,
      };
      // promptTokenCount already includes cachedContentTokenCount.
      if (counts.cached > 0) {
        result.usage.prompt_tokens_details = { cached_tokens: counts.cached };
      }
      if (counts.reasoning > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: counts.reasoning };
      }
    }
    return openAICompletionToClientFormat(result, sourceFormat, customToolNames);
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format. Convert that actual OpenAI response
    // into the client's format. A non-array content value likely belongs to a different
    // non-Claude format and stays unchanged.
    if (responseBody.choices)
      return openAICompletionToClientFormat(responseBody, sourceFormat, customToolNames);
    if (responseBody.content && !Array.isArray(responseBody.content)) return responseBody;

    let textContent = "",
      thinkingContent = "";
    const toolCalls = [];

    for (const block of responseBody.content || []) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    const finishReason = toOpenAIFinish(responseBody.stop_reason, "claude");

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }],
    };

    if (responseBody.usage) {
      // Anthropic input_tokens EXCLUDES cache; OpenAI prompt_tokens includes it.
      const usage = responseBody.usage;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const promptTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate;
      const completionTokens = usage.output_tokens || 0;
      result.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      if (cacheRead > 0 || cacheCreate > 0) {
        result.usage.prompt_tokens_details = {
          ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
          ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}),
        };
      }
    }
    return openAICompletionToClientFormat(result, sourceFormat, customToolNames);
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return openAICompletionToClientFormat(
      ollamaBodyToOpenAI(responseBody),
      sourceFormat,
      customToolNames,
    );
  }

  return responseBody;
}

/**
 * Summarize a client-format body for the request-detail log. The pivot is an
 * OpenAI chat.completion, but the logged `translatedResponse` is already the
 * client format (Claude message / Responses body / chat.completion).
 */
function summarizeClientResponse(body) {
  if (body?.choices?.[0]) {
    const message = body.choices[0].message || {};
    return {
      content: message.content || null,
      thinking: message.reasoning_content || null,
      finish_reason: body.choices[0].finish_reason || "unknown",
    };
  }
  // Claude message: content blocks (+ top-level stop_reason).
  if (body?.type === "message" && Array.isArray(body.content)) {
    const text = body.content
      .filter((block) => block?.type === CLAUDE_BLOCK.TEXT && block.text)
      .map((block) => block.text)
      .join("");
    const thinking = body.content
      .filter((block) => block?.type === CLAUDE_BLOCK.THINKING && block.thinking)
      .map((block) => block.thinking)
      .join("");
    return {
      content: text || null,
      thinking: thinking || null,
      finish_reason: body.stop_reason || "unknown",
    };
  }
  // Responses body: message items hold output_text, reasoning items hold summary.
  if (body?.object === "response" && Array.isArray(body.output)) {
    const text = body.output
      .filter((item) => item?.type === RESPONSES_ITEM.MESSAGE && Array.isArray(item.content))
      .flatMap((item) => item.content)
      .filter((part) => part?.type === RESPONSES_ITEM.OUTPUT_TEXT && part.text)
      .map((part) => part.text)
      .join("");
    const thinking = body.output
      .filter((item) => item?.type === RESPONSES_ITEM.REASONING && Array.isArray(item.summary))
      .flatMap((item) => item.summary)
      .filter((part) => part?.type === RESPONSES_ITEM.SUMMARY_TEXT && part.text)
      .map((part) => part.text)
      .join("");
    return {
      content: text || null,
      thinking: thinking || null,
      finish_reason: body.status || "unknown",
    };
  }
  return {
    content: body?.content || null,
    thinking: body?.reasoning_content || null,
    finish_reason: body?.finish_reason || "unknown",
  };
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({
  providerResponse,
  provider,
  model,
  sourceFormat,
  targetFormat,
  body,
  stream,
  translatedBody,
  finalBody,
  requestStartTime,
  connectionId,
  apiKey,
  clientRawRequest,
  onRequestSuccess,
  reqLogger,
  toolNameMap,
  customToolNames,
  trackDone,
  appendLog,
  pxpipe,
  savings,
  comboName,
  reqTag,
  log,
}) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        "Invalid SSE response for non-streaming request",
      );
    }
    responseBody = parsed;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  // Unwrap before any consumer reads choices/usage so non-stream clients get a
  // bare OpenAI body and usage tracking sees data.usage. No-op unless the
  // provider opts in via transport.quirks.clineEnvelope.
  responseBody = unwrapClineEnvelope(responseBody, provider);

  reqLogger.logProviderResponse(
    providerResponse.status,
    providerResponse.statusText,
    providerResponse.headers,
    responseBody,
  );
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch((err) => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({
    provider,
    model,
    tokens: usage,
    connectionId,
    apiKey,
    endpoint: clientRawRequest?.endpoint,
    userAgent: clientRawRequest?.headers?.["user-agent"],
    savings,
    comboName,
    silent: true,
  });
  if (log?.line)
    log.line(
      reqTag,
      "📊",
      formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }),
    );

  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames)
    : responseBody;
  const isClaudeMessageResponse =
    sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse =
    sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== "tool_calls") {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(
      addBufferToUsage(translatedResponse.usage),
      sourceFormat,
    );
  }

  // Strip reasoning_content only when content is non-empty.
  // When content is empty (e.g. thinking models that used all tokens for reasoning),
  // reasoning_content is the only useful output and must be preserved.
  if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(
    buildRequestDetail(
      {
        provider,
        model,
        connectionId,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        providerResponse: responseBody || null,
        response: summarizeClientResponse(translatedResponse),
        pxpipe,
        status: "success",
      },
      { endpoint: clientRawRequest?.endpoint || null },
    ),
  ).catch((err) => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(translatedResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}
