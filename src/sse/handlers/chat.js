import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import {
  handleAntigravityQuotaError,
  clearAntigravityStrikes,
} from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelInfo, getComboModels, getComboByName } from "../services/model.js";
import { comboRotationKey, comboStrategyFor } from "@/lib/comboKeys.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import {
  handleComboChat,
  handleFusionChat,
  detectRequiredCapabilities,
} from "open-sse/services/combo.js";
import { loadComboHeadroomFn } from "../services/comboHeadroom.js";
import {
  augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping,
  getActiveAdapterStrategy,
} from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { recordFallbackHop } from "@/lib/usageDb.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { FORMATS, detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import {
  estimateBodyTokens,
  grantRateLimitResponse,
  releaseGrantReservation,
} from "../services/grantRateLimiter.js";
import { budgetResponse, budgeted } from "../services/budgetGuard.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { notifyRequestLogsEnabled } from "open-sse/utils/requestLogger.js";
import { ensureReliabilityPolicy } from "@/lib/reliability/initReliabilityPolicy.js";
import {
  authorizeGatewayTarget,
  resolveGatewayAuth,
  sanitizeGatewayCapture,
  gatewayKeyContext,
} from "@/lib/auth/gatewayAuth.js";
import { getGatewayDisabled, requireGatewayWorkspace } from "@/lib/auth/gatewayResources.js";
import { getDisabledModelsUnscoped } from "@/lib/db/index.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 * @param {object} request - Request object
 * @param {object|null} clientRawRequest - Raw client request for logging
 * @param {object} [options] - Extra options. `options.onAttempt` is a fail-open
 *   attempt observer passed through to the combo fallback loop (probe path only).
 *   Hashed probes require options.principal from an authorized in-process
 *   caller. skipApiKeyCheck alone never bypasses hashed authentication.
 */
