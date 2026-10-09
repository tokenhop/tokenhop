/**
 * Pure helpers for connection sharing (YAN-376 providers + sharing).
 * No React, no fetch — the hooks and dialogs in this folder wrap these, and
 * tests/unit/providers-sharing-ui.test.js covers them directly.
 * Payload contract mirrors POST /api/providers/[id]/grants exactly:
 * keys workspaceId | userId, allowedModels, rpm, tpm, tosAcknowledged.
 */
import { parseModelScope } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";

/**
 * A subscription-bound connection (registry sharing: "personal"): not
 * grantable unless the instance owner/admin overrides with an acknowledged
 * terms warning (ADR-0006).
 * @param {{sharing?: string}|null} connection
 * @returns {boolean}
 */
export function isPersonalConnection(connection) {
  return connection?.sharing === "personal";
}

/**
 * Grants visible to this caller: rows granted to the active workspace or to
 * the caller directly, deduped by grantId. /api/grants takes no query params;
 * the response carries every incoming grant, so the client narrows it.
 * @param {Array<{grantId: string, granteeWorkspaceId?: string|null, granteeUserId?: string|null}>} grants
 * @param {{activeWorkspaceId?: string|null, userId?: string|null}} [ids]
 * @returns {Array}
 */
export function filterIncomingGrants(grants, { activeWorkspaceId, userId } = {}) {
  const seen = new Set();
  const out = [];
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant?.grantId || seen.has(grant.grantId)) continue;
    const toWorkspace =
      Boolean(activeWorkspaceId) && grant.granteeWorkspaceId === activeWorkspaceId;
    const toUser = Boolean(userId) && grant.granteeUserId === userId;
    if (toWorkspace || toUser) {
      seen.add(grant.grantId);
      out.push(grant);
    }
  }
  return out;
}

/**
 * Shared workspaces the caller may grant into (owner or manager). Personal
 * workspaces never receive grants — their members are the owner alone.
 * @param {Array<{id: string, kind?: string, role?: string}>} workspaces `accountView().workspaces`
 * @returns {Array<{value: string, label: string}>} Select options
 */
export function shareableWorkspaceOptions(workspaces) {
  return (Array.isArray(workspaces) ? workspaces : [])
    .filter((w) => w?.kind === "shared" && (w.role === "owner" || w.role === "manager"))
    .map((w) => ({ value: w.id, label: w.name }));
}

/**
 * User grantee options from /api/workspaces/:id/members, minus the caller
 * (sharing with yourself is a no-op the server would reject as duplicate).
 * @param {Array<{userId: string, displayName?: string|null}>} members
 * @param {{excludeUserId?: string|null}} [ids]
 * @returns {Array<{value: string, label: string}>} Select options
 */
export function memberGranteeOptions(members, { excludeUserId } = {}) {
  return (Array.isArray(members) ? members : [])
    .filter((m) => m?.userId && m.userId !== excludeUserId)
    .map((m) => ({ value: m.userId, label: m.displayName || m.userId }));
}

/**
 * Optional positive rate limit (rpm/tpm). Empty means unset.
 * @param {string} text
 * @returns {{value: number|null, error: string|null}}
 */
export function parseRateLimit(text) {
  if (!text || !String(text).trim()) return { value: null, error: null };
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    return { value: null, error: "Enter a whole number greater than 0" };
  }
  return { value, error: null };
}

const RATE_LABELS = { rpm: "Requests per minute", tpm: "Tokens per minute" };

/**
 * Build the POST /api/providers/[id]/grants body. Exactly one grantee
 * (workspace or user); optional model scope and rate limits; on a personal
 * connection the ADR-0006 acknowledgement echo rides along.
 * @param {object} args
 * @param {"workspace"|"user"} args.granteeType
 * @param {string} [args.workspaceId]
 * @param {string} [args.userId]
 * @param {string} [args.modelsText] free-text model scope (empty = all models)
 * @param {string} [args.rpm] requests per minute
 * @param {string} [args.tpm] tokens per minute
 * @param {{provider: string, sharing?: string}} args.connection grant source row
 * @returns {{payload: object|null, errors: string[]}}
 */
export function buildSharePayload({
  granteeType,
  workspaceId,
  userId,
  modelsText,
  rpm,
  tpm,
  connection,
}) {
  const errors = [];
  const rates = {};
  for (const key of ["rpm", "tpm"]) {
    const parsed = parseRateLimit(key === "rpm" ? rpm : tpm);
    rates[key] = parsed.value;
    if (parsed.error) errors.push(`${RATE_LABELS[key]}: ${parsed.error}`);
  }
  const scope = parseModelScope(modelsText || "");
  if (scope.error) errors.push(scope.error);
  let grantee = null;
  if (granteeType === "workspace" && workspaceId) grantee = { workspaceId };
  else if (granteeType === "user" && userId) grantee = { userId };
  else errors.push("Choose who to share with");
  if (errors.length > 0) return { payload: null, errors };

  const payload = { ...grantee, rpm: rates.rpm, tpm: rates.tpm };
  if (scope.models) payload.allowedModels = scope.models;
  if (isPersonalConnection(connection)) {
    payload.tosAcknowledged = { providerId: connection.provider, sharing: "personal" };
  }
  return { payload, errors };
}
