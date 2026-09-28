/**
 * Pure visibility helper for login options based on authMode and configured SSO.
 *
 * @param {object} params
 * @param {string} [params.authMode="password"]
 * @param {string} [params.ssoType="oidc"]
 * @param {boolean} [params.oidc=false]
 * @param {boolean} [params.saml=false]
 * @returns {{ samlAvailable: boolean, oidcAvailable: boolean, passwordAvailable: boolean }}
 */
export function resolveLoginVisibility({
  authMode = "password",
  ssoType = "oidc",
  oidc = false,
  saml = false,
} = {}) {
  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && Boolean(saml);
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && Boolean(oidc);
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

  return {
    samlAvailable,
    oidcAvailable,
    passwordAvailable,
  };
}
