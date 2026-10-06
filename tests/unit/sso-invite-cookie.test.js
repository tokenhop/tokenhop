import { expect, it } from "vitest";
import { sealInviteState, openInviteState } from "@/lib/auth/oidc.js";
import { readSignedAuthToken } from "@/lib/auth/dashboardSession.js";

it("SSO invite cookie encrypts bearer token and rejects tampering or wrong flow", async () => {
  const token = "A".repeat(43);
  const sealed = await sealInviteState(token, "flow-1");
  expect(sealed.split(".")).toHaveLength(5); // JWE, not a session JWS
  expect(sealed).not.toContain(token);
  expect(await readSignedAuthToken(sealed)).toBeNull();
  expect(await openInviteState(sealed, "flow-1")).toBe(token);
  expect(await openInviteState(sealed, "flow-2")).toBeNull();
  const parts = sealed.split(".");
  parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  expect(await openInviteState(parts.join("."), "flow-1")).toBeNull();
});