export async function handleChat(request, clientRawRequest = null, options = null) {
  // YAN-311 cold-boot guard: API-only /v1 traffic never renders layout.js, so
  // stored overrides must load before the first request. Fail-open (defaults).
  await ensureReliabilityPolicy(getSettings);
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Request body must be a JSON object");
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "model must be a string");
  }
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages must be an array");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries()),
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // Stripping is all that's needed: current Claude models serve 1M natively, and
  // the client's context-1m beta is filtered out when its anthropic-beta is merged
  // (mergeClientAnthropicBeta).
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  let auth;
  const storageUnavailable = () =>
    errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Gateway storage unavailable");
  if (options?.principal) {
    try {
      await requireGatewayWorkspace(options.principal);
    } catch {
      return storageUnavailable();
    }
    auth = { principal: options.principal, legacy: false };
  } else if (options?.skipApiKeyCheck === true) {
    // Bare skipApiKeyCheck is the probe/legacy shape. It becomes authority only
    // at the requireGatewayWorkspace gate below (throws for hashed storage,
    // fail-closed — no principal, no traffic), never at this branch.
    auth = null;
  } else {
    auth = await resolveGatewayAuth(request);
    if (auth instanceof Response) return auth;
  }
  if (auth === null) {
    try {
      await requireGatewayWorkspace(null);
    } catch {
      return storageUnavailable();
    }
    auth = { principal: null, legacy: true };
  }
  const gateway = auth.principal;
  options = { ...options, principal: gateway };
  const apiKey = auth.legacy ? extractApiKey(request) : null;
  if (!auth.legacy) {
    // Sanitized capture for hashed requests: no secret header (incl. the
    // dashboard cookie) survives, and no `?key=` in a captured url.
    const capture = sanitizeGatewayCapture({
      headers: new Headers(clientRawRequest.headers),
      url: clientRawRequest.endpoint || request?.url || null,
    });
    clientRawRequest = {
      ...clientRawRequest,
      headers: Object.fromEntries(capture.headers),
      ...(capture.url ? { endpoint: capture.url } : {}),
      ...(clientRawRequest.url
        ? { url: sanitizeGatewayCapture({ url: clientRawRequest.url }).url }
        : {}),
    };
  }
  const settings = await getEffectivePreferences(gateway);
  notifyRequestLogsEnabled(settings.requestLogsEnabled === true);

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // llama.vim / llama.vscode warm the server cache with n_predict:0 on every
  // cursor move. There is no cache to warm here: answer empty once auth and the
  // key's model/combo scope pass, without an upstream call. Skipping rate
  // limits and usage rows is deliberate (no tokens are spent).
  if (
    body.n_predict === 0 &&
    request?.url &&
    detectFormatByEndpoint(new URL(request.url).pathname, body) === FORMATS.LLAMACPP_INFILL
  ) {
    if (gateway) {
      const combo = await getComboByName(modelStr, { principal: gateway });
      const info = combo ? null : await getModelInfo(modelStr, { principal: gateway });
      const denied = combo
        ? authorizeGatewayTarget(gateway, { comboId: combo.id })
        : info?.provider
          ? authorizeGatewayTarget(gateway, { modelId: `${info.provider}/${info.model}` })
          : null;
      if (denied) return denied;
    }
    const warm = { content: "", stop: true, tokens_predicted: 0, truncated: false };
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (body.stream === true) {
      return new Response(`data: ${JSON.stringify(warm)}\n\ndata: [DONE]\n\n`, {
        headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
    return Response.json(warm, { headers: cors });
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  // (keyed clients included: bypass is a local cost saver, not auth; the gate above already ran).
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse && !gateway) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr, { principal: gateway });
  const outerCombo = comboModels ? await getComboByName(modelStr, { principal: gateway }) : null;
  if (comboModels && gateway) {
    const denied = authorizeGatewayTarget(gateway, { comboId: outerCombo?.id });
    if (denied) return denied;
  }
  if (comboModels) {
    const {
      strategy: comboStrategy,
      stickyLimit: comboStickyLimit,
      weights: comboWeights,
      judgeModel,
      fusionTuning,
    } = comboStrategyFor(settings, gateway, outerCombo);
    let augmentedModels = augmentModelsWithCapacityAdapter(
      comboModels,
      requiredCapabilities,
      settings,
    );
    if (gateway) {
      augmentedModels = await allowedGatewayModels(gateway, augmentedModels, body, settings, [
        modelStr,
      ]);
      if (!augmentedModels.length) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
    }
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    // Probe runs (dry-run tests) reuse this exact path. options.onAttempt is a
    // fail-open attempt observer: it only records, never alters routing. Step
    // rows come from the combo loop itself (proves the real fallback ran).
    // options is threaded into handleSingleModelChat so nested combos report
    // their own steps (tagged nested/via) and also skip the fallback ring.
    const comboObserver = probeObserverFor(options);

    if (comboStrategy === "fusion") {
      let fusionModels = comboModels;
      if (gateway) {
        const filtered = await fusionPanelForGateway(
          gateway,
          comboModels,
          judgeModel,
          body,
          settings,
          [modelStr],
        );
        if (filtered instanceof Response) return filtered;
        fusionModels = filtered.models;
      }
      log.info("CHAT", `Combo "${modelStr}" with ${fusionModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: fusionModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(
            b,
            m,
            cleanRawReq,
            request,
            apiKey,
            [modelStr],
            modelStr,
            options,
          );
        },
        log,
        comboName: comboRotationKey(gateway?.workspaceId, modelStr),
        judgeModel,
        tuning: fusionTuning,
        onAttempt: options?.onAttempt,
      });
    }

    const headroomFn = comboStrategy === "weighted" ? await loadComboHeadroomFn() : undefined;
    log.info(
      "CHAT",
      `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
    );
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) =>
          handleSingleModelChat(
            b,
            m,
            clientRawRequest,
            request,
            apiKey,
            [modelStr],
            modelStr,
            options,
          ),
        adapterAdded,
      ),
      log,
      comboName: comboRotationKey(gateway?.workspaceId, modelStr),
      comboStrategy,
      comboStickyLimit,
      comboWeights,
      headroomFn,
      onAttempt: comboObserver,
      // Probes must not pollute the live-routes fallback ring: pass the
      // recorder only for real traffic (no probe observer attached).
      ...(comboObserver ? {} : { onFallback: fallbackRecorder(modelStr, gateway?.workspaceId) }),
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  // Probes take the same adapter loop with the observer attached and the
  // fallback recorder omitted, so they never write the live-routes ring.
  let soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    // The adapter loop can serve a model other than the requested one, so the
    // REQUESTED target must be authorized before any upstream work: a 403 on
    // the request's own model is terminal, never a fallback reason to serve an
    // adapter member instead (authorizeGatewayTarget denied = 403 Response).
    if (gateway) {
      const requested = await getModelInfo(modelStr, { principal: gateway });
      if (requested.provider) {
        const denied = authorizeGatewayTarget(gateway, {
          modelId: `${requested.provider}/${requested.model}`,
        });
        if (denied) return denied;
      }
    }
    if (gateway) {
      soloAugmented = await allowedGatewayModels(gateway, soloAugmented, body, settings);
      if (!soloAugmented.length) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
    }
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    const adapterObserver = probeObserverFor(options);
    log.info(
      "CHAT",
      `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`,
    );
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, [], null, options),
        adapterAdded,
      ),
      log,
      comboName: comboRotationKey(gateway?.workspaceId, modelStr),
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      onAttempt: adapterObserver,
      ...(adapterObserver ? {} : { onFallback: fallbackRecorder(modelStr, gateway?.workspaceId) }),
    });
  }

  return handleSingleModelChat(
    body,
    modelStr,
    clientRawRequest,
    request,
    apiKey,
    [],
    null,
    options,
  );
}

