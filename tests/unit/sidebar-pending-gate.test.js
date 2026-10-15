// YAN-1159: the shell must not poll /api/users for pending approvals unless
// an authenticated admin/owner can manage instance users. The gate reads the
// auth principal directly (not accountView): multiUserActive is false until a
// second user is ACTIVE, so an owner with only pending users still holds the
// badge — an absent/failed or non-admin principal never polls.
import { describe, expect, it } from "vitest";
import { canPollPendingUsers } from "@/shared/hooks/usePendingUsers.js";

const statusFor = (role, workspaceRole = "member") => ({
  multiUserActive: true,
  principal: {
    user: { id: "u1" },
    role,
    activeWorkspaceId: "w1",
    workspaces: [{ id: "w1", name: "W", kind: "shared", role: workspaceRole }],
  },
});

describe("canPollPendingUsers", () => {
  it("polls for an authenticated instance owner/admin on a multi-user install", () => {
    for (const role of ["owner", "admin"]) {
      expect(canPollPendingUsers(statusFor(role, "manager"), true, true)).toBe(true);
    }
  });
  it("still polls for the single active owner whose other users are pending (multiUserActive false)", () => {
    const status = { ...statusFor("owner", "owner"), multiUserActive: false };
    expect(canPollPendingUsers(status, true, true)).toBe(true);
  });
  it("does not poll for member or viewer principals", () => {
    for (const workspaceRole of ["member", "viewer"]) {
      const status = { ...statusFor("user", workspaceRole) };
      expect(canPollPendingUsers(status, true, true)).toBe(false);
    }
  });
  it("does not poll when the auth request has not loaded yet", () => {
    expect(canPollPendingUsers(statusFor("owner", "owner"), false, true)).toBe(false);
  });
  it("never polls on an absent or failed principal, even once loaded", () => {
    for (const status of [{}, { principal: null }, { principal: {} }, null]) {
      expect(canPollPendingUsers(status, true, true)).toBe(false);
    }
  });
  it("does not poll when the shell reports multiUser off", () => {
    expect(canPollPendingUsers(statusFor("owner", "owner"), true, false)).toBe(false);
  });
});
