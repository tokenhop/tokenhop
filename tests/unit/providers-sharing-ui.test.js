import { describe, expect, it } from "vitest";
import {
  buildSharePayload,
  filterIncomingGrants,
  memberGranteeOptions,
  parseRateLimit,
  shareableWorkspaceOptions,
} from "@/app/(dashboard)/dashboard/providers/sharing";

describe("filterIncomingGrants", () => {
  it("keeps grants to the active workspace or the caller, deduped", () => {
    const grants = [
      { grantId: "a", granteeWorkspaceId: "ws1" },
      { grantId: "b", granteeWorkspaceId: "ws2" },
      { grantId: "c", granteeUserId: "me" },
      { grantId: "c", granteeUserId: "me" },
      { grantId: "d", granteeUserId: "bob" },
    ];
    const ids = filterIncomingGrants(grants, { activeWorkspaceId: "ws1", userId: "me" }).map(
      (g) => g.grantId,
    );
    expect(ids).toEqual(["a", "c"]);
    expect(filterIncomingGrants(null, {})).toEqual([]);
  });
});

describe("grantee options", () => {
  it("offers only shared workspaces the caller owns or manages", () => {
    const opts = shareableWorkspaceOptions([
      { id: "p", name: "Mine", kind: "personal", role: "owner" },
      { id: "s1", name: "Team", kind: "shared", role: "manager" },
      { id: "s2", name: "Other", kind: "shared", role: "member" },
    ]);
    expect(opts).toEqual([{ value: "s1", label: "Team" }]);
  });

  it("lists members except the caller, by display name", () => {
    expect(
      memberGranteeOptions(
        [
          { userId: "me", displayName: "Me" },
          { userId: "u2", displayName: "Ann" },
          { userId: "u3", displayName: null },
        ],
        { excludeUserId: "me" },
      ),
    ).toEqual([
      { value: "u2", label: "Ann" },
      { value: "u3", label: "u3" },
    ]);
  });
});

describe("buildSharePayload", () => {
  const shareable = { provider: "openai", sharing: "shareable" };
  const personal = { provider: "claude", sharing: "personal" };

  it("builds a workspace grant with limits and model scope", () => {
    const { payload, errors } = buildSharePayload({
      granteeType: "workspace",
      workspaceId: "s1",
      modelsText: "openai/gpt-5",
      rpm: "60",
      tpm: "",
      connection: shareable,
    });
    expect(errors).toEqual([]);
    expect(payload).toEqual({
      workspaceId: "s1",
      rpm: 60,
      tpm: null,
      allowedModels: ["openai/gpt-5"],
    });
  });

  it("adds the exact terms acknowledgement for personal connections", () => {
    const { payload } = buildSharePayload({
      granteeType: "user",
      userId: "u2",
      connection: personal,
    });
    expect(payload.tosAcknowledged).toEqual({ providerId: "claude", sharing: "personal" });
    expect(payload.userId).toBe("u2");
    expect(payload).not.toHaveProperty("workspaceId");
  });

  it("rejects a missing grantee and bad limits", () => {
    const { payload, errors } = buildSharePayload({
      granteeType: "workspace",
      rpm: "0",
      connection: shareable,
    });
    expect(payload).toBeNull();
    expect(errors).toHaveLength(2);
    expect(parseRateLimit("1.5").error).toBeTruthy();
  });
});
