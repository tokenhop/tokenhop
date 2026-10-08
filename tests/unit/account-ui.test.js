// YAN-371: pure account UI helpers. Pins role-aware nav, the settings tiers,
// save routing, and the single-user regression (inactive = legacy output).
import { describe, expect, it } from "vitest";
import { accountView, toCapabilityPrincipal } from "@/shared/utils/account";
import { visibleGroups } from "@/shared/constants/navigation";
import { resolveUserRow } from "@/shared/utils/shell";
import { describeLoginError } from "@/app/login/loginErrors";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "@/app/(dashboard)/dashboard/settings/registry";
import { layoutFor } from "@/app/(dashboard)/dashboard/settings/settingsTiers";
import { settingsEndpoint } from "@/shared/utils/settingsApi";

const ADMIN_ONLY = ["console-log", "token-saver", "cli-tools", "proxy-pools", "translator"];

function status(role, wsRole = "owner") {
  return {
    multiUserActive: true,
    loginMethod: "Password",
    principal: {
      user: { id: "u1", email: "a@x.test", username: "a", displayName: "Ann Lee" },
      role,
      via: "session",
      activeWorkspaceId: "ws-p",
      workspaces: [
        { id: "ws-s", name: "Home", kind: "shared", role: "member" },
        { id: "ws-p", name: "Ann", kind: "personal", role: wsRole },
      ],
    },
  };
}

const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id));

describe("capability adapter", () => {
  it("maps the status principal to can()'s shape", () => {
    expect(toCapabilityPrincipal(status("user").principal)).toEqual({
      instanceRole: "user",
      workspaceIds: ["ws-s", "ws-p"],
      workspaceRoles: { "ws-s": "member", "ws-p": "owner" },
      activeWorkspaceId: "ws-p",
    });
  });

  it("a user has no instance caps; workspace caps follow the workspace role", () => {
    const view = accountView(status("user"));
    expect(view.can("instance.hostOps")).toBe(false);
    expect(view.can("instance.settings.manage")).toBe(false);
    expect(view.can("workspace.preferences.manage")).toBe(true);
    expect(view.can("workspace.preferences.manage", "ws-s")).toBe(false);
    expect(view.can("workspace.preferences.manage", "ws-other")).toBe(false);
  });

  it("orders personal first and picks the active workspace", () => {
    const view = accountView(status("admin"));
    expect(view.workspaces.map((w) => w.id)).toEqual(["ws-p", "ws-s"]);
    expect(view.activeWorkspace.id).toBe("ws-p");
    expect(view).toMatchObject({ name: "Ann Lee", roleLabel: "Admin", loginMethod: "Password" });
  });
});

describe("role-aware nav", () => {
  const base = { enableTranslator: true, multiUser: true };

  it("hides instance-only items from a user, shows them to an admin", () => {
    const user = ids(visibleGroups({ ...base, can: accountView(status("user")).can }));
    for (const id of ADMIN_ONLY) expect(user).not.toContain(id);
    const admin = ids(visibleGroups({ ...base, can: accountView(status("admin")).can }));
    for (const id of ADMIN_ONLY) expect(admin).toContain(id);
  });
});

describe("single-user regression (inactive)", () => {
  const inactive = [{}, { multiUserActive: false, principal: status("owner").principal }];

  it("accountView is inactive with no can()", () => {
    for (const s of inactive) expect(accountView(s)).toEqual({ active: false });
  });

  it("nav without can is identical to the legacy output", () => {
    for (const settings of [{}, { enableTranslator: true }, { multiUser: true }]) {
      expect(visibleGroups({ ...settings, can: undefined })).toEqual(visibleGroups(settings));
    }
    expect(ids(visibleGroups({ enableTranslator: true }))).toEqual(
      expect.arrayContaining(ADMIN_ONLY),
    );
  });

  it("settings layout is the legacy registry", () => {
    const layout = layoutFor({ active: false });
    expect(layout.groups).toBe(SETTINGS_GROUPS);
    expect(layout.sections).toBe(SETTINGS_SECTIONS);
    expect(layout.canManageInstance).toBe(true);
  });

  it("every save goes to /api/settings", () => {
    for (const key of ["fallbackStrategy", "startPage", "authMode", "lastWorkspaceId"]) {
      expect(settingsEndpoint(key, null)).toBe("/api/settings");
    }
  });

  it("the sidebar user row is unchanged", () => {
    expect(resolveUserRow({ oidcName: "Sam", loginMethod: "OIDC" })).toEqual({
      name: "Sam",
      sub: "SSO",
    });
    expect(resolveUserRow({})).toEqual({ name: "Admin", sub: "Password" });
  });
});

describe("active settings", () => {
  it("a user sees My account and Workspace only; an admin also sees Instance", () => {
    const user = layoutFor(accountView(status("user")));
    expect(user.groups.map((g) => g.id)).toEqual(["account", "workspace"]);
    expect(user.canManageInstance).toBe(false);
    expect(user.sections.map((s) => s.id)).not.toContain("security");
    const admin = layoutFor(accountView(status("admin")));
    expect(admin.groups.map((g) => g.id)).toEqual(["account", "workspace", "instance"]);
    expect(admin.sections[0].id).toBe("account");
  });

  it("routes saves by key tier", () => {
    const scope = { workspaceId: "ws/1" };
    expect(settingsEndpoint("fallbackStrategy", scope)).toBe("/api/workspaces/ws%2F1/settings");
    expect(settingsEndpoint("uiDensity", scope)).toBe("/api/me/preferences");
    expect(settingsEndpoint("authMode", scope)).toBe("/api/settings");
  });

  it("the sidebar user row shows the user and role", () => {
    expect(resolveUserRow(status("user"))).toEqual({ name: "Ann Lee", sub: "User" });
  });
});

it("maps ownership_reauth_failed to its own message", () => {
  expect(describeLoginError("ownership_reauth_failed")).toMatch(/owner account/);
});
