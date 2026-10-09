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

// UI guards: no connect request can start before the target is resolved.
import { readFileSync } from "node:fs";
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

it("gates API-key and bulk modals until target ready and confirmed", () => {
  const base = "src/app/(dashboard)/dashboard/providers/";
  const add = source(`${base}components/AddAccountDialog.js`);
  const flows = source(`${base}detail/AuthFlows.js`);
  expect(add).toContain("if (!target.ready) return null");
  expect(flows).toContain("isOpen={Boolean(show.addApiKey) && target.ready}");
  expect(flows).toContain("isOpen={authOpen(show.bulkCodex)}");
  expect(flows).toContain("isOpen={authOpen(show.bulkGrokCli)}");
  expect(source(`${base}[id]/BulkImportCodexModal.js`)).toContain(
    'withOAuthWorkspace("/api/oauth/codex/bulk-import", workspaceId)',
  );
  expect(source(`${base}[id]/BulkImportGrokCliModal.js`)).toContain(
    'withOAuthWorkspace("/api/oauth/grok-cli/bulk-import", workspaceId)',
  );
});
