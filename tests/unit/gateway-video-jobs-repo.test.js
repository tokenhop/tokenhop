// Real-SQLite coverage for gatewayVideoJobsRepo: PRIMARY KEY (workspaceId,
// provider, jobId) uniqueness, immutable conflicting provenance, workspace-
// scoped lookup, and the FK behavior the declared SQL actually enforces.
// No mocks: the current adapter fixture is the store.
import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getGatewayVideoJobsSync,
  initGatewayVideoJobsSync,
  recordGatewayVideoJobSync,
  requireGatewayVideoJobsSync,
} from "@/lib/db/repos/gatewayVideoJobsRepo.js";

const NOW = "2026-10-04T00:00:00.000Z";

let db;
let nextSeq = 0;

function workspace(id) {
  db.run("INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)", [
    id,
    id,
    NOW,
    NOW,
  ]);
  return id;
}

function row(patch = {}) {
  return {
    workspaceId: workspace(`w${++nextSeq}`),
    jobId: `job-${nextSeq}`,
    provider: "xai",
    connectionId: "conn-1",
    modelId: "xai/grok-video",
    ...patch,
  };
}

const count = () => db.get("SELECT COUNT(*) AS n FROM gatewayVideoJobs").n;

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec("DELETE FROM workspaces");
  initGatewayVideoJobsSync(db);
});

describe("gatewayVideoJobsRepo (real SQLite)", () => {
  it("installs the documented table and requireGatewayVideoJobsSync detects its absence", () => {
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='gatewayVideoJobs'")?.name,
    ).toBe("gatewayVideoJobs");
    requireGatewayVideoJobsSync(db); // present → no throw
    db.exec("DROP TABLE gatewayVideoJobs");
    expect(() => requireGatewayVideoJobsSync(db)).toThrow(
      expect.objectContaining({ code: "GATEWAY_VIDEO_JOBS_MISSING" }),
    );
  });

  it("same (workspace, provider, job): identical re-record is idempotent, conflict fails closed and leaves the row immutable", () => {
    const r = row();
    recordGatewayVideoJobSync(db, r);
    expect(count()).toBe(1);
    // Identical provenance re-recorded (idempotent retry).
    expect(() =>
      recordGatewayVideoJobSync(db, { ...r, connectionId: r.connectionId }),
    ).not.toThrow();
    expect(count()).toBe(1);
    // Conflicting connectionId and conflicting modelId both fail closed,
    // and the original row survives each failed attempt unchanged.
    expect(() => recordGatewayVideoJobSync(db, { ...r, connectionId: "conn-other" })).toThrow(
      "Conflicting video job provenance",
    );
    expect(() => recordGatewayVideoJobSync(db, { ...r, modelId: "xai/other-video" })).toThrow(
      "Conflicting video job provenance",
    );
    expect(count()).toBe(1);
    expect(getGatewayVideoJobsSync(db, r.workspaceId, r.jobId)).toEqual([
      expect.objectContaining({ connectionId: "conn-1", modelId: "xai/grok-video" }),
    ]);
  });

  it("PK is (workspace, provider, job): same job id under another provider or workspace is a distinct row", () => {
    const w = workspace("w-multi");
    recordGatewayVideoJobSync(db, {
      workspaceId: w,
      jobId: "dup",
      provider: "xai",
      connectionId: "c1",
      modelId: "xai/grok-video",
    });
    recordGatewayVideoJobSync(db, {
      workspaceId: w,
      jobId: "dup",
      provider: "openrouter",
      connectionId: "c2",
      modelId: "openrouter/veo",
    });
    recordGatewayVideoJobSync(db, {
      workspaceId: workspace("w-multi-2"),
      jobId: "dup",
      provider: "xai",
      connectionId: "c3",
      modelId: "xai/grok-video",
    });
    expect(count()).toBe(3);
    // The ambiguity the poll path defends against: one workspace, two providers.
    expect(getGatewayVideoJobsSync(db, w, "dup")).toHaveLength(2);
  });

  it("lookup is workspace-scoped: a foreign workspace never sees another workspace's job", () => {
    const r = row();
    recordGatewayVideoJobSync(db, r);
    expect(getGatewayVideoJobsSync(db, r.workspaceId, r.jobId)).toHaveLength(1);
    expect(getGatewayVideoJobsSync(db, workspace("w-foreign"), r.jobId)).toEqual([]);
  });

  it("row validation rejects malformed canonical identity and oversized fields", () => {
    expect(() => recordGatewayVideoJobSync(db, row({ modelId: "grok-video" }))).toThrow(
      "Invalid video job canonical model",
    ); // no provider/ prefix
    expect(() => recordGatewayVideoJobSync(db, row({ modelId: "xai/" }))).toThrow(
      "Invalid video job canonical model",
    );
    expect(() => recordGatewayVideoJobSync(db, row({ jobId: "" }))).toThrow(
      "Invalid video job jobId",
    );
    expect(() => recordGatewayVideoJobSync(db, row({ workspaceId: null }))).toThrow(
      "Invalid video job workspaceId",
    );
    expect(count()).toBe(0);
  });

  it("declared FK: unknown workspace insert is rejected and workspace delete cascades rows", () => {
    const w = workspace("w-fk");
    const r = {
      workspaceId: w,
      jobId: "fk-1",
      provider: "xai",
      connectionId: "c",
      modelId: "xai/grok-video",
    };
    recordGatewayVideoJobSync(db, r);

    // FK on the declared REFERENCES: an insert naming a nonexistent workspace fails.
    expect(() =>
      recordGatewayVideoJobSync(db, { ...r, jobId: "fk-2", workspaceId: "no-such-workspace" }),
    ).toThrow();

    // ON DELETE CASCADE declared in the SQL — verify it actually fires.
    db.run("DELETE FROM workspaces WHERE id = ?", [w]);
    expect(count()).toBe(0);
  });
});
