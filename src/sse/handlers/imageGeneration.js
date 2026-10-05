import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../services/auth.js";
import { authorizeGatewayTarget, resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { resolveComboStrategy } from "open-sse/services/comboStrategy.js";
import { loadComboHeadroomFn } from "../services/comboHeadroom.js";
import * as log from "../utils/logger.js";

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
  const settings = await getEffectivePreferences(gateway);

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Authorize combo ID before reading its expansion; leaves are checked below.
  if (gateway && typeof modelStr === "string" && !modelStr.includes("/")) {
    const combo = await getComboByName(modelStr);
    if (combo) {
      const denied = authorizeGatewayTarget(gateway, { comboId: combo.id });
      if (denied) return denied;
    }
  }
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const {
      strategy: comboStrategy,
      stickyLimit: comboStickyLimit,
      weights: comboWeights,
    } = resolveComboStrategy(settings, modelStr);
    const headroomFn = comboStrategy === "weighted" ? await loadComboHeadroomFn() : undefined;
    log.info(
      "IMAGE",
      `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
    );
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) =>
        handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, gateway }),
      log,
      comboName: modelStr,
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
  });
}

async function handleSingleModelImage(
  body,
  modelStr,
  { wantsStream, binaryOutput, preferredConnectionId, gateway } = {},
) {
  const gatewayCreds = gateway ? { principal: gateway } : {};
  const modelInfo = await getModelInfo(modelStr, gatewayCreds);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  const denied = authorizeGatewayTarget(gateway, { modelId: `${provider}/${model}` });
  if (denied) return denied;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) return result.response;
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

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
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
