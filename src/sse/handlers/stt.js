import { getProviderCredentials, markAccountUnavailable, extractApiKey } from "../services/auth.js";
import {
  authorizeGatewayTarget,
  gatewayKeyContext,
  resolveGatewayAuth,
} from "@/lib/auth/gatewayAuth.js";
import { saveRequestUsageUnscoped } from "@/lib/usageDb.js";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { grantRateLimitResponse, releaseGrantReservation } from "../services/grantRateLimiter.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(
      ([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none",
    )
    .map(([id]) => id),
);

// OpenAI verbose_json carries `duration` (seconds); else fall back to upload bytes.
async function sttUnits(response, file) {
  try {
    const d = (await response.clone().json())?.duration;
    if (Number.isFinite(d) && d > 0) return { seconds: d };
  } catch {}
  return { bytes: file?.size ?? 0 };
}

function recordStt(response, file, entry) {
  sttUnits(response, file)
    .then((units) => saveRequestUsageUnscoped({ ...entry, units, status: "success" }))
    .catch(() => {});
}

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const auth = await resolveGatewayAuth(request);
  if (auth instanceof Response) return auth;
  const gateway = auth.principal;
  const gatewayCreds = gateway ? { principal: gateway } : {};
  const apiKey = auth.legacy ? extractApiKey(request) : null;
  const endpoint = new URL(request.url).pathname;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file"))
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr, gatewayCreds);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  const denied = authorizeGatewayTarget(gateway, { modelId: `${provider}/${model}` });
  if (denied) return denied;

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({
      provider,
      model,
      formData,
      sttConfig: AI_PROVIDERS[provider]?.sttConfig,
    });
    if (result.success) {
      recordStt(result.response, formData.get("file"), {
        provider,
        model,
        endpoint,
        connectionId: null,
        apiKey,
        ...gatewayKeyContext(gateway),
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
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

    const result = await handleSttCore({
      provider,
      model,
      formData,
      credentials,
      sttConfig: AI_PROVIDERS[provider]?.sttConfig,
    });

    if (result.success) {
      recordStt(result.response, formData.get("file"), {
        provider,
        model,
        endpoint,
        connectionId: credentials.connectionId,
        apiKey,
        ...gatewayKeyContext(gateway),
      });
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
