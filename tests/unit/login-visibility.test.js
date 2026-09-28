import { describe, expect, it } from "vitest";
import { resolveLoginVisibility } from "@/app/login/loginVisibility";

describe("resolveLoginVisibility", () => {
  it("shows password only in password mode", () => {
    expect(
      resolveLoginVisibility({ authMode: "password", ssoType: "oidc", oidc: false, saml: false }),
    ).toEqual({ samlAvailable: false, oidcAvailable: false, passwordAvailable: true });
  });

  it("shows SAML button when saml active and configured", () => {
    expect(
      resolveLoginVisibility({ authMode: "saml", ssoType: "saml", oidc: false, saml: true }),
    ).toEqual({ samlAvailable: true, oidcAvailable: false, passwordAvailable: false });
  });

  it("keeps password fallback when SSO enabled but unconfigured", () => {
    expect(
      resolveLoginVisibility({ authMode: "sso", ssoType: "oidc", oidc: false, saml: false }),
    ).toEqual({ samlAvailable: false, oidcAvailable: false, passwordAvailable: true });
  });

  it("shows OIDC button without password when configured", () => {
    expect(
      resolveLoginVisibility({ authMode: "oidc", ssoType: "oidc", oidc: true, saml: false }),
    ).toEqual({ samlAvailable: false, oidcAvailable: true, passwordAvailable: false });
  });

  it("shows both OIDC and password in both mode", () => {
    expect(
      resolveLoginVisibility({ authMode: "both", ssoType: "oidc", oidc: true, saml: false }),
    ).toEqual({ samlAvailable: false, oidcAvailable: true, passwordAvailable: true });
  });

  it("falls back to oidc for unknown ssoType", () => {
    expect(
      resolveLoginVisibility({ authMode: "sso", ssoType: "", oidc: true, saml: true }),
    ).toEqual({ samlAvailable: false, oidcAvailable: true, passwordAvailable: false });
  });
});
