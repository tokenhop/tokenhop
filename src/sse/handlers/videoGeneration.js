import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getProviderConnectionByIdUnscoped } from "@/lib/localDb";
import {
  authorizeGatewayTarget,
  gatewayKeyContext,
  resolveGatewayAuth,
} from "@/lib/auth/gatewayAuth.js";
import { saveRequestUsageUnscoped } from "@/lib/usageDb.js";
import { getGatewayConnections } from "@/lib/auth/gatewayResources.js";
import { getAdapter } from "@/lib/db/driver.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import {
  getGatewayVideoJobsSync,
  recordGatewayVideoJobSync,
  requireGatewayVideoJobsSync,
} from "@/lib/db/repos/gatewayVideoJobsRepo.js";
import { header, legacyHeaderNames } from "@/shared/brand";
import { getModelInfo } from "../services/model.js";
import {
  handleVideoProxyCore,
  getVideoConfig,
  sanitizeSecrets,
} from "open-sse/handlers/videoCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import * as log from "../utils/logger.js";
import { grantRateLimitResponse, releaseGrantReservation } from "../services/grantRateLimiter.js";

// Video generation is xAI-only today; requests without a provider prefix
// (bare model id, or multipart bodies we deliberately don't parse) land here.
const DEFAULT_VIDEO_PROVIDER = "xai";

/**
 * Poll requests carry no model, so the provider comes from the pinned
 * connection (`x-connection-id`, returned on create) or an explicit
 * `?provider=` — falling back to the historical xAI default.
 */
async function resolveGetProvider(request, connectionId) {
  if (connectionId) {
    const conn = await getProviderConnectionByIdUnscoped(connectionId).catch(() => null);
    if (conn?.provider && getVideoConfig(conn.provider)) return conn.provider;
  }
  const queried = new URL(request.url).searchParams.get("provider");
  if (queried && getVideoConfig(queried)) return queried;
  return DEFAULT_VIDEO_PROVIDER;
}

// Creation POSTs are billable jobs — only rotate to another account for
// errors that upstream rejects BEFORE creating a job (auth/quota). A 5xx may
// have created the job, so it is returned to the caller instead of re-sent.
// Poll failures that say something about the account (5xx handled separately).
const POLL_LOCK_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);
// Lock key for poll failures: scoped to video polling, never the account-wide `__all`.
const VIDEO_POLL_LOCK_MODEL = "__video_poll";

const CREATE_ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);

async function requireValidApiKey(request) {
  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
  return null;
}

/**
 * YAN-363 shared gateway auth, video entry. Hashed storage delegates entirely
 * to the shared resolver (workspace principal, no fallback). Legacy storage
 * keeps this handler's exact historical raw-key check via its own helpers:
 * routing legacy through the shared resolver would silently change which
 * settings surface the legacy branch reads — pristine legacy behavior wins.
 * @returns {Promise<{principal: object|null, legacy: boolean, error?: Response}|Response>}
 */
async function resolveVideoAuth(request) {
  let state;
  try {
    state = readApiKeyStorageState(await getAdapter());
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") throw err;
    return { error: errorResponse(503, "Gateway storage unavailable") };
  }
  if (state.storage === "hashed") {
    const auth = await resolveGatewayAuth(request);
    if (auth instanceof Response) return { error: auth };
    return auth;
  }
  const legacyError = await requireValidApiKey(request);
  if (legacyError) return { error: legacyError };
  return { principal: null, legacy: true };
}

/**
 * Read the request body once, byte-preserving.
 * JSON bodies are additionally parsed so the `model` provider prefix can be
 * resolved (and stripped) — everything else is forwarded exactly as received.
 */
async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  // Multipart (or any other content type): forward the exact bytes — parsing
  // and re-encoding FormData would change the multipart boundary.
  const buf = Buffer.from(await request.arrayBuffer());
  return { raw: buf, parsed: null, contentType };
}

/**
 * Multipart scope sniff (gateway principals only): parse a COPY of the raw
 * bytes to read the `model` field. The original buffer stays the forwarded
 * body — nothing is re-encoded, so the boundary is preserved byte-for-byte.
 * Unparseable multipart or absent model returns null. Duplicate `model`
 * parts are explicitly rejected, even for unrestricted keys: upstream parsers
 * may be last-wins, so the sniffed value must be unambiguous.
 */
