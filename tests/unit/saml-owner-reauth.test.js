import zlib from "node:zlib";
import { parseXml2JsFromString } from "@node-saml/node-saml/lib/xml.js";
import { describe, expect, it } from "vitest";
import {
  buildSamlAuthorizeUrl,
  buildSamlReauthAuthorizeUrl,
  verifyFreshSamlAuthnInstant,
} from "../../src/lib/auth/saml.js";

const settings = {
  samlEntryPoint: "https://idp.example.com/sso",
  samlCert: "MIIC1234567890123456789012345678901234567890",
  baseUrl: "https://app.example.com",
};

const decodeRequest = (url) =>
  zlib
    .inflateRawSync(Buffer.from(new URL(url).searchParams.get("SAMLRequest"), "base64"))
    .toString("utf8");

// Same representation node-saml hands to profile.getAssertion() (real parse, not a hand-built shape).
const profileFromXml = async (inner) => {
  const doc = await parseXml2JsFromString(
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${inner}</saml:Assertion>`,
  );
  return { getAssertion: () => doc };
};
const stmt = (instant) => `<saml:AuthnStatement AuthnInstant="${instant}"/>`;

describe("SAML fresh ownership reauth", () => {
  it("reauth request sets ForceAuthn=true and returns requestId", async () => {
    const { authorizeUrl, requestId } = await buildSamlReauthAuthorizeUrl(null, settings);
    const xml = decodeRequest(authorizeUrl);
    expect(xml).toMatch(/ForceAuthn="true"/);
    expect(requestId).toBeTruthy();
    expect(xml).toContain(`ID="${requestId}"`);
  });

  it("regular login request has no ForceAuthn", async () => {
    const { authorizeUrl } = await buildSamlAuthorizeUrl(null, settings);
    expect(decodeRequest(authorizeUrl)).not.toMatch(/ForceAuthn/);
  });

  describe("verifyFreshSamlAuthnInstant", () => {
    const startedAt = Date.parse("2026-10-06T12:00:00Z");
    const now = startedAt + 30_000;
    const verify = (profile) => verifyFreshSamlAuthnInstant(profile, { startedAt, now });

    it("accepts fresh AuthnInstant and returns epoch ms", async () => {
      const { authnInstant } = verify(await profileFromXml(stmt("2026-10-06T12:00:10Z")));
      expect(authnInstant).toBe(Date.parse("2026-10-06T12:00:10Z"));
    });

    it("accepts within 60s skew on both edges", async () => {
      const early = await profileFromXml(stmt("2026-10-06T11:59:00Z"));
      const late = await profileFromXml(stmt("2026-10-06T12:01:30Z"));
      expect(() => verify(early)).not.toThrow();
      expect(() => verify(late)).not.toThrow();
    });

    it("rejects stale AuthnInstant", async () => {
      await expect(async () =>
        verify(await profileFromXml(stmt("2026-10-06T11:58:59Z"))),
      ).rejects.toThrow(/freshness window/);
    });

    it("rejects future AuthnInstant beyond skew", async () => {
      await expect(async () =>
        verify(await profileFromXml(stmt("2026-10-06T12:01:31Z"))),
      ).rejects.toThrow(/freshness window/);
    });

    it("rejects missing AuthnStatement", async () => {
      const profile = await profileFromXml("");
      expect(() => verify(profile)).toThrow(/missing/);
    });

    it("rejects missing, empty or malformed AuthnInstant", async () => {
      for (const inner of [
        "<saml:AuthnStatement/>",
        stmt(""),
        stmt("not-a-date"),
        stmt("2026"),
        stmt("2026-10-06T12:00:10"), // no timezone
        stmt("2026-13-45T99:00:10Z"),
      ]) {
        const profile = await profileFromXml(inner);
        expect(() => verify(profile)).toThrow(/invalid/);
      }
    });

    it("rejects duplicate AuthnStatements even if one is fresh", async () => {
      const inner = stmt("2026-10-06T12:00:10Z") + stmt("2026-10-06T12:00:11Z");
      const profile = await profileFromXml(inner);
      expect(() => verify(profile)).toThrow(/ambiguous/);
    });

    it("rejects profile without getAssertion or with empty assertion", () => {
      expect(() => verify({})).toThrow(/unavailable/);
      expect(() => verify(null)).toThrow(/unavailable/);
      expect(() => verify({ getAssertion: () => ({}) })).toThrow(/missing/);
    });
  });
});
