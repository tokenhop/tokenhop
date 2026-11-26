// YAN-2488: coverage for the connectionsRepo split — the facade keeps its exports,
// the pure patch rules behave as before, and the untested maintenance paths
// (cleanup, reorder) keep their contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPsdDelta,
  clearReauthOnCredentialReplace,
  deriveConnectionName,
  mergeReloginProviderData,
  resetHealthStateOnActivation,
} from "@/lib/db/helpers/connectionPatch.js";

describe("connectionsRepo facade", () => {
  it("keeps the public export surface", async () => {
    const repo = await import("@/lib/db/repos/connectionsRepo.js");
    expect(Object.keys(repo).sort()).toEqual([
      "assertCredentialCtxCurrent",
      "cleanupProviderConnectionsUnscoped",
      "createConnection",
      "createProviderConnectionUnscoped",
      "deleteConnection",
      "deleteProviderConnectionUnscoped",
      "deleteProviderConnectionsByProviderUnscoped",
      "getConnection",
      "getProviderConnectionByIdUnscoped",
      "getProviderConnectionMetadataByIdUnscoped",
      "getProviderConnectionsMetadataUnscoped",
      "getProviderConnectionsUnscoped",
      "listConnections",
      "listConnectionsMetadata",
      "mutateBillingLockUnscoped",
      "mutateProviderConnectionUnscoped",
      "prepareCredentialCtx",
      "reorderProviderConnectionsUnscoped",
      "updateConnection",
      "updateProviderConnectionUnscoped",
    ]);
  });
});

describe("connection patch rules", () => {
  it("re-login keeps weight, a manual tier and a cursor machineId", () => {
    const merged = mergeReloginProviderData(
      { weight: 3, planTier: "pro", planTierManual: true, machineId: "ide-1", proxy: "p" },
      { weight: 9, planTier: "free", machineId: "random", region: "us" },
      "cursor",
    );
    expect(merged).toEqual({
      weight: 3,
      planTier: "pro",
      planTierManual: true,
      machineId: "ide-1",
      proxy: "p",
      region: "us",
    });
  });

  it("re-login drops a detected tier the fresh grant omits; an import wins the machineId", () => {
    expect(
      mergeReloginProviderData({ planTier: "pro", planTierCheckedAt: 1 }, { a: 1 }, "codex"),
    ).toEqual({ a: 1 });
    expect(
      mergeReloginProviderData(
        { machineId: "old" },
        { machineId: "ide", authMethod: "imported" },
        "cursor",
      ).machineId,
    ).toBe("ide");
    expect(mergeReloginProviderData(undefined, undefined, "codex")).toBeUndefined();
  });

  it("providerSpecificData patches are deltas against the live row", () => {
    const merged = {};
    applyPsdDelta(
      merged,
      { providerSpecificData: { a: 1, b: 2 } },
      {
        providerSpecificData: { b: null, c: 3 },
      },
    );
    expect(merged.providerSpecificData).toEqual({ a: 1, c: 3 });
    const cleared = {};
    applyPsdDelta(cleared, { providerSpecificData: { a: 1 } }, { providerSpecificData: null });
    expect(cleared.providerSpecificData).toBeNull();
    const untouched = {};
    applyPsdDelta(untouched, { providerSpecificData: { a: 1 } }, { name: "x" });
    expect(untouched).toEqual({});
  });

  it("activation clears health state and model locks", () => {
    const patch = resetHealthStateOnActivation(
      { modelLock_gpt: "t", modelLockMeta_gpt: "m", other: 1 },
      { testStatus: "active", lastError: "kept" },
    );
    expect(patch).toEqual({
      testStatus: "active",
      lastError: "kept",
      lastErrorAt: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
      modelLock_gpt: null,
      modelLockMeta_gpt: null,
    });
    const inactive = { testStatus: "error" };
    expect(resetHealthStateOnActivation({}, inactive)).toBe(inactive);
  });

  it("reauthRequired clears only on a credential replacement", () => {
    const flagged = { reauthRequired: true, refreshToken: "rt", testStatus: "expired" };
    expect(clearReauthOnCredentialReplace(flagged, { testStatus: "active", name: "n" })).toEqual({
      name: "n",
    });
    expect(clearReauthOnCredentialReplace(flagged, { refreshToken: "rt2" })).toMatchObject({
      refreshToken: "rt2",
      reauthRequired: null,
      testStatus: "active",
      errorCode: null,
    });
  });

  it("github connections are named after the login", () => {
    expect(
      deriveConnectionName(
        { provider: "github", providerSpecificData: { githubLogin: "octo" } },
        "Account 1",
      ),
    ).toBe("octo");
    expect(deriveConnectionName({ provider: "codex" }, "Account 1")).toBe("Account 1");
  });
});

describe("connection maintenance (real SQLite)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-conn-split-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("reorder makes priorities dense 1..N", async () => {
    const mk = (name, priority) =>
      db.createProviderConnectionUnscoped({
        provider: "openai",
        authType: "apikey",
        name,
        apiKey: `sk-${name}`,
        priority,
      });
    await mk("r-a", 10);
    await mk("r-b", 20);
    await mk("r-c", 30);
    await db.reorderProviderConnectionsUnscoped("openai");
    const list = await db.getProviderConnectionsUnscoped({ provider: "openai" });
    expect(list.map((c) => [c.name, c.priority])).toEqual([
      ["r-a", 1],
      ["r-b", 2],
      ["r-c", 3],
    ]);
  });

  it("cleanup drops null fields and an empty providerSpecificData", async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "anthropic",
      authType: "apikey",
      name: "c-a",
      apiKey: "sk-c",
    });
    await db.updateProviderConnectionUnscoped(conn.id, {
      lastError: null,
      testStatus: null,
      providerSpecificData: {},
    });
    const cleaned = await db.cleanupProviderConnectionsUnscoped();
    expect(cleaned).toBeGreaterThanOrEqual(3);
    const after = await db.getProviderConnectionByIdUnscoped(conn.id);
    expect(after).not.toHaveProperty("lastError");
    expect(after).not.toHaveProperty("testStatus");
    expect(after).not.toHaveProperty("providerSpecificData");
    expect(after.apiKey).toBe("sk-c");
    // Existing behavior: `email` is a SQL column re-added as null on every read,
    // so a repeat run still counts it once per email-less row.
    const rows = (await db.getProviderConnectionsUnscoped()).filter((c) => c.email == null);
    expect(await db.cleanupProviderConnectionsUnscoped()).toBe(rows.length);
  });
});
