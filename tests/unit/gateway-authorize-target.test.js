// YAN-1106: authorizeGatewayTarget only admits a null (legacy) principal or a real
// gateway principal. A principal-shaped object that carries scopes but no usable
// workspaceId is refused with 403 for every target kind, so an edge admission
// verdict or a hand-built object can never read as "unrestricted".
import { describe, expect, it } from "vitest";
import { authorizeGatewayTarget } from "@/lib/auth/gatewayAuth.js";

const scopes = Object.freeze({ allowedModels: [], allowedCombos: [] });
const withWorkspace = Object.freeze({ workspaceId: "w1", scopes });

describe("authorizeGatewayTarget workspace requirement", () => {
  it.each([
    ["missing", { scopes }],
    ["null", { workspaceId: null, scopes }],
    ["empty string", { workspaceId: "", scopes }],
    ["non-string", { workspaceId: 7, scopes }],
    ["object", { workspaceId: {}, scopes }],
  ])("%s workspaceId with open scopes is 403 for model and combo", (_name, principal) => {
    for (const target of [{ modelId: "any/model" }, { comboId: "any-combo" }, {}]) {
      const denied = authorizeGatewayTarget(principal, target);
      expect(denied).toBeInstanceOf(Response);
      expect(denied.status).toBe(403);
    }
  });

  it("no scopes at all is 403 even with a workspaceId", () => {
    expect(authorizeGatewayTarget({ workspaceId: "w1" }, { modelId: "m" })?.status).toBe(403);
  });

  it("an edge admission verdict is 403", () => {
    const verdict = Object.freeze({ verified: true, apiKeyId: "k" });
    expect(authorizeGatewayTarget(verdict, { modelId: "m" })?.status).toBe(403);
  });

  it("a null principal (legacy path) stays allowed", () => {
    expect(authorizeGatewayTarget(null, { modelId: "m" })).toBeNull();
    expect(authorizeGatewayTarget(undefined, { comboId: "c" })).toBeNull();
  });

  it("a workspace principal with open scopes is allowed; pinned scopes still bind", () => {
    expect(authorizeGatewayTarget(withWorkspace, { modelId: "any/model" })).toBeNull();
    const pinned = Object.freeze({
      workspaceId: "w1",
      scopes: { allowedModels: ["a/b"], allowedCombos: ["c1"] },
    });
    expect(authorizeGatewayTarget(pinned, { modelId: "a/b" })).toBeNull();
    expect(authorizeGatewayTarget(pinned, { modelId: "x/y" })?.status).toBe(403);
    expect(authorizeGatewayTarget(pinned, { comboId: "c1" })).toBeNull();
    expect(authorizeGatewayTarget(pinned, { comboId: "c2" })?.status).toBe(403);
  });
});
