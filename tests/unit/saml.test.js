import { describe, it, expect } from "vitest";
import {
  formatX509Certificate,
  isSamlConfigured,
  generateSamlMetadata,
  pickSamlEmail,
  pickSamlDisplayName,
  pickSamlGroups,
  validateSamlResponse,
} from "../../src/lib/auth/saml.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import { ACTIVE, LEGACY } from "@/shared/brand";

describe("SAML 2.0 Auth Engine Utilities", () => {
  describe("formatX509Certificate", () => {
    it("formats raw Base64 string into standard 64-column PEM block", () => {
      const rawBase64 =
        "MIIC1234567890123456789012345678901234567890123456789012345678901234567890";
      const formatted = formatX509Certificate(rawBase64);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted).toContain("-----END CERTIFICATE-----");
      expect(formatted).toContain(
        "MIIC123456789012345678901234567890123456789012345678901234567890",
      );
      expect(formatted).toContain("\n1234567890\n");
    });

    it("cleans existing PEM header/footer and extra whitespace", () => {
      const rawPem = `
        -----BEGIN CERTIFICATE-----
        MIIC123456789012345678901234567890123456789012345678901234567890
        1234567890
        -----END CERTIFICATE-----
      `;
      const formatted = formatX509Certificate(rawPem);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted.match(/BEGIN CERTIFICATE/g)?.length).toBe(1);
    });

    it("returns empty string for null, undefined, or invalid inputs", () => {
      expect(formatX509Certificate(null)).toBe("");
      expect(formatX509Certificate(undefined)).toBe("");
      expect(formatX509Certificate("   ")).toBe("");
    });
  });

  describe("isSamlConfigured", () => {
    it("returns true when entryPoint and cert are non-empty", () => {
      expect(
        isSamlConfigured({
          samlEntryPoint: "https://idp.example.com/sso",
          samlCert: "dummy-cert",
        }),
      ).toBe(true);
    });

    it("returns false if entryPoint or cert is missing", () => {
      expect(isSamlConfigured({ samlEntryPoint: "https://idp.example.com/sso" })).toBe(false);
      expect(isSamlConfigured({ samlCert: "dummy-cert" })).toBe(false);
      expect(isSamlConfigured({})).toBe(false);
    });
  });

  describe("generateSamlMetadata", () => {
    it("generates valid SP XML metadata with Entity ID and ACS binding", () => {
      const settings = {
        samlEntryPoint: "https://idp.example.com/sso",
        samlIssuer: LEGACY.samlIssuerDefault,
        samlCert: "MIIC123456789012345678901234567890123456789012345678901234567890",
      };
      const xml = generateSamlMetadata("https://localhost:20127", settings);
      expect(xml).toContain(`entityID="${LEGACY.samlIssuerDefault}"`);
      expect(xml).toContain('Location="https://localhost:20127/api/auth/saml/acs"');
      expect(xml).toContain('WantAssertionsSigned="true"');
    });
  });

  describe("InResponseTo Replay Validation", () => {
    it("throws error when saml_state cookie is missing", async () => {
      const rawXml = Buffer.from('<Response InResponseTo="x"></Response>').toString("base64");
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, "", { samlCert: "dummy-cert" }),
      ).rejects.toThrow(/Missing SAML request state/);
    });

    it("throws error when expectedRequestId is supplied but InResponseTo is missing", async () => {
      const settings = { samlCert: "dummy-cert" };
      const rawXml = Buffer.from('<Response ID="123"></Response>').toString("base64");
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, "req-123", settings),
      ).rejects.toThrow(/InResponseTo mismatch/);
    });

    it("throws error when expectedRequestId is supplied but InResponseTo does not match", async () => {
      const settings = { samlCert: "dummy-cert" };
      const rawXml = Buffer.from('<Response InResponseTo="wrong-id"></Response>').toString(
        "base64",
      );
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, "req-123", settings),
      ).rejects.toThrow(/InResponseTo mismatch/);
    });

    it("throws error if samlCert is not configured", async () => {
      const rawXml = Buffer.from('<Response ID="123"></Response>').toString("base64");
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, "req-123", {}),
      ).rejects.toThrow(/certificate/);
    });
  });

  describe("Claims Extraction", () => {
    const mockProfile = {
      email: "user@example.com",
      displayName: "Jane Doe",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": ["custom@example.com"],
      customEmail: "custom-email@example.com",
      customName: "Custom User",
    };

    it("pickSamlEmail extracts custom attribute or common claims", () => {
      expect(pickSamlEmail(mockProfile, {})).toBe("user@example.com");
      expect(pickSamlEmail(mockProfile, { samlAttributeEmail: "customEmail" })).toBe(
        "custom-email@example.com",
      );
      expect(
        pickSamlEmail(
          {
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": [
              "custom@example.com",
            ],
          },
          {},
        ),
      ).toBe("custom@example.com");
    });

    it("pickSamlDisplayName extracts custom attribute, common names, or falls back to email", () => {
      expect(pickSamlDisplayName(mockProfile, {})).toBe("Jane Doe");
      expect(pickSamlDisplayName(mockProfile, { samlAttributeName: "customName" })).toBe(
        "Custom User",
      );
      expect(pickSamlDisplayName({ email: "user@example.com" }, {})).toBe("user@example.com");
      expect(pickSamlDisplayName({ givenName: "Alice", surname: "Smith" }, {})).toBe("Alice Smith");
    });
  });

  describe("pickSamlGroups", () => {
    const URI = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/role";

    it("defaults to the own `groups` key and reports absence", () => {
      expect(pickSamlGroups({ groups: ["a", "b"] }, {})).toEqual({
        present: true,
        groups: ["a", "b"],
        invalid: false,
      });
      expect(pickSamlGroups({ email: "x@y.z" }, {})).toEqual({
        present: false,
        groups: null,
        invalid: false,
      });
    });

    it("configured own profile key takes precedence over attributes", () => {
      const profile = {
        memberOf: ["profile-key"],
        attributes: { memberOf: ["attr-key"], groups: ["default-key"] },
      };
      expect(pickSamlGroups(profile, { samlAttributeGroups: "memberOf" })).toEqual({
        present: true,
        groups: ["profile-key"],
        invalid: false,
      });
    });

    it("falls back to the same configured key under profile.attributes", () => {
      const profile = { attributes: { memberOf: ["attr-key"] } };
      expect(pickSamlGroups(profile, { samlAttributeGroups: "memberOf" })).toEqual({
        present: true,
        groups: ["attr-key"],
        invalid: false,
      });
    });

    it("keeps URI attribute keys literal (never dot-split)", () => {
      const profile = { [URI]: ["uri-groups"] };
      expect(pickSamlGroups(profile, { samlAttributeGroups: URI })).toEqual({
        present: true,
        groups: ["uri-groups"],
        invalid: false,
      });
      expect(
        pickSamlGroups({ attributes: { [URI]: "admins" } }, { samlAttributeGroups: URI }),
      ).toEqual({ present: true, groups: ["admins"], invalid: false });
    });

    it("explicit empty array is present and suppresses the attributes fallback", () => {
      const profile = { groups: [], attributes: { groups: ["attr"] } };
      expect(pickSamlGroups(profile, {})).toEqual({ present: true, groups: [], invalid: false });
    });

    it("normalizes scalars, never CSV-splits, drops unsafe/oversize entries", () => {
      expect(pickSamlGroups({ groups: "a,b" }, {}).groups).toEqual(["a,b"]);
      expect(pickSamlGroups({ groups: ["ok", "__proto__", 5, "", "x".repeat(257)] }, {})).toEqual({
        present: true,
        groups: ["ok"],
        invalid: false,
      });
    });

    it("marks invalid claim shapes present-and-invalid", () => {
      expect(pickSamlGroups({ groups: { nested: true } }, {})).toEqual({
        present: true,
        groups: null,
        invalid: true,
      });
      expect(pickSamlGroups({ groups: 42 }, {})).toEqual({
        present: true,
        groups: null,
        invalid: true,
      });
    });

    it("ignores inherited keys and tolerates a missing profile", () => {
      expect(pickSamlGroups(Object.create({ groups: ["leak"] }), {}).present).toBe(false);
      expect(pickSamlGroups(null, {})).toEqual({ present: false, groups: null, invalid: false });
      expect(pickSamlGroups(undefined, { samlAttributeGroups: "groups" }).present).toBe(false);
    });

    it("does not mutate the profile or settings", () => {
      const profile = { attributes: { groups: ["a", "a", ""] } };
      const settings = { samlAttributeGroups: "groups" };
      const profileSnapshot = structuredClone(profile);
      const settingsSnapshot = structuredClone(settings);
      pickSamlGroups(profile, settings);
      expect(profile).toEqual(profileSnapshot);
      expect(settings).toEqual(settingsSnapshot);
    });
  });

  describe("Settings Repository Defaults", () => {
    it("mergeWithDefaults safely populates SAML defaults for existing installations", () => {
      const merged = mergeWithDefaults({ authMode: "password" });
      expect(merged.ssoType).toBe("oidc");
      expect(merged.samlIssuer).toBe(ACTIVE.samlIssuerDefault);
      expect(merged.samlLoginLabel).toBe("Sign in with SAML SSO");
      expect(merged.samlAttributeEmail).toBe("email");
      expect(merged.samlAttributeName).toBe("name");
    });
  });
});