/**
 * Build a combo onFallback hook that records the failed step for live routes.
 * @param {string} comboName
 * @param {string|null} [workspaceId] gateway principal's workspace (YAN-370 scoped feed)
 * @returns {(hop: { model: string, status: number }) => Promise<void>}
 */
function fallbackRecorder(comboName, workspaceId = null) {
  // Synchronous provider split keeps this off the failover hot path; a full
  // model-info lookup would add DB reads between the failure and the retry.
  return async ({ model: modelStr, status }) => {
    const slash = modelStr.indexOf("/");
    recordFallbackHop({
      comboName,
      provider: slash > 0 ? modelStr.slice(0, slash) : modelStr,
      model: slash > 0 ? modelStr.slice(slash + 1) : modelStr,
      status,
      workspaceId,
    });
  };
}

// Filter authorization denials BEFORE engine fallback classification. Engine 403s
// are upstream credential errors; gateway denials must never enter that path.
async function allowedGatewayModels(gateway, models, body, settings, path = []) {
  const allowed = [];
  for (const model of models) {
    if (await gatewayAllowsTarget(gateway, model, body, settings, path)) allowed.push(model);
  }
  return allowed;
}

async function gatewayAllowsTarget(gateway, candidate, body, settings, path = []) {
  const models = await getComboModels(candidate, { principal: gateway });
  if (models) {
    if (path.includes(candidate)) return false;
    const combo = await getComboByName(candidate, { principal: gateway });
    if (!combo?.id || authorizeGatewayTarget(gateway, { comboId: combo.id })) return false;
    const nextPath = [...path, candidate];
    const { strategy, judgeModel } = comboStrategyFor(settings, gateway, combo);
    const pool =
      strategy === "fusion"
        ? models
        : augmentModelsWithCapacityAdapter(models, detectRequiredCapabilities(body), settings);
    const allowed = await allowedGatewayModels(gateway, pool, body, settings, nextPath);
    if (!allowed.length) return false;
    // Preserve the configured/default judge, not a scope-dependent replacement.
    if (strategy === "fusion" && models.length > 1) {
      const judge = judgeModel?.trim() || models[0];
      return gatewayAllowsTarget(gateway, judge, body, settings, nextPath);
    }
    return true;
  }
  const info = await getModelInfo(candidate, { principal: gateway });
  return (
    !!info.provider &&
    !authorizeGatewayTarget(gateway, { modelId: `${info.provider}/${info.model}` })
  );
}

async function fusionPanelForGateway(gateway, models, judgeModel, body, settings, path) {
  const panel = await allowedGatewayModels(gateway, models, body, settings, path);
  if (!panel.length) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
  if (models.length > 1) {
    const judge = judgeModel?.trim() || models[0];
    if (!(await gatewayAllowsTarget(gateway, judge, body, settings, path))) {
      return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
    }
  }
  return { models: panel };
}

/**
 * Wrap the probe's attempt observer (options.onAttempt) fail-open. Returns
 * undefined for normal traffic so combo loops get no observer and keep the
 * live-routes fallback recorder. `via` tags steps of a nested combo so the
 * probe timeline shows them distinctly from the outer route's own steps.
 * @param {object|null} options - handleChat options
 * @param {string} [via] - Nested combo name (omit for the outermost route)
 * @returns {((attempt: object) => void)|undefined}
 */
