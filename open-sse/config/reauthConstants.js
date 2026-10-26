// YAN-1037/1038: constants for the "connection needs re-authentication" state.
// Pure, no imports: safe to use from client (dashboard) code.

export const REAUTH_REASONS = Object.freeze({
  refreshTokenRejected: "refresh_token_rejected",
  accessTokenExpired: "access_token_expired",
  accessTokenRejected: "access_token_rejected",
});

// Allowlist for reauthRequired.code; anything else is stored as "unknown".
// Never persist raw upstream text.
export const REAUTH_CODES = Object.freeze([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
  "token_expired",
  "token_invalidated",
  "token_revoked",
  "invalid_token",
  "invalid_api_key",
  "account_deactivated",
  "unknown",
]);

// Exact CREDENTIAL_FAILURES keys (src/shared/utils/providerHealth.js): legacy readers keep working.
export const REAUTH_LAST_ERROR = Object.freeze({
  refresh_token_rejected: "Token expired and refresh failed",
  access_token_expired: "Token expired",
  access_token_rejected: "Token invalid or revoked",
});

// Read by getConnectionErrorTag / CombosPageClient errorTag -> "AUTH" / "Auth error".
export const REAUTH_ERROR_TYPE = Object.freeze({
  refresh_token_rejected: "token_refresh_failed",
  access_token_expired: "token_expired",
  access_token_rejected: "token_expired",
});

/** `error` value emitted by a refresher when the refresh token is permanently dead. */
export const UNRECOVERABLE_REFRESH_ERROR = "unrecoverable_refresh_error";
