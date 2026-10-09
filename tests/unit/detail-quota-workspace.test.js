import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { visibleGroups, visibleItems } from "@/shared/constants/navigation.js";
import { withWorkspace } from "../../src/app/(dashboard)/dashboard/providers/connectTarget.js";

const src = (rel) => readFileSync(resolve(__dirname, "../../src", rel), "utf8");

const useConnectionsSrc = src("app/(dashboard)/dashboard/providers/detail/useConnections.js");
const useQuotaDataSrc = src("app/(dashboard)/dashboard/quota/hooks/useQuotaData.js");
const connectionsSectionSrc = src(
  "app/(dashboard)/dashboard/providers/detail/ConnectionsSection.js",
);
const sortableRowSrc = src("app/(dashboard)/dashboard/providers/detail/SortableConnectionRow.js");

describe("useConnections workspace scoping (YAN-376)", () => {
  it("derives ready + scope from useSettingsScope", () => {
    expect(useConnectionsSrc).toMatch(
      /const\s*\{\s*ready,\s*scope\s*\}\s*=\s*useSettingsScope\(\)/,
    );
  });

  it("guards fetchConnections until the scope is ready", () => {
    expect(useConnectionsSrc).toMatch(/if\s*\(!ready\)\s*return;/);
  });

  it("fetches the provider list through withWorkspace using the scoped workspaceId", () => {
    expect(useConnectionsSrc).toContain('withWorkspace("/api/providers", scope?.workspaceId)');
  });

  it("re-fetches when ready or the workspace changes", () => {
    expect(useConnectionsSrc).toMatch(/\[\s*providerId,\s*ready,\s*scope\?\.workspaceId\s*\]/);
  });
});

describe("useQuotaData workspace scoping (YAN-376)", () => {
  it("derives ready + scope from useSettingsScope", () => {
    expect(useQuotaDataSrc).toMatch(/const\s*\{\s*ready,\s*scope\s*\}\s*=\s*useSettingsScope\(\)/);
  });

  it("adds workspaceId to the connections query only when scoped", () => {
    expect(useQuotaDataSrc).toContain(
      'if (scope?.workspaceId) params.set("workspaceId", scope.workspaceId);',
    );
  });

  it("guards fetchConnections until ready and returns null for callers", () => {
    expect(useQuotaDataSrc).toMatch(/if\s*\(!ready\)\s*return\s+null;/);
  });

  it("guards the initial load effect until ready", () => {
    expect(useQuotaDataSrc).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(!ready\)\s*return\s+undefined;/,
    );
  });

  it("re-runs fetches when ready or the workspace changes", () => {
    expect(useQuotaDataSrc).toMatch(/ready,\s*scope\?\.workspaceId\]/);
  });
});

describe("connection sharing refresh wiring (YAN-376)", () => {
  it("ConnectionsSection passes conn.fetchConnections as onShared to every row", () => {
    expect(connectionsSectionSrc).toContain("onShared={conn.fetchConnections}");
  });

  it("SortableConnectionRow mounts ConnectionSharing with the connection and onShared", () => {
    expect(sortableRowSrc).toContain(
      "<ConnectionSharing connection={connection} onShared={onShared} />",
    );
    expect(sortableRowSrc).toMatch(
      /import ConnectionSharing from "\.\.\/components\/ConnectionSharing";/,
    );
  });
});

describe("audit nav item gating (YAN-376)", () => {
  const auditVisible = (settings) => visibleItems(settings).some((item) => item.id === "audit");

  it("declares the audit item with the multiUser gate and either audit.read capability", () => {
    const audit = visibleGroups({ multiUser: true, can: () => true })
      .flatMap((group) => group.items)
      .find((item) => item.id === "audit");
    expect(audit).toMatchObject({
      href: "/dashboard/audit",
      gate: "multiUser",
      capAny: ["instance.audit.read", "workspace.audit.read"],
    });
  });

  it("hides the audit item when multiUser is off, even with every capability", () => {
    expect(auditVisible({ multiUser: false, can: () => true })).toBe(false);
    expect(auditVisible({ can: () => true })).toBe(false);
  });

  it("shows the audit item with instance.audit.read", () => {
    expect(auditVisible({ multiUser: true, can: (cap) => cap === "instance.audit.read" })).toBe(
      true,
    );
  });

  it("shows the audit item with workspace.audit.read", () => {
    expect(auditVisible({ multiUser: true, can: (cap) => cap === "workspace.audit.read" })).toBe(
      true,
    );
  });

  it("hides the audit item when the principal has neither audit.read capability", () => {
    expect(auditVisible({ multiUser: true, can: () => false })).toBe(false);
    expect(auditVisible({ multiUser: true, can: (cap) => cap === "instance.hostOps" })).toBe(false);
  });

  it("shows the audit item in single-user mode when no capability check runs", () => {
    // No `can` (single-user): the gate alone controls visibility.
    expect(auditVisible({ multiUser: true })).toBe(true);
  });
});

describe("withWorkspace helper", () => {
  it("keeps the URL unchanged when no workspace is targeted", () => {
    expect(withWorkspace("/api/providers", null)).toBe("/api/providers");
    expect(withWorkspace("/api/providers", undefined)).toBe("/api/providers");
    expect(withWorkspace("/api/providers", "")).toBe("/api/providers");
  });

  it("appends workspaceId with the correct separator and encoding", () => {
    expect(withWorkspace("/api/providers", "ws-1")).toBe("/api/providers?workspaceId=ws-1");
    expect(withWorkspace("/api/providers?isActive=true", "ws 2")).toBe(
      "/api/providers?isActive=true&workspaceId=ws%202",
    );
  });
});
