/**
 * Maps the `?error=` codes that SSO routes redirect to `/login` with into
 * plain-English text. Pure and client-safe: no server imports.
 *
 * @param {string} code Raw error code (or text) from the URL, may be null/empty.
 * @returns {string} Human-readable message; "" when there is nothing to show.
 */
export function describeLoginError(code) {
  if (!code) return "";
  const trimmed = String(code).trim();
  if (!trimmed) return "";

  const messages = {
    oidc_not_configured:
      "Single sign-on is enabled, but OIDC is not fully configured. Sign in with a password and finish the OIDC setup in Settings.",
    oidc_invalid_state: "The sign-in session expired or was started in another tab. Try again.",
    oidc_missing_code: "The sign-in provider did not return an authorization code. Try again.",
    oidc_start_failed: "Could not start OIDC sign-in. Check the OIDC settings and try again.",
    oidc_callback_failed: "OIDC sign-in failed. Check the OIDC settings and try again.",
    saml_not_configured:
      "Single sign-on is enabled, but SAML is not fully configured. Sign in with a password and finish the SAML setup in Settings.",
    saml_missing_response: "The SAML response was missing or invalid. Try again.",
    saml_start_failed: "Could not start SAML sign-in. Check the SAML settings and try again.",
    saml_acs_failed: "SAML sign-in failed. Check the SAML settings and try again.",
    access_denied: "The identity provider refused the sign-in request. Try again.",
  };

  if (messages[trimmed]) return messages[trimmed];

  // Unknown code: show the raw text, truncated, as-is (never HTML).
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}
