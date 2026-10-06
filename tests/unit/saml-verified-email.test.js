import { expect, it } from "vitest";
import { pickVerifiedSamlEmail } from "@/lib/auth/saml.js";

const EMAIL_FMT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

it("trusts explicit email claims and emailAddress-format NameID, never other fallbacks", () => {
  expect(pickVerifiedSamlEmail({ email: "a@x.io", nameID: "id-1" })).toBe("a@x.io");
  expect(pickVerifiedSamlEmail({ nameID: "a@x.io", nameIDFormat: EMAIL_FMT })).toBe("a@x.io");
  expect(pickVerifiedSamlEmail({ nameID: "a@x.io", nameIDFormat: PERSISTENT })).toBeNull();
  expect(pickVerifiedSamlEmail({ nameID: "not-an-email", nameIDFormat: EMAIL_FMT })).toBeNull();
  expect(pickVerifiedSamlEmail({ upn: "a@x.io" })).toBeNull();
  // A present but non-email configured attribute fails closed.
  expect(
    pickVerifiedSamlEmail({ corp: "nope", email: "a@x.io" }, { samlAttributeEmail: "corp" }),
  ).toBeNull();
});
