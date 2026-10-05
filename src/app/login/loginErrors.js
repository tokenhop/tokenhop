const MESSAGES = {
  oidc_not_configured:
    "Single sign-on is enabled, but OIDC is not fully configured. Sign in with a password and finish the OIDC setup in Settings.",
  oidc_invalid_state: "The sign-in session expired or was started in another tab. Try again.",
  oidc_missing_code: "The sign-in provider did not return an authorization code. Try again.",
  oidc_start_failed: "Could not start OIDC sign-in. Check the OIDC settings and try again.",
  oidc_callback_failed:
    "OIDC sign-in failed. Check the OIDC settings and the server log, then try again.",
  saml_not_configured:
    "Single sign-on is enabled, but SAML is not fully configured. Sign in with a password and finish the SAML setup in Settings.",
  saml_missing_response: "The SAML response was missing or invalid. Try again.",
  saml_start_failed: "Could not start SAML sign-in. Check the SAML settings and try again.",
  saml_acs_failed:
    "SAML sign-in failed. Check the SAML settings and the server log, then try again.",
  too_many_attempts: "Too many failed sign-in attempts. Wait a few minutes and try again.",
  access_denied: "The identity provider refused the sign-in request. Try again.",
  sso_not_linked:
    "This single sign-on account isn't linked to a user here. Sign in with a password or ask an admin.",
  invalid_credentials: "Invalid email/username or password.",
  account_pending: "This account is waiting for an admin to approve it.",
  account_disabled: "This account has been disabled by an admin.",
  password_change_required: "Your password must be changed before you can sign in.",
  password_change_expired: "Your password change session expired. Sign in again.",
};

/**
 * Maps the `?error=` codes that SSO routes redirect to `/login` with into
 * plain-English text. Unknown values get a generic message so a crafted link
 * can't put arbitrary text on the sign-in page. Pure and client-safe.
 *
 * @param {string|null} code Raw `?error=` value.
 * @returns {string} Message to show; "" when there is nothing to show.
 */
export function describeLoginError(code) {
  const key = String(code || "").trim();
  if (!key) return "";
  return Object.hasOwn(MESSAGES, key) ? MESSAGES[key] : "Sign-in failed. Try again.";
}
