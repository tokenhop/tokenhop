// Live model catalog for OpenAI Codex (ChatGPT subscription) connections.
// Upstream: GET chatgpt.com/backend-api/codex/models?client_version=<CODEX_CLI_VERSION>.
// The server gates entries by client version: a stale version comes back 200 with the
// newest models silently missing, so ids the static catalog knows but the live list
// lacks are surfaced as a warning pointing at the version to bump.

import { refreshCodexToken } from "@/sse/services/tokenRefresh";
import { buildOAuthResolver } from "@/lib/providerModels/oauthResolver.js";
import { CODEX_CLI_VERSION } from "open-sse/config/appConstants.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { CODEX_REVIEW_SUFFIX, withCodexReviewModels } from "open-sse/providers/models/helpers.js";

export const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`;

// Codex CLI keeps "hide"/"none" models out of its picker but they stay callable.
const HIDDEN_VISIBILITY = new Set(["hide", "none"]);

const kindOf = (model) => model?.kind || model?.type || "llm";
// Virtual models forwarded verbatim (codex-auto-review) — not a derived "-review" variant.
const isVirtual = (model) => model?.upstreamModelId && model.upstreamModelId === model.id;

/**
 * Map the upstream catalog to slim entries (the raw entries carry base_instructions and
 * other prompt payloads) and synthesize the "-review" quota-family variants.
 */
export function parseCodexModels(data) {
  const entries = Array.isArray(data) ? data : data?.models || data?.data || [];
  const models = entries.flatMap((entry) => {
    const id = entry?.slug || entry?.id;
    if (typeof id !== "string" || !id.trim()) return [];
    const kind = kindOf(entry);
    return [
      {
        id,
        name: entry.display_name || entry.name || id,
        ...(entry.description ? { description: entry.description } : {}),
        ...(Number.isFinite(entry.context_window) ? { contextLength: entry.context_window } : {}),
        ...(kind !== "llm" ? { kind } : {}),
        ...(HIDDEN_VISIBILITY.has(entry.visibility) ? { hidden: true } : {}),
      },
    ];
  });
  return withCodexReviewModels(models);
}

/**
 * The live catalog only lists chat models. Keep the static entries it never returns
 * (image models, virtual review models) so /v1/models and the dashboard still list them.
 */
export function withStaticCodexExtras(liveModels, staticModels) {
  const liveIds = new Set(liveModels.map((m) => m.id));
  const extras = staticModels
    .filter((m) => !liveIds.has(m.id) && (kindOf(m) !== "llm" || isVirtual(m)))
    .map(({ id, name, kind, type, upstreamModelId, quotaFamily }) => ({
      id,
      name,
      ...(kind || type ? { kind: kind || type } : {}),
      ...(upstreamModelId ? { upstreamModelId } : {}),
      ...(quotaFamily ? { quotaFamily } : {}),
    }));
  return [...liveModels, ...extras];
}

/** Static chat-model base ids the live catalog did not return. */
export function missingStaticCodexIds(liveModels, staticModels) {
  const liveIds = new Set(liveModels.map((m) => m.id));
  return staticModels
    .filter(
      (m) =>
        kindOf(m) === "llm" &&
        !isVirtual(m) &&
        !m.id.endsWith(CODEX_REVIEW_SUFFIX) &&
        !liveIds.has(m.id),
    )
    .map((m) => m.id);
}

const resolveCodexOAuthModels = buildOAuthResolver({
  refreshFn: async (conn) => {
    const refreshed = await refreshCodexToken(conn.refreshToken);
    // Stamp the refresh so lastRefreshAt-based lifetime tracking (YAN-1034/1035) stays accurate.
    return refreshed?.accessToken
      ? { ...refreshed, lastRefreshAt: new Date().toISOString() }
      : refreshed;
  },
  fetchFn: (token) =>
    fetch(CODEX_MODELS_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        originator: "codex_cli_rs",
      },
    }),
  parseFn: parseCodexModels,
  errorLabel: "Failed to fetch Codex models",
});

export async function resolveCodex(connection) {
  const result = await resolveCodexOAuthModels(connection);
  if (result.error) return { models: [], warning: result.error };
  if (!result.models.length) {
    return { models: [], warning: result.warning || "Codex returned no live models." };
  }
  const staticModels = getModelsByProviderId("codex");
  const models = withStaticCodexExtras(result.models, staticModels);
  const missing = missingStaticCodexIds(result.models, staticModels);
  if (!missing.length) return { models };
  const warning = `Codex live catalog is missing ${missing.join(", ")}. If these are current models, set CODEX_CLI_VERSION to your installed Codex CLI version (currently sending client_version=${CODEX_CLI_VERSION}).`;
  console.warn(warning);
  return { models, warning };
}
