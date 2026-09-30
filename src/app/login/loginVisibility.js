import { resolveAuthModes } from "@/lib/auth/authModes";

/**
 * Pure visibility helper for login options based on authMode and configured SSO.
 *
 * @param {object} params
 * @param {string} [params.authMode="password"]
 * @param {string} [params.ssoType="oidc"]
 * @param {boolean} [params.oidc=false] OIDC is fully configured
 * @param {boolean} [params.saml=false] SAML is fully configured
 * @returns {{ samlAvailable: boolean, oidcAvailable: boolean, passwordAvailable: boolean }}
 */
export function resolveLoginVisibility({
  authMode = "password",
  ssoType = "oidc",
  oidc = false,
  saml = false,
} = {}) {
  const modes = resolveAuthModes({ authMode, ssoType });
  const samlAvailable = modes.saml && Boolean(saml);
  const oidcAvailable = modes.oidc && Boolean(oidc);

  // Password stays available when SSO was chosen but is unconfigured (recovery).
  const passwordAvailable = modes.password || !(samlAvailable || oidcAvailable);

  return { samlAvailable, oidcAvailable, passwordAvailable };
}
