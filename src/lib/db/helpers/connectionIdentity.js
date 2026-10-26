// Single source of truth for "is this the same provider account?" (YAN-1053).
// Used by creation dedup (connectionsRepo createInTx) and the workspace-move
// planner so both agree on identity. Pure: no I/O, no workspace comparison
// (callers scope the candidate set). Intentionally NOT exported via the DB barrel.
import { REAUTH_REASONS } from "open-sse/config/reauthConstants.js";
import { decodeJwtPayload } from "open-sse/utils/jwt.js";

/**
 * @param {object} existing stored connection (provider, authType, email, name, providerSpecificData)
 * @param {object} incoming connection being created / moved
 * @returns {boolean} true when `incoming` is the same account as `existing`
 */
export function matchesConnectionIdentity(existing, incoming) {
  if (!existing || !incoming || existing.provider !== incoming.provider) return false;

  if (incoming.authType === "oauth" && incoming.email) {
    if (existing.authType !== "oauth" || existing.email !== incoming.email) return false;
    const incomingUsername = incoming.providerSpecificData?.username;
    const incomingWs = incoming.providerSpecificData?.chatgptAccountId;
    const existingWs = existing.providerSpecificData?.chatgptAccountId;

    // Codex/OpenAI can issue multiple OAuth grants for the same email.
    // Refresh tokens are rotated single-use; collapsing a new login onto an
    // existing bare-email row overwrites the first account's token pair and
    // makes it look "invalid" after adding a second account. Only match an
    // existing Codex row when both rows expose the same ChatGPT account ID.
    if (incoming.provider === "codex") {
      return !!incomingWs && !!existingWs && incomingWs === existingWs;
    }

    // Workspace providers use workspace ID when both sides have it
    if (incomingWs && existingWs) return incomingWs === existingWs;
    if (incomingWs && !existingWs) return false;
    if (!incomingWs && existingWs) return false;
    // Non-workspace providers: match on (email + username) so cross-IdP
    // accounts don't overwrite each other. If only one side has a username,
    // treat as a distinct identity rather than collapsing onto the bare-email
    // fallback (which would re-introduce the cross-IdP overwrite).
    const existingUsername = existing.providerSpecificData?.username;
    if (incomingUsername && existingUsername) return incomingUsername === existingUsername;
    if (incomingUsername || existingUsername) return false;
    return true;
  }

  if (incoming.authType === "apikey" && incoming.name) {
    return existing.authType === "apikey" && existing.name === incoming.name;
  }

  // access_token and everything else: never dedup — user manages duplicates manually.
  return false;
}

// YAN-1287: codex reasons whose flag means the stored credential pair is dead.
const REAUTH_REASON_VALUES = new Set(Object.values(REAUTH_REASONS));

const sameAccountId = (a, b) => typeof a === "string" && typeof b === "string" && a === b;

const parseMs = (v) => {
  const t = typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * An access-token-only row (no refresh token) whose known expiry has passed:
 * the earlier of the stored expiresAt/tokenExpiresAt and the JWT exp. Mirrors
 * reauthState.isAccessTokenOnlyExpired for codex without importing it
 * (reauthState → tokenLifetime → the provider registry is too heavy for the
 * DB layer's cold-start path).
 */
function isExpiredAccessTokenOnly(row, nowMs) {
  if (row.refreshToken || !row.accessToken) return false;
  const exp = decodeJwtPayload(row.accessToken)?.exp;
  const candidates = [
    parseMs(row.expiresAt),
    parseMs(row.tokenExpiresAt),
    Number.isFinite(Number(exp)) && Number(exp) > 0 ? Number(exp) * 1000 : null,
  ].filter((t) => t !== null);
  return candidates.length > 0 && Math.min(...candidates) <= nowMs;
}

/**
 * YAN-1287: may a fresh codex grant REPLACE this dead row? Much looser than
 * matchesConnectionIdentity — the move planner keeps the strict semantics above.
 * A dead row only holds a dead token pair, so the YAN-1053 "don't collapse two
 * live grants" concern does not apply; a reconnect/re-import of the same
 * account must land on it instead of leaving it stale. "Dead" means flagged
 * for re-authentication, or (access_token only) already past its expiry even
 * though no flag has been written yet.
 *
 * - oauth: flagged, same non-empty email, and the ChatGPT account ID matches
 *   whenever both sides have one (a legacy row may predate the field).
 * - access_token: flagged or expired, both emails present and equal, and the
 *   same chatgptAccountId.
 */
export function matchesFlaggedReplacement(existing, incoming, nowMs = Date.now()) {
  if (
    !existing ||
    !incoming ||
    existing.provider !== "codex" ||
    incoming.provider !== "codex" ||
    existing.authType !== incoming.authType
  ) {
    return false;
  }
  const flag = existing.reauthRequired;
  const flagged = Boolean(
    flag && typeof flag === "object" && REAUTH_REASON_VALUES.has(flag.reason),
  );

  const existingAccountId = existing.providerSpecificData?.chatgptAccountId;
  const incomingAccountId = incoming.providerSpecificData?.chatgptAccountId;

  if (incoming.authType === "oauth") {
    if (!flagged) return false;
    if (!incoming.email || existing.email !== incoming.email) return false;
    if (existingAccountId === undefined || existingAccountId === null) return true;
    return incomingAccountId === existingAccountId;
  }
  if (incoming.authType === "access_token") {
    if (!flagged && !isExpiredAccessTokenOnly(existing, nowMs)) return false;
    // Both emails must be present and equal — an import without an email must
    // never replace an email-carrying row on account id alone.
    if (!existing.email || existing.email !== incoming.email) return false;
    return sameAccountId(existingAccountId, incomingAccountId);
  }
  return false;
}