async function sniffMultipartModel(raw, contentType) {
  if (!contentType?.includes("multipart/")) return { model: null };
  try {
    const formData = await new Response(raw, {
      headers: { "content-type": contentType },
    }).formData();
    const models = formData.getAll("model");
    if (models.length > 1) {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Duplicate multipart model fields") };
    }
    const model = models[0];
    return { model: typeof model === "string" && model.length > 0 ? model : null };
  } catch {
    return { model: null };
  }
}

async function resolveVideoProvider(modelStr, gateway = null) {
  if (!modelStr) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };

  const modelInfo = await getModelInfo(String(modelStr), gateway ? { principal: gateway } : {});
  if (!modelInfo.provider) {
    return {
      error: errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Combos are not supported for video generation",
      ),
    };
  }
  if (!getVideoConfig(modelInfo.provider)) {
    // Bare model ids (no explicit "provider/" prefix) fall back to the default
    // video provider — the prefix-less inference targets chat providers only.
    if (!String(modelStr).includes("/")) {
      return { provider: DEFAULT_VIDEO_PROVIDER, model: String(modelStr) };
    }
    return {
      error: errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Provider '${modelInfo.provider}' does not support video generation`,
      ),
    };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  // Video jobs are account-bound upstream — clients echo this back as
  // `x-connection-id` on GET polls so the same account is used.
  // Emitted under every name: older clients read the legacy one. legacy(9router): remove in v2
  for (const name of [header("connection-id"), ...legacyHeaderNames("connection-id")]) {
    headers.set(name, String(connectionId));
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Record job provenance (gateway principals) from the ACCEPTED upstream
 * response only: the job id is what upstream handed back, never a caller
 * assertion. Reads a clone — the original response body still streams to the
 * client untouched. Recording failures never fail an accepted job (poll auth
 * does not depend on the row existing); provenance conflicts are logged.
 */
async function recordVideoJobProvenance(gateway, response, { provider, connectionId, modelId }) {
  let jobId = null;
  try {
    const body = await response.clone().json();
    const candidate = body?.request_id ?? body?.id;
    if (typeof candidate === "string" && candidate.length > 0) jobId = candidate;
  } catch {
    jobId = null; // non-JSON success body: no provenance to record
  }
  if (!jobId) return;
  try {
    const db = await getAdapter();
    recordGatewayVideoJobSync(db, {
      workspaceId: gateway.workspaceId,
      jobId,
      provider,
      connectionId,
      modelId,
    });
    log.debug("VIDEO", `job ${jobId} provenance recorded (${provider}, ${modelId})`);
  } catch (err) {
    log.error(
      "VIDEO",
      `job provenance not recorded for workspace ${gateway.workspaceId}: ${err?.message || err}`,
    );
  }
}

/** Fail closed BEFORE a billable submission when activation omitted the job store. */
async function ensureGatewayVideoJobStore() {
  const db = await getAdapter();
  requireGatewayVideoJobsSync(db);
}

/** Canonical `provider/model` → bare model for credential lock keys; null when malformed. */
function bareModelOf(job) {
  const prefix = `${job.provider}/`;
  return job.modelId.startsWith(prefix) ? job.modelId.slice(prefix.length) : null;
}

/**
 * Unmapped (pre-provenance) poll, gateway principal: the connection header is
 * honored only when it names a connection owned by the key's workspace. A
 * foreign pin resolves to nothing — no global fallback, no query-param rescue.
 * Without a pin, `?provider=` (validated) or the xAI default applies; account
 * selection is still workspace-scoped by the credentials call.
 */
async function resolveUnmappedGetProvider(request, connectionId, gateway) {
  if (connectionId) {
    const conns = await getGatewayConnections(gateway, { isActive: true });
    const conn = conns.find((c) => c.id === connectionId);
    if (!conn || !getVideoConfig(conn.provider)) return null;
    return conn.provider;
  }
  const queried = new URL(request.url).searchParams.get("provider");
  if (queried && getVideoConfig(queried)) return queried;
  return DEFAULT_VIDEO_PROVIDER;
}

/**
 * POST /v1/videos/{generations|edits|extensions} — async job creation proxy.
 */
export async function handleVideoCreate(request, action) {
  const auth = await resolveVideoAuth(request);
  if (auth.error) return auth.error;
  const gateway = auth.principal;

  const bodyInfo = await readForwardableBody(request);
  if (bodyInfo.error) return bodyInfo.error;

  // Gateway principals scope the model even when the forwarded bytes stay raw:
  // multipart is sniffed from a copy only — the original buffer is forwarded
  // untouched (re-encoding would change the multipart boundary).
  let modelStr = bodyInfo.parsed?.model ?? null;
  if (!bodyInfo.parsed) {
    const sniffed = await sniffMultipartModel(bodyInfo.raw, bodyInfo.contentType);
    if (sniffed.error) return sniffed.error;
    if (gateway) modelStr = sniffed.model;
  }
  const resolved = await resolveVideoProvider(modelStr, gateway);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  const canonicalModel = model ? `${provider}/${model}` : null;
  if (gateway) {
    // Raw multipart cannot safely rewrite aliases/prefixes without re-encoding.
    // Require the authorized bare value to be exactly what upstream receives.
    if (!bodyInfo.parsed && modelStr && modelStr !== model) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Multipart video requires a bare model id");
    }
    if (canonicalModel) {
      const denied = authorizeGatewayTarget(gateway, { modelId: canonicalModel });
      if (denied) return denied;
    } else if (gateway.scopes?.allowedModels?.length > 0) {
      // Model-restricted key with no canonical model (multipart without a
      // model field): ambiguous — deny rather than guess a scope.
      return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
    }
    // Fail closed before the billable upstream call if activation omitted the
    // provenance store (explicit migration seam — see gatewayVideoJobsRepo).
    try {
      await ensureGatewayVideoJobStore();
    } catch (err) {
      if (err?.code === "GATEWAY_VIDEO_JOBS_MISSING") {
        return errorResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          "Gateway video job store unavailable",
        );
      }
      throw err;
    }
  }

  // Strip the provider prefix (e.g. "xai/grok-imagine-video") before forwarding;
  // otherwise forward the original bytes untouched.
  let forwardBody = bodyInfo.raw;
  if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
    forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const idempotencyKey = request.headers.get("idempotency-key") || null;

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    // Workspace principal (hashed mode) scopes every candidate connection to
    // the key's workspace before any upstream call.
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      ...(gateway ? { principal: gateway } : {}),
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status =
          lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(
          status,
          `[${provider}/${model || "video"}] ${errorMsg}`,
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

    const result = await handleVideoProxyCore({
      provider,
      action,
      rawBody: forwardBody,
      contentType: bodyInfo.contentType || null,
      idempotencyKey,
      credentials: refreshedCredentials,
      signal: request.signal,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model);
      if (gateway && canonicalModel) {
        await recordVideoJobProvenance(gateway, result.response, {
          provider,
          connectionId: credentials.connectionId,
          modelId: canonicalModel,
        });
      }
      // Job creation only; polls (handleVideoGet) are not counted.
      saveRequestUsageUnscoped({
        provider,
        model,
        endpoint: new URL(request.url).pathname,
        connectionId: credentials.connectionId,
        apiKey: auth.legacy ? extractApiKey(request) : null,
        ...gatewayKeyContext(gateway),
        units: { jobs: 1 },
        status: "success",
      }).catch(() => {});
      log.info(
        "VIDEO",
        `${provider.toUpperCase()} | ${action} accepted (connection ${credentials.connectionId})`,
      );
      return withConnectionHeader(result.response, credentials.connectionId);
    }

    // Record the failure (dashboard shows lastError/errorCode → user sees re-auth is needed)
    releaseGrantReservation(credentials.grantReservation);
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      sanitizeSecrets(result.error, refreshedCredentials),
      provider,
      model,
      null,
      { grantId: credentials.grantId },
    );

    if (shouldFallback && CREATE_ROTATION_STATUSES.has(result.status)) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}

/**
 * GET /v1/videos/{request_id} — poll job status.
 * Jobs are account-bound upstream, so no cross-account rotation here: the
 * caller pins the creating account via `x-connection-id` (returned on create).
 */
export async function handleVideoGet(request, requestId) {
  const auth = await resolveVideoAuth(request);
  if (auth.error) return auth.error;
  const gateway = auth.principal;

  if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");

  if (gateway) return handleScopedVideoGet(request, requestId, gateway);

  // Legacy storage — byte-for-byte today's behavior.
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const provider = await resolveGetProvider(request, preferredConnectionId);

  const credentials = await getProviderCredentials(provider, null, null, { preferredConnectionId });
  if (!credentials || credentials.allRateLimited) {
    if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }

  const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

  const result = await handleVideoProxyCore({
    provider,
    requestId,
    credentials: refreshedCredentials,
    signal: request.signal,
    log,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        accessToken: newCreds.accessToken,
        refreshToken: newCreds.refreshToken,
        providerSpecificData: newCreds.providerSpecificData,
        testStatus: "active",
      });
    },
  });

  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials, null);
    return withConnectionHeader(result.response, credentials.connectionId);
  }

  // A poll failure is about one job, not the account: a 404 (unknown/expired
  // job id the client supplied) must not lock anything, and a real account
  // failure locks only video polling (a null model would lock every model and,
  // since a locked account drops the x-connection-id pin, spread to the other
  // accounts on the next poll) (YAN-678).
  if (POLL_LOCK_STATUSES.has(result.status) || result.status >= 500) {
    releaseGrantReservation(credentials.grantReservation);
    await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      sanitizeSecrets(result.error, refreshedCredentials),
      provider,
      VIDEO_POLL_LOCK_MODEL,
      null,
      { grantId: credentials.grantId },
    );
  }
  return result.response;
}

/**
 * Poll under a gateway principal. Recorded provenance (YAN-363) is the only
 * authority: provider/connection/model come from the accepted create response,
 * never from caller headers or query params. Unmapped pre-provenance jobs get
 * the user-approved legacy exception — unrestricted-model keys only, via a
 * workspace-owned connection — and anything ambiguous is denied without a
 * global fallback.
 */
async function handleScopedVideoGet(request, requestId, gateway) {
  const headerConnectionId = request.headers.get("x-connection-id") || null;
  const restricted = (gateway.scopes?.allowedModels?.length || 0) > 0;

  const db = await getAdapter();
  try {
    requireGatewayVideoJobsSync(db);
  } catch (err) {
    if (err?.code === "GATEWAY_VIDEO_JOBS_MISSING") {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Gateway video job store unavailable");
    }
    throw err;
  }
  const mappings = getGatewayVideoJobsSync(db, gateway.workspaceId, requestId);

  if (mappings.length > 1) {
    // Same job id recorded under different providers: ambiguous — deny rather
    // than let the caller pick the target with headers or ?provider=.
    return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
  }

  if (mappings.length === 1) {
    const job = mappings[0];
    const denied = authorizeGatewayTarget(gateway, { modelId: job.modelId });
    if (denied) return denied;
    if (headerConnectionId && headerConnectionId !== job.connectionId) {
      // A header naming any other connection must not rebind an account-bound job.
      return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
    }
    return proxyVideoPoll(
      request,
      requestId,
      job.provider,
      job.connectionId,
      gateway,
      bareModelOf(job),
    );
  }

  if (restricted) {
    // Model-restricted key + no recorded mapping: deny ambiguous, no global fallback.
    return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
  }

  const provider = await resolveUnmappedGetProvider(request, headerConnectionId, gateway);
  if (!provider) return errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
  return proxyVideoPoll(request, requestId, provider, headerConnectionId, gateway, null);
}

/** Workspace-scoped poll proxy: same account-bound, lock, and passthrough semantics as legacy. */
async function proxyVideoPoll(request, requestId, provider, preferredConnectionId, gateway, model) {
  const credentials = await getProviderCredentials(provider, null, model, {
    preferredConnectionId,
    principal: gateway,
  });
  if (!credentials || credentials.allRateLimited) {
    if (credentials?.grantRateLimit) return grantRateLimitResponse(credentials.grantRateLimit);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }

  const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

  const result = await handleVideoProxyCore({
    provider,
    requestId,
    credentials: refreshedCredentials,
    signal: request.signal,
    log,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        accessToken: newCreds.accessToken,
        refreshToken: newCreds.refreshToken,
        providerSpecificData: newCreds.providerSpecificData,
        testStatus: "active",
      });
    },
  });

  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials, model);
    return withConnectionHeader(result.response, credentials.connectionId);
  }

  if (POLL_LOCK_STATUSES.has(result.status) || result.status >= 500) {
    releaseGrantReservation(credentials.grantReservation);
    await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      sanitizeSecrets(result.error, refreshedCredentials),
      provider,
      VIDEO_POLL_LOCK_MODEL,
      null,
      { grantId: credentials.grantId },
    );
  }
  return result.response;
}
