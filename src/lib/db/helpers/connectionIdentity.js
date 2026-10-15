// Single source of truth for "is this the same provider account?" (YAN-1053).
// Used by creation dedup (connectionsRepo createInTx) and the workspace-move
// planner so both agree on identity. Pure: no I/O, no workspace comparison
// (callers scope the candidate set). Intentionally NOT exported via the DB barrel.

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
