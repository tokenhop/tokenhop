/**
 * Single source of truth for what an `authMode` / `ssoType` pair allows.
 * Pure and client-safe: no server imports.
 *
 * - "both"                    → password + SSO
 * - "sso" / "oidc" / "saml"   → SSO only (legacy "oidc"/"saml" also name the protocol)
 * - anything else             → password only
 *
 * @param {{ authMode?: string, ssoType?: string }} [settings]
 * @returns {{ password: boolean, oidc: boolean, saml: boolean, protocol: "oidc"|"saml", ssoOnly: boolean }}
 *   `oidc`/`saml` say whether that protocol may sign in under the current mode
 *   (not whether it is configured); `protocol` is the selected SSO protocol.
 */
export function resolveAuthModes({ authMode, ssoType } = {}) {
  const ssoOnly = authMode === "sso" || authMode === "oidc" || authMode === "saml";
  const ssoEnabled = ssoOnly || authMode === "both";
  const protocol =
    authMode === "oidc" || authMode === "saml" ? authMode : ssoType === "saml" ? "saml" : "oidc";
  return {
    password: !ssoOnly,
    oidc: ssoEnabled && protocol === "oidc",
    saml: ssoEnabled && protocol === "saml",
    protocol,
    ssoOnly,
  };
}
