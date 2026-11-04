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
 * An access-token-only row (no refresh token) whose known expiry has passed.
 * Mirrors tokenLifetime.getCredentialExpiryMs exactly: stored =
 * expiresAt ?? tokenExpiresAt, then the earlier of stored and the JWT exp.
 * Not imported (tokenLifetime → the provider registry is too heavy for the
 * DB layer's cold-start path).
 */
function isExpiredAccessTokenOnly(row, nowMs) {
  if (row.refreshToken || !row.accessToken) return false;
  const stored = parseMs(row.expiresAt ?? row.tokenExpiresAt);
  const exp = Number(decodeJwtPayload(row.accessToken)?.exp);
  const expMs = Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  const expiry = expMs === null ? stored : stored === null ? expMs : Math.min(stored, expMs);
  return expiry !== null && expiry <= nowMs;
}

const accountIdFromJwt = (token) => {
  const payload = typeof token === "string" && token ? decodeJwtPayload(token) : null;
  const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || payload?.account_id;
  return typeof id === "string" && id ? id : null;
};

/**
 * YAN-1623: the ChatGPT account id a codex row/grant provably belongs to —
 * providerSpecificData.chatgptAccountId, the auth claim of the idToken and of
 * the accessToken (same claims as oauth extractCodexAccountInfo). Null when
 * none is derivable, or when the derivable ids disagree (bulk import can store
 * an unchecked chatgptAccountId), since then the account is unprovable.
 */
export function codexAccountIdOf(row) {
  if (!row) return null;
  const stored = row.providerSpecificData?.chatgptAccountId;
  const ids = [
    typeof stored === "string" && stored ? stored : null,
    accountIdFromJwt(row.idToken),
    accountIdFromJwt(row.accessToken),
  ].filter(Boolean);
  if (!ids.length || ids.some((id) => id !== ids[0])) return null;
  return ids[0];
}

/**
 * YAN-1623: is this codex row's stored credential pair dead (flagged for
 * re-authentication, or an access-token-only row past its expiry)?
 */
export function isDeadCodexRow(row, nowMs = Date.now()) {
  const flag = row?.reauthRequired;
  if (flag && typeof flag === "object" && REAUTH_REASON_VALUES.has(flag.reason)) return true;
  return row?.authType === "access_token" && isExpiredAccessTokenOnly(row, nowMs);
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

/**
 * YAN-1623: may this flagged row be REMOVED as a duplicate of the incoming
 * grant? Stricter than matchesFlaggedReplacement: the row must also carry a
 * proven account id equal to the incoming one, so a dead row of another
 * account sharing the email is never deleted.
 */
export function matchesFlaggedDuplicate(existing, incoming, nowMs = Date.now()) {
  if (!matchesFlaggedReplacement(existing, incoming, nowMs)) return false;
  const rowId = codexAccountIdOf(existing);
  return !!rowId && rowId === codexAccountIdOf(incoming);
}
