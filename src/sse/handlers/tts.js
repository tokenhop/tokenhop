import { getProviderCredentials, markAccountUnavailable, extractApiKey } from "../services/auth.js";
import {
  authorizeGatewayTarget,
  gatewayKeyContext,
  resolveGatewayAuth,
} from "@/lib/auth/gatewayAuth.js";
import { saveRequestUsageUnscoped } from "@/lib/usageDb.js";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { getModelInfo, getComboModels, getComboByName } from "../services/model.js";
import { comboRotationKey, comboStrategyFor } from "@/lib/comboKeys.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import { loadComboHeadroomFn } from "../services/comboHeadroom.js";
import * as log from "../utils/logger.js";
import { grantRateLimitResponse, releaseGrantReservation } from "../services/grantRateLimiter.js";
import { budgetResponse, budgeted } from "../services/budgetGuard.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(
      ([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none",
    )
    .map(([id]) => id),
);

// OpenAI /v1/audio/speech body `response_format` = audio codec. The query
// `response_format` (mp3 | json) is our own envelope switch and stays separate.
const AUDIO_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  const style = body.style || ""; // Optional style/voice instructions (e.g. Xiaomi MiMo)
  log.request(
    "POST",
    `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`,
  );

  // Authenticate before reading caller-scoped preferences: the gateway
  // principal selects the effective combo-strategy view.
  const auth = await resolveGatewayAuth(request);
  if (auth instanceof Response) return auth;
  const gateway = auth.principal;
  const usageCtx = { endpoint: url.pathname, apiKey: auth.legacy ? extractApiKey(request) : null };
  const settings = await getEffectivePreferences(gateway);

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  if (body.voice != null && (typeof body.voice !== "string" || !body.voice.trim()))
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "voice must be a non-empty string");
  if (body.response_format != null && !AUDIO_FORMATS.has(body.response_format))
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `response_format must be one of: ${[...AUDIO_FORMATS].join(", ")}`,
    );

  // Authorize combo ID before reading its expansion; leaves are checked below.
  if (gateway && typeof modelStr === "string" && !modelStr.includes("/")) {
    const combo = await getComboByName(modelStr, { principal: gateway });
    if (combo) {
      const denied = authorizeGatewayTarget(gateway, { comboId: combo.id });
      if (denied) return denied;
    }
  }
  const comboModels = await getComboModels(modelStr, { principal: gateway });
  // YAN-364: strategy entries are id-keyed for a principal (workspace row),
  // name-keyed on the legacy no-principal path.
  const combo = gateway
    ? comboModels
      ? await getComboByName(modelStr, { principal: gateway })
      : null
    : { id: modelStr, name: modelStr };
  if (comboModels) {
    const {
      strategy: comboStrategy,
      stickyLimit: comboStickyLimit,
      weights: comboWeights,
    } = comboStrategyFor(settings, gateway, combo);
    const headroomFn = comboStrategy === "weighted" ? await loadComboHeadroomFn() : undefined;
    log.info(
      "TTS",
      `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
    );
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) =>
        handleSingleModelTts(b, m, responseFormat, language, style, gateway, usageCtx),
      log,
      comboName: comboRotationKey(gateway?.workspaceId, modelStr),
      comboStrategy,
      comboStickyLimit,
      comboWeights,
      headroomFn,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style, gateway, usageCtx);
}

async function handleSingleModelTts(
  body,
  modelStr,
  responseFormat,
  language,
  style,
  gateway,
  usageCtx,
) {
  const gatewayCreds = gateway ? { principal: gateway } : {};
  const modelInfo = await getModelInfo(modelStr, gatewayCreds);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  const denied = authorizeGatewayTarget(gateway, { modelId: `${provider}/${model}` });
  if (denied) return denied;

  // YAN-372: budgets on the principal's path (input chars priced as tokens).
  const held = await budgeted(
    gateway,
    { provider, model, body: { input: body.input }, noOutput: true },
    () => handleSingleModelTts(body, modelStr, responseFormat, language, style, gateway, usageCtx),
  );
  if (held) return held;

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({
      provider,
      model,
      input: body.input,
      responseFormat,
      language,
      style,
      voice: body.voice,
      format: body.response_format,
    });
    if (result.success) {
      saveRequestUsageUnscoped({
        provider,
        model,
        endpoint: usageCtx.endpoint,
        connectionId: null,
        apiKey: usageCtx.apiKey,
        ...gatewayKeyContext(gateway),
        units: { characters: typeof body.input === "string" ? body.input.length : 0 },
        status: "success",
      }).catch(() => {});
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(
      provider,
      excludeConnectionIds,
      model,
      gatewayCreds,
    );

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
      if (credentials?.budgetLimit) return budgetResponse(credentials.budgetLimit);
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status =
          lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(
          status,
          `[${provider}/${model}] ${msg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman,
        );
      }
      if (excludeConnectionIds.size === 0)
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        lastError || "All accounts unavailable",
      );
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleTtsCore({
      provider,
      model,
      input: body.input,
      credentials,
      responseFormat,
      language,
      style,
      voice: body.voice,
      format: body.response_format,
    });

    if (result.success) {
      saveRequestUsageUnscoped({
        provider,
        model,
        endpoint: usageCtx.endpoint,
        connectionId: credentials.connectionId,
        apiKey: usageCtx.apiKey,
        ...gatewayKeyContext(gateway),
        grantId: credentials.grantId ?? undefined,
        units: { characters: typeof body.input === "string" ? body.input.length : 0 },
        status: "success",
      }).catch(() => {});
      return result.response;
    }

    releaseGrantReservation(credentials.grantReservation);

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      null,
      { grantId: credentials.grantId },
    );
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
