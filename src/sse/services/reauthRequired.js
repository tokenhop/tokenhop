// YAN-1038: flag access-token-only codex connections that can never refresh.
// Kept out of auth.js (already large).
import { mutateProviderConnectionUnscoped } from "@/lib/db/index.js";
import { isTokenExpiredBody } from "open-sse/services/earlyTokenExpiry.js";
import {
  buildReauthPatch,
  buildReauthRequired,
  getReauthRequired,
  isAccessTokenOnlyExpired,
} from "open-sse/services/reauthState.js";
import { REAUTH_REASONS } from "open-sse/config/reauthConstants.js";
import { isLifetimeAware } from "open-sse/services/tokenLifetime.js";
import * as log from "../utils/logger.js";

const FALLBACK = Object.freeze({ shouldFallback: true, cooldownMs: 0 });
// Connections with a flag write in flight: selection runs per request and must not stack writes.
const flagsInFlight = new Set();

function isAccessTokenOnly(conn, providerId) {
  return (
    isLifetimeAware(providerId) &&
    conn.authType === "access_token" &&
    !conn.refreshToken &&
    Boolean(conn.accessToken)
  );
}

function displayName(conn, connectionId) {
  return conn.displayName || conn.name || conn.email || String(connectionId).slice(0, 8);
}

/**
 * Conditional, transactional flag write: only while the live access token is still the
 * failed one and the row is not flagged (a re-import / re-auth wins). Throws on storage errors.
 * @returns {Promise<boolean>} true when the flag was written
 */
async function writeAccessTokenFlag(conn, connectionId) {
  const failedAccessToken = conn.accessToken;
  const { applied } = await mutateProviderConnectionUnscoped(connectionId, (live) => {
    if (getReauthRequired(live) || live.refreshToken || live.accessToken !== failedAccessToken) {
      return null;
    }
    return buildReauthPatch(
      buildReauthRequired({ reason: REAUTH_REASONS.accessTokenExpired, code: "token_expired" }),
    );
  });
  if (applied) {
    log.warn(
      "AUTH",
      `${displayName(conn, connectionId)} needs re-authentication (access token expired)`,
    );
  }
  return applied;
}

/**
 * Persist the flag for an unflagged access-token-only row already past its expiry
 * (stored expiresAt capped by the JWT exp). No network. Never throws: errors are logged
 * (no token material) so selection / the background tick are never affected.
 */
export async function flagExpiredAccessTokenRow(conn, providerId = conn?.provider) {
  const id = conn?.id;
  if (!id || getReauthRequired(conn) || !isAccessTokenOnlyExpired(providerId, conn)) return false;
  if (flagsInFlight.has(id)) return false;
  flagsInFlight.add(id);
  try {
    return await writeAccessTokenFlag(conn, id);
  } catch (error) {
    log.warn("AUTH", `Could not persist re-authentication state: ${error?.message || error}`);
    return false;
  } finally {
    flagsInFlight.delete(id);
  }
}

/** Fire-and-forget variant for the selection hot path. */
export function scheduleFlagExpiredAccessToken(conn, providerId) {
  void flagExpiredAccessTokenRow(conn, providerId);
}

/**
 * @returns {Promise<{ shouldFallback: true, cooldownMs: 0 } | null>} a fallback result when the
 *   failure was handled as a re-authentication state (no model lock written), else null
 *   (also when the flag write fails, so the ordinary lock path still runs).
 */
export async function handleReauthOnFailure({ conn, connectionId, status, errorText, providerId }) {
  if (!conn) return null;
  if (getReauthRequired(conn)) return { ...FALLBACK };
  if (status !== 401 || !isAccessTokenOnly(conn, providerId)) return null;
  if (!isTokenExpiredBody(errorText) && !isAccessTokenOnlyExpired(providerId, conn)) return null;

  try {
    await writeAccessTokenFlag(conn, connectionId);
  } catch (error) {
    log.warn("AUTH", `Could not persist re-authentication state: ${error?.message || error}`);
    return null;
  }
  return { ...FALLBACK };
}
