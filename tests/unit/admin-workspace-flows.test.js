// YAN-373: workspace/invitation flows. Pure helpers plus source contracts for
// the one-time token and destructive confirmations (the node test env has no
// DOM, so interaction wiring is pinned from source, rendering via SSR harness).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("remove and revoke failures stay visible inside their open dialogs", () => {
  const members = read("workspaces/[id]/MembersPanel.js");
  const invitations = read("workspaces/[id]/InvitationsPanel.js");
  it("pass the failure to ConfirmDialog (role=alert inside the modal), not the panel error", () => {
    expect(members).toContain("error={removeError || undefined}");
    expect(members).toContain('setRemoveError(err?.message || "Could not remove member.")');
    expect(invitations).toContain("error={revokeError || undefined}");
    expect(invitations).toContain(
      'setRevokeError(err?.message || "Could not revoke the invitation.")',
    );
  });
  it("clear the dialog error on close and on reopen so a retry starts clean", () => {
    expect(members).toMatch(
      /closeRemove = \(\) => \{\s*setRemoving\(null\);\s*setRemoveError\(""\)/,
    );
    expect(invitations).toMatch(
      /closeRevoke = \(\) => \{\s*setRevoking\(null\);\s*setRevokeError\(""\)/,
    );
    expect(members).toMatch(/setRemoveError\(""\);\s*setRemoving\(member\)/);
    expect(invitations).toMatch(/setRevokeError\(""\);\s*setRevoking\(invitation\)/);
  });
  it("still escalate 403/404 to the page instead of showing a dialog error", () => {
    for (const src of [members, invitations]) {
      expect(src).toContain("[403, 404].includes(err?.status)) onTerminal(err)");
    }
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

describe("review fixes (PR #896)", () => {
  const members = read("workspaces/[id]/MembersPanel.js");
  const invitations = read("workspaces/[id]/InvitationsPanel.js");
  const users = read("users/page.js");
  const shared = read("components/AdminShared.js");

  it("remove member and revoke invitation surface failures instead of throwing", () => {
    // Both confirmations catch failures and preserve terminal status handling;
    // the dialog closes only on success and busy always resets.
    const remove = members.slice(members.indexOf("const confirmRemove"));
    expect(remove).toContain("await removeMember");
    expect(remove).toContain(
      "error={removeError || undefined}".replace("error=", "setRemoveError(").split("(")[0],
    );
    expect(remove).toContain("closeRemove()");
    expect(remove.indexOf("closeRemove()")).toBeLessThan(remove.indexOf("await reload()"));
    const revoke = invitations.slice(invitations.indexOf("const confirmRevoke"));
    expect(revoke).toContain("try {");
    expect(revoke).toContain("catch (err) {");
    expect(revoke).toContain('setRevokeError(err?.message || "Could not revoke the invitation.")');
    expect(revoke).toContain("finally {");
    expect(revoke.indexOf("closeRevoke()")).toBeLessThan(revoke.indexOf("catch (err)"));
  });

  it("users list drops stale responses by request id", () => {
    expect(users).toContain("useRef");
    expect(users).toContain("++reqId.current");
    expect(users.match(/reqId\.current !== mine/g).length).toBeGreaterThanOrEqual(2);
    expect(users).toContain("if (reqId.current === mine) setLoading(false)");
  });

  it("role and status pills render through translated labels", () => {
    expect(shared).not.toMatch(/role === "pending" \? "Pending approval"/);
    expect(shared).toContain("roleLabel(role)}");
    expect(shared).toContain('translate("Active")');
    expect(shared).toContain('translate("Disabled")');
    expect(shared).toContain('from "@/i18n/runtime"');
  });
});

describe("panel confirm handlers (PR #896 failure paths)", () => {
  // Execute the actual source handlers with state/API spies, without a DOM or
  // copied implementation that could diverge from the component.
  for (const [file, name, mutation, dialog, close, end] of [
    ["MembersPanel.js", "confirmRemove", "removeMember", "removing", "setRemoving", "removeButton"],
    [
      "InvitationsPanel.js",
      "confirmRevoke",
      "revokeInvitation",
      "revoking",
      "setRevoking",
      "revokeButton",
    ],
  ]) {
    it(`${name}: errors surface, no rejection escapes, dialog stays open`, async () => {
      const source = read(`workspaces/[id]/${file}`);
      const closer = name === "confirmRemove" ? "closeRemove" : "closeRevoke";
      const handler = source.slice(
        source.indexOf(`const ${closer}`),
        source.indexOf(`const ${end}`),
      );
      const fail = source.slice(source.indexOf("const fail"), source.indexOf("const reload"));
      const setError = vi.fn();
      const setBusy = vi.fn();
      const onTerminal = vi.fn();
      const setDialog = vi.fn();
      const setDialogError = vi.fn();
      const reload = vi.fn();
      const api = vi.fn();
      const dialogErrorSetter = name === "confirmRemove" ? "setRemoveError" : "setRevokeError";
      const confirm = new Function(
        "useCallback",
        "onTerminal",
        "setError",
        "setBusy",
        "reload",
        "workspaceId",
        mutation,
        dialog,
        dialogErrorSetter,
        close,
        `${fail}\n${handler}\nreturn ${name};`,
      )(
        (fn) => fn,
        onTerminal,
        setError,
        setBusy,
        reload,
        "ws",
        api,
        { id: "i", userId: "u" },
        setDialogError,
        setDialog,
      );
      for (const err of [new Error("Network failed"), { status: 403 }, { status: 404 }]) {
        api.mockRejectedValueOnce(err);
        await expect(confirm()).resolves.toBeUndefined();
        if (err.status) expect(onTerminal).toHaveBeenLastCalledWith(err);
        else expect(setDialogError).toHaveBeenLastCalledWith("Network failed");
        expect(setDialogError).toHaveBeenNthCalledWith(1, "");
        expect(setBusy).toHaveBeenLastCalledWith(false);
      }
      expect(setDialog).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      api.mockResolvedValueOnce({ success: true });
      await expect(confirm()).resolves.toBeUndefined();
      expect(setDialog).toHaveBeenCalledWith(null);
      expect(reload).toHaveBeenCalledTimes(1);
    });
  }
});