function probeObserverFor(options, via) {
  const observer = typeof options?.onAttempt === "function" ? options.onAttempt : null;
  if (!observer) return undefined;
  return (attempt) => {
    try {
      observer({
        role: via ? "nested" : "route",
        account: null,
        ...(via ? { via } : {}),
        ...attempt,
      });
    } catch {
      // observer must never break routing
    }
  };
}

/**
 * Handle single model chat request
 * @param {object} body - Request body
 * @param {string} modelStr - Model string
 * @param {object} clientRawRequest - Raw client request for logging
 * @param {object} request - Request object
 * @param {string} apiKey - API key
 * @param {string[]} comboPath - Combo names already on the resolution stack (cycle guard)
 * @param {string|null} comboName - Innermost combo that resolved to this model (usage attribution)
 * @param {object|null} options - handleChat options (probe observer); threaded so
 *   nested combos observe their own steps and skip the live-routes fallback ring.
 */
// Same keys /v1/models checks: the provider's alias and its static alias.
// YAN-364: with a principal only that workspace's disabled map is read (never
// the global one); a read error is still fail-open, exactly as before.
async function isModelDisabled(provider, model, principal = null) {
  let disabled;
  try {
    disabled = principal ? await getGatewayDisabled(principal) : await getDisabledModelsUnscoped();
  } catch {
    return false; // fail open: a DB read error must not block traffic
  }
  const aliases = new Set([getProviderAlias(provider), PROVIDER_ID_TO_ALIAS[provider], provider]);
  for (const alias of aliases) {
    if (alias && Array.isArray(disabled?.[alias]) && disabled[alias].includes(model)) return true;
  }
  return false;
}

