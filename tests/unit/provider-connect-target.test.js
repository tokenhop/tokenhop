import { describe, expect, it } from "vitest";
import {
  defaultTarget,
  manageableWorkspaces,
  withWorkspace,
} from "@/app/(dashboard)/dashboard/providers/connectTarget";

const view = {
  active: true,
  activeWorkspace: { id: "team" },
  workspaces: [
    { id: "mine", name: "Mine" },
    { id: "team", name: "Team" },
    { id: "ro", name: "Read only" },
  ],
  can: (cap, id) => cap === "workspace.connections.manage" && id !== "ro",
};

describe("connect target", () => {
  it("lists only manageable workspaces and prefers the active one", () => {
    expect(manageableWorkspaces(view).map((w) => w.id)).toEqual(["mine", "team"]);
    expect(defaultTarget(view)).toBe("team");
    expect(defaultTarget({ ...view, activeWorkspace: { id: "ro" } })).toBe("mine");
  });

  it("keeps legacy URLs when multi-user is off", () => {
    expect(manageableWorkspaces({ active: false })).toEqual([]);
    expect(defaultTarget({ active: false })).toBeNull();
    expect(withWorkspace("/api/providers", null)).toBe("/api/providers");
  });

  it("appends an encoded workspace id", () => {
    expect(withWorkspace("/api/providers", "a b")).toBe("/api/providers?workspaceId=a%20b");
    expect(withWorkspace("/api/oauth/x/start?mode=1", "w")).toBe(
      "/api/oauth/x/start?mode=1&workspaceId=w",
    );
  });
});
