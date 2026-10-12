// YAN-373: workspace/invitation flows. Pure helpers plus source contracts for
// the one-time token and destructive confirmations (the node test env has no
// DOM, so interaction wiring is pinned from source, rendering via SSR harness).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inviteLink,
  pickerLabel,
  readonlyReason,
  workspaceRoleLabel,
} from "@/app/(dashboard)/dashboard/admin/workspaces/[id]/workspaceView.js";

const root = resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/admin");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

describe("workspace helpers", () => {
  it("invite link keeps the token in the hash, never the query", () => {
    const link = inviteLink("a-B_9", "https://hop.test");
    expect(link).toBe("https://hop.test/invite#token=a-B_9");
    expect(new URL(link).search).toBe("");
  });
  it("explains read-only rows without deciding authorization", () => {
    expect(readonlyReason({ source: "idp", role: "member" })).toBe("idp");
    expect(readonlyReason({ source: "manual", role: "owner" })).toBe("owner");
    expect(readonlyReason({ source: "manual", role: "member" })).toBeNull();
  });
  it("labels roles and picker rows", () => {
    expect(workspaceRoleLabel("manager")).toBe("Manager");
    expect(workspaceRoleLabel("owner")).toBe("Owner");
    expect(pickerLabel({ displayName: "Ann", email: "a@x.test", status: "disabled" })).toBe(
      "Ann — a@x.test (disabled)",
    );
  });
});

describe("one-time invitation token", () => {
  const panel = read("workspaces/[id]/InvitationsPanel.js");
  it("lives in component state only: no storage, no console, no URL writes", () => {
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "history.replaceState",
      "document.cookie",
    ]) {
      expect(panel, `${forbidden} must not appear`).not.toContain(`${forbidden}`);
    }
    expect(panel).toContain('setLink("")'); // dismiss drops it
    expect(panel).toContain("won&apos;t be shown again");
  });
  it("lists invitations from the metadata endpoint, which carries no token", () => {
    expect(panel).toContain("listInvitations(workspaceId)");
    expect(panel).not.toMatch(/invitation\.token/);
  });
});

describe("destructive actions confirm first", () => {
  it("revoke invitation, remove member, delete user and sign-out-everywhere use ConfirmDialog", () => {
    expect(read("workspaces/[id]/InvitationsPanel.js")).toContain("<ConfirmDialog");
    expect(read("workspaces/[id]/MembersPanel.js")).toContain("<ConfirmDialog");
    const detail = read("users/[id]/page.js");
    expect(detail).toContain('dialog === "delete"');
    expect(detail).toContain('dialog === "signout"');
    expect((detail.match(/<ConfirmDialog/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(detail).toMatch(/personal workspace/i); // cascade explained
  });
  it("owner transfer requires the current password before enabling submit", () => {
    expect(read("components/UserDialogs.js")).toMatch(/disabled=\{!password\}/);
  });
});

describe("detail 404 means the item is gone, not that Users & teams is off", () => {
  const user = read("users/[id]/page.js");
  const workspace = read("workspaces/[id]/page.js");
  it("both detail pages map 404 to the gone state and 403 to denied", () => {
    for (const src of [user, workspace]) {
      expect(src).toMatch(/status === 404\??\)? setLoadState\("gone"\)/);
      expect(src).toMatch(/status === 403\) setLoadState\("denied"\)/);
    }
  });
  it("each gone state links back to its parent list", () => {
    expect(user).toContain('href="/dashboard/admin/users"');
    expect(user).toContain("This user no longer exists");
    expect(workspace).toContain('href="/dashboard/admin/workspaces"');
    expect(workspace).toContain("This workspace no longer exists");
  });
});

describe("file size budget", () => {
  it("keeps every admin and invite file at or below 500 lines", () => {
    const files = [
      "users/page.js",
      "users/[id]/page.js",
      "workspaces/page.js",
      "workspaces/[id]/page.js",
      "workspaces/[id]/MembersPanel.js",
      "workspaces/[id]/InvitationsPanel.js",
      "provisioning/page.js",
      "components/AdminShared.js",
      "components/UserDialogs.js",
    ];
    for (const f of files) expect(read(f).split("\n").length, f).toBeLessThanOrEqual(500);
  });
});