async function handleSingleModelChat(
  body,
  modelStr,
  clientRawRequest = null,
  request = null,
  apiKey = null,
  comboPath = [],
  comboName = null,
  options = null,
) {
  const gateway = options?.principal || null;
  const gatewayCreds = { principal: gateway };
  const modelInfo = await getModelInfo(modelStr, gateway ? { principal: gateway } : {});

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr, { principal: gateway });
    if (comboModels) {
      const nestedCombo = await getComboByName(modelStr, { principal: gateway });
      const denied = authorizeGatewayTarget(gateway, { comboId: nestedCombo?.id });
      if (denied) return denied;
      if (comboPath.includes(modelStr)) {
        const cycleMsg = `Combo cycle detected: ${[...comboPath, modelStr].join(" → ")}`;
        log.warn("CHAT", cycleMsg);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, cycleMsg);
      }
      const nextPath = [...comboPath, modelStr];
      const chatSettings = await getEffectivePreferences(gateway);
      const {
        strategy: comboStrategy,
        stickyLimit: comboStickyLimit,
        weights: comboWeights,
        judgeModel,
        fusionTuning,
      } = comboStrategyFor(chatSettings, gateway, nestedCombo);
      const requiredCapabilities = detectRequiredCapabilities(body);
      let augmentedModels = augmentModelsWithCapacityAdapter(
        comboModels,
        requiredCapabilities,
        chatSettings,
      );
      if (gateway) {
        augmentedModels = await allowedGatewayModels(
          gateway,
          augmentedModels,
          body,
          chatSettings,
          nextPath,
        );
        if (!augmentedModels.length) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
      }
      const filteredAdapter = gateway
        ? await allowedGatewayModels(gateway, augmentedModels, body, chatSettings, nextPath)
        : augmentedModels;
      if (!filteredAdapter.length) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
      const adapterAdded = filteredAdapter.filter((m) => !comboModels.includes(m));
      const nestedObserver = probeObserverFor(options, modelStr);

      if (comboStrategy === "fusion") {
        let fusionModels = comboModels;
        if (gateway) {
          const filtered = await fusionPanelForGateway(
            gateway,
            comboModels,
            judgeModel,
            body,
            chatSettings,
            nextPath,
          );
          if (filtered instanceof Response) return filtered;
          fusionModels = filtered.models;
        }
        log.info(
          "CHAT",
          `Combo "${modelStr}" with ${fusionModels.length} models (strategy: fusion)`,
        );
        return handleFusionChat({
          body,
          models: fusionModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(
              b,
              m,
              cleanRawReq,
              request,
              apiKey,
              nextPath,
              modelStr,
              options,
            );
          },
          log,
          comboName: comboRotationKey(gateway?.workspaceId, modelStr),
          judgeModel,
          tuning: fusionTuning,
          onAttempt: nestedObserver,
        });
      }

      const headroomFn = comboStrategy === "weighted" ? await loadComboHeadroomFn() : undefined;
      log.info(
        "CHAT",
        `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
      );
      return handleComboChat({
        body,
        models: filteredAdapter,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) =>
            handleSingleModelChat(
              b,
              m,
              clientRawRequest,
              request,
              apiKey,
              nextPath,
              modelStr,
              options,
            ),
          adapterAdded,
        ),
        log,
        comboName: comboRotationKey(gateway?.workspaceId, modelStr),
        comboStrategy,
        comboStickyLimit,
        comboWeights,
        headroomFn,
        onAttempt: nestedObserver,
        // Real nested traffic records hops (YAN-293); probes never write the ring.
        ...(nestedObserver ? {} : { onFallback: fallbackRecorder(modelStr, gateway?.workspaceId) }),
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  const denied = authorizeGatewayTarget(gateway, { modelId: `${provider}/${model}` });
  if (denied) return denied;

  // A model disabled on the provider page is hidden from /v1/models; refuse
  // to route it too, under either alias the dashboard may have stored (YAN-661).
  // 404 lets a combo advance to its next member.
  if (await isModelDisabled(provider, model, gateway)) {
    log.warn("CHAT", `Model disabled: ${provider}/${model}`);
    // The combo loop must treat this as model-scoped (advance past it), not as an
    // account failure that flips connection state (YAN-661 review follow-up).
    const res = errorResponse(HTTP_STATUS.NOT_FOUND, `Model disabled: ${modelStr}`);
    res.localError = true;
    return res;
  }

  // YAN-372: key/user/membership/workspace budgets, reserved per leaf attempt.
  const held = await budgeted(gateway, { provider, model, body }, () =>
    handleSingleModelChat(
      body,
      modelStr,
      clientRawRequest,
      request,
      apiKey,
      comboPath,
      comboName,
      options,
    ),
  );
  if (held) return held;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      ...gatewayCreds,
      estimateTokens: () => estimateBodyTokens(body),
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
      if (credentials?.budgetLimit) return budgetResponse(credentials.budgetLimit);
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(
          status,
          `[${provider}/${model}] ${errorMsg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman,
        );
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(
          HTTP_STATUS.NOT_FOUND,
          `No active credentials for provider: ${provider}`,
        );
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        lastError || "All accounts unavailable",
      );
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if (
      (provider === "antigravity" || provider === "gemini-cli") &&
      !refreshedCredentials.projectId
    ) {
      const pid = await getProjectIdForConnection(
        credentials.connectionId,
        refreshedCredentials.accessToken,
        provider,
      );
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => {});
      }
    }

    // Use shared chatCore
    const chatSettings = await getEffectivePreferences(gateway);
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ...gatewayKeyContext(gateway),
      grantId: credentials.grantId ?? null,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      comboName,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url
        ? detectFormatByEndpoint(new URL(request.url).pathname, body)
        : null,
      onCredentialsRefreshed: async (newCreds) => {
        // YAN-365: delta refresh — the repo merges onto the live stored
        // siblings inside the transaction (never a stale snapshot).
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          testStatus: "active",
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      },
    });

    if (result.success) return result.response;
    // Failed attempts don't count against the grant's rpm/tpm.
    releaseGrantReservation(credentials.grantReservation);
    // Local request-prep failure says nothing about the account: no cooldown, no rotation.
    if (result.localError) return result.response;

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId,
        result.status,
        model,
        refreshedCredentials.accessToken,
        credentials.providerSpecificData,
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback =
      provider === "antigravity" && quotaResetMs
        ? true
        : (
            await markAccountUnavailable(
              credentials.connectionId,
              result.status,
              result.error,
              provider,
              model,
              resetsAtMs,
              { grantId: credentials.grantId },
            )
          ).shouldFallback;

    if (shouldFallback) {
      log.warn(
        "FALLBACK",
        `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`,
      );
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
