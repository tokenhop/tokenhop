import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import {
  authorizeGatewayTarget,
  gatewayKeyContext,
  resolveGatewayAuth,
} from "@/lib/auth/gatewayAuth.js";
import { saveRequestUsageUnscoped } from "@/lib/usageDb.js";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { getModelInfo, getComboModels, getComboByName } from "../services/model.js";
import { comboRotationKey, comboStrategyFor } from "@/lib/comboKeys.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { loadComboHeadroomFn } from "../services/comboHeadroom.js";
import * as log from "../utils/logger.js";
import { grantRateLimitResponse, releaseGrantReservation } from "../services/grantRateLimiter.js";
import { budgetResponse, budgeted } from "../services/budgetGuard.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  // Authenticate before reading caller-scoped preferences: the gateway
  // principal selects the effective combo-strategy view.
  const auth = await resolveGatewayAuth(request);
  if (auth instanceof Response) return auth;
  const gateway = auth.principal;
  const usageCtx = { endpoint: url.pathname, apiKey: auth.legacy ? extractApiKey(request) : null };
  const settings = await getEffectivePreferences(gateway);

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Authorize combo ID before reading its expansion; leaves are checked below.
  if (gateway && typeof modelStr === "string" && !modelStr.includes("/")) {
    const combo = await getComboByName(modelStr, { principal: gateway });
    if (combo) {
      const denied = authorizeGatewayTarget(gateway, { comboId: combo.id });
      if (denied) return denied;
    }
  }
  const comboModels = await getComboModels(modelStr, { principal: gateway });
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
      "IMAGE",
      `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
    );
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) =>
        handleSingleModelImage(b, m, {
          wantsStream,
          binaryOutput,
          preferredConnectionId,
          gateway,
          usageCtx,
        }),
      log,
      comboName: comboRotationKey(gateway?.workspaceId, modelStr),
      comboStrategy,
      comboStickyLimit,
      comboWeights,
      headroomFn,
    });
  }

  return handleSingleModelImage(body, modelStr, {
    wantsStream,
    binaryOutput,
    preferredConnectionId,
    gateway,
    usageCtx,
  });
}

async function handleSingleModelImage(
  body,
  modelStr,
  { wantsStream, binaryOutput, preferredConnectionId, gateway, usageCtx } = {},
) {
  const gatewayCreds = gateway ? { principal: gateway } : {};
  const modelInfo = await getModelInfo(modelStr, gatewayCreds);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  const denied = authorizeGatewayTarget(gateway, { modelId: `${provider}/${model}` });
  if (denied) return denied;

  // YAN-372: budgets on the principal's path (non-token: 1 request + fallback USD).
  const held = await budgeted(gateway, { provider, model, nonToken: true }, () =>
    handleSingleModelImage(body, modelStr, {
      wantsStream,
      binaryOutput,
      preferredConnectionId,
      gateway,
      usageCtx,
    }),
  );
  if (held) return held;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) {
      // ponytail: requested count, not response count; upgrade when imageGenerationCore exposes usage.
      saveRequestUsageUnscoped({
        provider,
        model,
        endpoint: usageCtx.endpoint,
        connectionId: null,
        apiKey: usageCtx.apiKey,
        ...gatewayKeyContext(gateway),
        units: { images: body.n ?? 1 },
        status: "success",
      }).catch(() => {});
      return result.response;
    }
    return errorResponse(
      result.status || HTTP_STATUS.BAD_GATEWAY,
      result.error || "Image generation failed",
    );
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      ...gatewayCreds,
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
      if (credentials?.budgetLimit) return budgetResponse(credentials.budgetLimit);
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status =
          lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(
          status,
          `[${provider}/${model}] ${errorMsg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman,
        );
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        lastError || "All accounts unavailable",
      );
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) {
      // ponytail: requested count, not response count; upgrade when imageGenerationCore exposes usage.
      saveRequestUsageUnscoped({
        provider,
        model,
        endpoint: usageCtx.endpoint,
        connectionId: credentials.connectionId,
        apiKey: usageCtx.apiKey,
        ...gatewayKeyContext(gateway),
        grantId: credentials.grantId ?? undefined,
        units: { images: body.n ?? 1 },
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

    return result.response;
  }
}
