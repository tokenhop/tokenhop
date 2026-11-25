// YAN-1055: lazy runtime DEK provisioning for workspace import and connection
// creation on encrypted instances, with lost-DEK fail-closed protection,
// rollback hygiene, and strict confinement of runtime contexts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";
import { collectFilesText } from "../helpers/secretScan.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedMaster = process.env.TOKENHOP_MASTER_KEY;
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 23 + 11) % 256));
const code = (c) => expect.objectContaining({ code: c });

let a2;
let db;
let t;
let cs;
let transfer;

async function load(switchValue = "on") {
  vi.resetModules();
  process.env[ENV] = switchValue;
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
  a2 = await (await import("@/lib/db/driver.js")).getAdapter();
  cs = await import("@/lib/db/helpers/credentialStorage.js");
  transfer = await import("@/lib/db/workspaceTransfer.js");
}

async function clean() {
  for (const sql of [
    `DELETE FROM budgets`,
    `DELETE FROM budgetWebhooks`,
    `DELETE FROM connectionGrants`,
    `DELETE FROM providerConnections`,
    `DELETE FROM providerNodes`,
    `DELETE FROM combos`,
    `DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels')`,
    `DELETE FROM workspaceSettings`,
    `UPDATE settings SET data = '{}' WHERE id = 1`,
    `DELETE FROM auditEvents`,
    `DELETE FROM workspaceKeys`,
    `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  ])
    a2.run(sql);
  cs.clearCredentialCache(a2);
  t = await seedTenancy();
  await db.setMeta("defaultWorkspaceId", t.shared.id);
}

async function useHashedKeys() {
  const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  a2.exec(`DROP TABLE IF EXISTS apiKeys`);
  a2.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
  for (const idx of HASHED_API_KEYS_TABLE.indexes) a2.exec(idx);
  a2.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`, [
    masterKeyId(MASTER),
  ]);
}

async function activate() {
  const { loadMasterKey } = await import("@/lib/security/masterKey.js");
  const root = await loadMasterKey({ create: true });
  const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
  const result = await activateCredentialEncryption(a2, {
    enabled: true,
    beforeServing: true,
    root,
  });
  expect(result).toMatchObject({ status: "ready" });
  cs.clearCredentialCache(a2);
  return root;
}

const dekRow = (ws) => a2.get(`SELECT * FROM workspaceKeys WHERE workspaceId = ?`, [ws]);

function ownerCtxFor(seeded, ...extraWsIds) {
  const workspaceRoles = { ...seeded.ctx.workspaceRoles };
  for (const id of extraWsIds) workspaceRoles[id] = "owner";
  return {
    ...seeded.ctx,
    workspaceIds: [...new Set([...seeded.ctx.workspaceIds, ...extraWsIds])],
    workspaceRoles,
  };
}

function apiKeyConn(name, overrides = {}) {
  return {
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}-secret`,
    ...overrides,
  };
}

beforeEach(async () => {
  assertIsolatedHome();
  await load("on");
  await clean();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedMaster === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = savedMaster;
});

describe("connection creation in keyless encrypted workspaces", () => {
  beforeEach(async () => {
    await useHashedKeys();
    await activate();
  });

  it("provisions a fresh DEK for a newly created shared workspace and a personal workspace", async () => {
    const freshWs = (await db.createSharedWorkspace(t.a.ctx, { name: "Post-Activation" })).id;
    const ctx = ownerCtxFor(t.a, freshWs);
    expect(dekRow(freshWs)).toBeUndefined();
    expect(dekRow(t.a.personal)).toBeUndefined();

    const sharedConn = await db.createConnection(ctx, freshWs, apiKeyConn("fresh"));
    const personalConn = await db.createConnection(ctx, t.a.personal, apiKeyConn("pers"));

    expect(dekRow(freshWs)).toBeTruthy();
    expect(dekRow(t.a.personal)).toBeTruthy();
    expect(dekRow(freshWs).kid).not.toBe(dekRow(t.a.personal).kid);

    const rawShared = a2.get(`SELECT data FROM providerConnections WHERE id = ?`, [
      sharedConn.id,
    ]).data;
    expect(rawShared).not.toContain("sk-fresh-secret");
    expect(JSON.parse(rawShared).apiKey).toMatchObject({ v: 1, kid: dekRow(freshWs).kid });

    const roundTrip = await db.getConnection(ctx, sharedConn.id);
    expect(roundTrip.apiKey).toBe("sk-fresh-secret");
    expect((await db.getConnection(ctx, personalConn.id)).apiKey).toBe("sk-pers-secret");

    await a2.flush?.();
    const leaks = collectFilesText(process.env.DATA_DIR).filter(
      (f) => f.text.includes("sk-fresh-secret") || f.text.includes("sk-pers-secret"),
    );
    expect(leaks.map((f) => f.name)).toEqual([]);
  });

  it("provisions a fresh DEK for dotted providerSpecificData secrets (clientSecret, cookie)", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Dotted-Secrets" })).id;
    const ctx = ownerCtxFor(t.a, ws);
    expect(dekRow(ws)).toBeUndefined();

    const created = await db.createConnection(ctx, ws, {
      provider: "openai",
      authType: "oauth",
      name: "dotted-only",
      providerSpecificData: { clientSecret: "cs-nested-secret", cookie: "ck-nested-secret" },
    });
    expect(dekRow(ws)).toBeTruthy();
    const raw = a2.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]).data;
    expect(raw).not.toContain("cs-nested-secret");
    expect(raw).not.toContain("ck-nested-secret");
    const parsed = JSON.parse(raw);
    expect(parsed.providerSpecificData.clientSecret).toMatchObject({ v: 1, kid: dekRow(ws).kid });
    expect(parsed.providerSpecificData.cookie).toMatchObject({ v: 1, kid: dekRow(ws).kid });

    const roundTrip = await db.getConnection(ctx, created.id);
    expect(roundTrip.providerSpecificData.clientSecret).toBe("cs-nested-secret");
    expect(roundTrip.providerSpecificData.cookie).toBe("ck-nested-secret");
  });

  it("provisions Default's DEK on createProviderConnectionUnscoped and cleans up on rollback / null Default", async () => {
    expect(dekRow(t.shared.id)).toBeUndefined();

    // Rollback on createProviderConnectionUnscoped zeroes the cached DEK immediately.
    const env = await import("@/lib/security/envelope.js");
    const zeroSpy = vi.spyOn(env, "zeroBuffer");
    const run = a2.run.bind(a2);
    const runSpy = vi.spyOn(a2, "run").mockImplementation((sql, ...rest) => {
      if (String(sql).includes("INSERT INTO providerConnections")) throw new Error("unscoped boom");
      return run(sql, ...rest);
    });
    try {
      await expect(
        db.createProviderConnectionUnscoped(apiKeyConn("unscoped-boom")),
      ).rejects.toThrow("unscoped boom");
    } finally {
      runSpy.mockRestore();
    }
    expect(dekRow(t.shared.id)).toBeUndefined();
    // zeroBuffer was called both for insertWrappedDek's local key and for cache eviction on catch.
    expect(zeroSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    zeroSpy.mockRestore();

    // Happy path creates Default's DEK and encrypts.
    const created = await db.createProviderConnectionUnscoped(apiKeyConn("unscoped-default"));
    expect(dekRow(t.shared.id)).toBeTruthy();
    const raw = a2.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]).data;
    expect(raw).not.toContain("sk-unscoped-default-secret");
    expect((await db.getProviderConnectionByIdUnscoped(created.id)).apiKey).toBe(
      "sk-unscoped-default-secret",
    );

    // Null defaultWorkspaceId fails closed with DATA_CORRUPT (no DEK minted).
    a2.run(`DELETE FROM _meta WHERE key = 'defaultWorkspaceId'`);
    try {
      await expect(
        db.createProviderConnectionUnscoped(apiKeyConn("no-default")),
      ).rejects.toMatchObject({ code: "DATA_CORRUPT" });
    } finally {
      await db.setMeta("defaultWorkspaceId", t.shared.id);
    }
  });

  it("skips DEK creation for secretless connections, then provisions when a secret arrives via re-login upsert", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Secretless" })).id;
    const ctx = ownerCtxFor(t.a, ws);

    const empty = await db.createConnection(ctx, ws, {
      provider: "openai",
      authType: "apikey",
      name: "local-ollama",
      apiKey: "",
    });
    expect(dekRow(ws)).toBeUndefined();

    // Upsert by same apikey name with a real secret now provisions the DEK.
    const upgraded = await db.createConnection(ctx, ws, {
      provider: "openai",
      authType: "apikey",
      name: "local-ollama",
      apiKey: "sk-upgraded-secret",
    });
    expect(upgraded.id).toBe(empty.id);
    expect(dekRow(ws)).toBeTruthy();
    expect((await db.getConnection(ctx, upgraded.id)).apiKey).toBe("sk-upgraded-secret");
  });

  it("never leaves a DEK behind on rejected writes or rolled-back transactions", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Rollback" })).id;
    const ctx = ownerCtxFor(t.a, ws);

    // Non-member workspace and undefined workspaceId → NOT_FOUND, no DEK, and
    // unrelated workspaces' cached DEKs are NOT evicted.
    const warmWs = t.a.personal;
    await db.createConnection(t.a.ctx, warmWs, apiKeyConn("warm-cache"));
    const envWarm = await import("@/lib/security/envelope.js");
    const zeroWarmSpy = vi.spyOn(envWarm, "zeroBuffer");
    try {
      await expect(db.createConnection(t.b.ctx, ws, apiKeyConn("outsider"))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        db.createConnection(t.a.ctx, undefined, apiKeyConn("undef-ws")),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(zeroWarmSpy).not.toHaveBeenCalled();
    } finally {
      zeroWarmSpy.mockRestore();
    }
    expect(dekRow(ws)).toBeUndefined();

    // Caller-supplied envelope alongside a plaintext secret → ENVELOPE_REJECTED, rolled back + cache evicted.
    await expect(
      db.createConnection(ctx, ws, {
        provider: "openai",
        authType: "apikey",
        name: "forged-env",
        apiKey: "sk-valid-secret",
        refreshToken: { v: 1, kid: "k", iv: "a", ct: "b", tag: "c" },
      }),
    ).rejects.toMatchObject({ code: "ENVELOPE_REJECTED" });
    expect(dekRow(ws)).toBeUndefined();

    // Simulated SQL error after DEK insert inside the transaction rolls back the DEK and immediately
    // zeroes/evicts the cached plaintext DEK buffer (before any subsequent liveDek read).
    const env = await import("@/lib/security/envelope.js");
    const capturedDeks = [];
    const origDecrypt = env.decryptBytes;
    const decSpy = vi.spyOn(env, "decryptBytes").mockImplementation((...args) => {
      const out = origDecrypt(...args);
      capturedDeks.push(out);
      return out;
    });
    const run = a2.run.bind(a2);
    const spy = vi.spyOn(a2, "run").mockImplementation((sql, ...rest) => {
      if (String(sql).includes("INSERT INTO providerConnections")) throw new Error("disk full");
      return run(sql, ...rest);
    });
    try {
      await expect(db.createConnection(ctx, ws, apiKeyConn("boom"))).rejects.toThrow("disk full");
    } finally {
      spy.mockRestore();
      decSpy.mockRestore();
    }
    expect(dekRow(ws)).toBeUndefined();
    expect(capturedDeks.length).toBeGreaterThan(0);
    // Every DEK buffer unwrapped during the aborted tx was zeroed immediately by catch cleanup.
    for (const buf of capturedDeks) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }

    // Verify rolled-back DEK cannot be resurrected from cache.
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const rt = cs.prepareCredentialContext(a2, await loadMasterKey());
    expect(() => cs.ensureWorkspaceDekSync(a2, ws, rt)).toThrow(code("KEY_MISSING"));
  });

  it("fails closed with KEY_MISSING when an existing encrypted row's DEK was deleted (even for a different provider)", async () => {
    const ws = t.a.personal;
    const first = await db.createConnection(t.a.ctx, ws, apiKeyConn("existing-openai"));
    expect(dekRow(ws)).toBeTruthy();

    // Simulate lost/deleted DEK while encrypted ciphertext still exists.
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [ws]);
    cs.clearCredentialCache(a2);

    // Different provider so `all` in createInTx is empty; lost-DEK guard must still block!
    await expect(
      db.createConnection(t.a.ctx, ws, apiKeyConn("new-anthropic", { provider: "anthropic" })),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(dekRow(ws)).toBeUndefined();
    expect(
      a2.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE workspaceId = ?`, [ws]).n,
    ).toBe(1);
    expect(a2.get(`SELECT id FROM providerConnections WHERE id = ?`, [first.id])).toBeTruthy();
  });
});

describe("workspace import into keyless encrypted workspaces", () => {
  beforeEach(async () => {
    await useHashedKeys();
    await activate();
  });

  it("provisions a fresh DEK on secret-bearing import (connections and nodes) and round-trips", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Import-Target" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    const node = await db.createNode(ctx, src, {
      type: "openai-compatible",
      name: "Custom Gateway",
      prefix: "cgw",
      apiType: "chat",
      baseUrl: "https://gw.example.com/v1",
    });
    await db.createConnection(ctx, src, apiKeyConn("src-conn", { provider: node.id }));
    // Also attach a secret on the source node row directly to verify node-secret import too.
    await db.updateNode(ctx, node.id, { apiKey: "node-secret-val" });

    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });
    expect(dekRow(dst)).toBeUndefined();

    const res = await transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" });
    expect(res).toMatchObject({ success: true, imported: { connections: 1, nodes: 1 } });
    expect(dekRow(dst)).toBeTruthy();
    expect(dekRow(dst).kid).not.toBe(dekRow(src).kid);

    const dstConnRow = a2.get(`SELECT * FROM providerConnections WHERE workspaceId = ?`, [dst]);
    expect(dstConnRow.data).not.toContain("sk-src-conn-secret");
    expect(JSON.parse(dstConnRow.data).apiKey).toMatchObject({ v: 1, kid: dekRow(dst).kid });

    const dstNodeRow = a2.get(`SELECT * FROM providerNodes WHERE workspaceId = ?`, [dst]);
    expect(dstNodeRow.data).not.toContain("node-secret-val");
    expect(JSON.parse(dstNodeRow.data).apiKey).toMatchObject({ v: 1, kid: dekRow(dst).kid });

    const [loadedConn] = await db.listConnections(ctx, dst);
    expect(loadedConn.apiKey).toBe("sk-src-conn-secret");
    const [loadedNode] = await db.listNodes(ctx, dst);
    expect(loadedNode.apiKey).toBe("node-secret-val");
  });

  it("skips DEK provisioning for non-secret workspace imports", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Plain-Target" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    await db.createCombo(ctx, src, { name: "plain-combo", models: ["openai/gpt-4o"] });
    await db.setModelAlias(ctx, src, "fast", "openai/gpt-4o");

    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });
    expect(dekRow(dst)).toBeUndefined();

    const res = await transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" });
    expect(res).toMatchObject({ success: true, imported: { connections: 0, nodes: 0, combos: 1 } });
    expect(dekRow(dst)).toBeUndefined();
  });

  it("provisions a fresh DEK for a node-only secret import (without any connections)", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Node-Only-Dst" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    const node = await db.createNode(ctx, src, {
      type: "openai-compatible",
      name: "Secret Node",
      prefix: "sn",
      apiType: "chat",
      baseUrl: "https://node.example.com/v1",
    });
    // Ensure src has a DEK (e.g. via connection or migration) before sealing node secret.
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    cs.ensureWorkspaceDekSync(a2, src, cs.createMigrationContext(a2, await loadMasterKey()));
    await db.updateNode(ctx, node.id, { apiKey: "node-only-secret" });

    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });
    expect(doc.connections).toHaveLength(0);
    expect(doc.nodes).toHaveLength(1);
    expect(dekRow(dst)).toBeUndefined();

    const res = await transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" });
    expect(res).toMatchObject({ success: true, imported: { connections: 0, nodes: 1 } });
    expect(dekRow(dst)).toBeTruthy();
    const dstNodeRow = a2.get(`SELECT * FROM providerNodes WHERE workspaceId = ?`, [dst]);
    expect(dstNodeRow.data).not.toContain("node-only-secret");
    expect((await db.listNodes(ctx, dst))[0].apiKey).toBe("node-only-secret");
  });

  it("does not provision a DEK on conflicts, auth failure, or rolled-back import failure", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Conflict-Target" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    await db.createConnection(ctx, src, apiKeyConn("imp"));
    await db.createCombo(ctx, src, { name: "shared-combo", models: [] });
    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });

    // Non-owner auth failure → FORBIDDEN, no DEK minted.
    const memberCtx = {
      ...t.b.ctx,
      workspaceIds: [...t.b.ctx.workspaceIds, dst],
      workspaceRoles: { ...t.b.ctx.workspaceRoles, [dst]: "member" },
    };
    a2.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'member', 'manual', ?)`,
      [dst, t.b.user.id, new Date().toISOString()],
    );
    await expect(
      transfer.importWorkspace(memberCtx, dst, doc, { passphrase: "strong passphrase" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dekRow(dst)).toBeUndefined();

    // Pending owner auth failure (in-tx re-check) → FORBIDDEN, no DEK minted.
    a2.run(`UPDATE users SET instanceRole = 'pending' WHERE id = ?`, [t.a.user.id]);
    try {
      await expect(
        transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(dekRow(dst)).toBeUndefined();
    } finally {
      a2.run(`UPDATE users SET instanceRole = 'owner' WHERE id = ?`, [t.a.user.id]);
    }

    // Conflict on combo name → TRANSFER_CONFLICT, no DEK minted.
    await db.createCombo(ctx, dst, { name: "shared-combo", models: [] });
    await expect(
      transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" }),
    ).rejects.toMatchObject({ code: "TRANSFER_CONFLICT" });
    expect(dekRow(dst)).toBeUndefined();

    // Remove conflict, then force a late rollback via duplicate source connection ID and prove
    // the unwrapped DEK buffer is immediately zeroed before any subsequent liveDek read.
    a2.run(`DELETE FROM combos WHERE workspaceId = ?`, [dst]);
    const badDoc = structuredClone(doc);
    badDoc.connections.push({ ...structuredClone(badDoc.connections[0]), name: "Other Name" });
    const env = await import("@/lib/security/envelope.js");
    const capturedDeks = [];
    const origDecrypt = env.decryptBytes;
    const decSpy = vi.spyOn(env, "decryptBytes").mockImplementation((...args) => {
      const out = origDecrypt(...args);
      if (typeof args[2] === "string" && args[2].startsWith("v1|workspaceKeys|")) {
        capturedDeks.push(out);
      }
      return out;
    });
    try {
      await expect(
        transfer.importWorkspace(ctx, dst, badDoc, { passphrase: "strong passphrase" }),
      ).rejects.toMatchObject({ code: "TRANSFER_FORMAT_INVALID" });
    } finally {
      decSpy.mockRestore();
    }
    expect(dekRow(dst)).toBeUndefined();
    expect(capturedDeks.length).toBeGreaterThan(0);
    for (const buf of capturedDeks) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }
    expect(
      a2.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE workspaceId = ?`, [dst]).n,
    ).toBe(0);

    // Cache must also be clean (cannot resurrect the rolled-back DEK).
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const rt = cs.prepareCredentialContext(a2, await loadMasterKey());
    expect(() => cs.ensureWorkspaceDekSync(a2, dst, rt)).toThrow(code("KEY_MISSING"));
  });

  it("fails closed with KEY_MISSING on import if destination already has encrypted rows with a deleted DEK", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Lost-DEK-Dst" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    await db.createConnection(ctx, src, apiKeyConn("src-c"));
    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });

    // Put an encrypted connection in dst, then delete dst's DEK.
    await db.createConnection(ctx, dst, apiKeyConn("dst-existing", { provider: "anthropic" }));
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [dst]);
    cs.clearCredentialCache(a2);

    await expect(
      transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(dekRow(dst)).toBeUndefined();
    expect(
      a2.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE workspaceId = ?`, [dst]).n,
    ).toBe(1);
  });
});

describe("provisioner guardrails and runtime confinement", () => {
  beforeEach(async () => {
    await useHashedKeys();
    await activate();
  });

  it.each([
    ["provisionWorkspaceImportDekSync", (m) => m.provisionWorkspaceImportDekSync],
    ["provisionConnectionCreateDekSync", (m) => m.provisionConnectionCreateDekSync],
  ])(
    "%s rejects forged contexts, migration/rootless contexts, unknown workspaces, and marker mismatch",
    async (_name, pick) => {
      const provision = pick(cs);
      const { loadMasterKey } = await import("@/lib/security/masterKey.js");
      const root = await loadMasterKey();
      const ws = t.a.personal;
      const real = cs.prepareCredentialContext(a2, root);

      expect(() => provision(a2, ws, { ...real })).toThrow(code("KEY_MISSING"));
      expect(() =>
        provision(a2, ws, {
          encrypted: true,
          kek: root.key,
          kekKid: root.kid,
          state: real.state,
          allowCreate: true,
        }),
      ).toThrow(code("KEY_MISSING"));
      expect(() => provision(a2, ws, cs.createMigrationContext(a2, root))).toThrow(
        code("KEY_MISSING"),
      );
      expect(() => provision(a2, ws, cs.prepareCredentialContext(a2, null))).toThrow(
        code("KEY_MISSING"),
      );
      expect(() => provision(a2, "no-such-workspace", real)).toThrow(code("KEY_MISSING"));

      a2.run(`UPDATE _meta SET value = 'ffffffffffffffff' WHERE key = 'credentialsKekKid'`);
      try {
        expect(() => provision(a2, ws, real)).toThrow(code("KEY_MISMATCH"));
      } finally {
        a2.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [root.kid]);
      }
      expect(dekRow(ws)).toBeUndefined();

      // Happy path + idempotent reuse.
      const first = provision(a2, ws, real);
      expect(first.kid).toBe(dekRow(ws).kid);
      expect(provision(a2, ws, real).kid).toBe(first.kid);
    },
  );

  it("hasCoveredSecret matches encodeCredentialRowSync leaf semantics", () => {
    expect(cs.hasCoveredSecret({ apiKey: "sk-1" }, "providerConnections")).toBe(true);
    expect(
      cs.hasCoveredSecret(
        { providerSpecificData: { clientSecret: "cs-1" } },
        "providerConnections",
      ),
    ).toBe(true);
    expect(cs.hasCoveredSecret({ apiKey: "" }, "providerConnections")).toBe(false);
    expect(cs.hasCoveredSecret({ apiKey: null }, "providerConnections")).toBe(false);
    expect(cs.hasCoveredSecret({ apiKey: 123 }, "providerConnections")).toBe(false);
    expect(
      cs.hasCoveredSecret(
        { apiKey: { v: 1, kid: "k", iv: "a", ct: "b", tag: "c" } },
        "providerConnections",
      ),
    ).toBe(false);
    expect(cs.hasCoveredSecret({ authHeader: "Bearer x" }, "providerNodes")).toBe(true);
    expect(cs.hasCoveredSecret({ prefix: "p", baseUrl: "https://x" }, "providerNodes")).toBe(false);
    expect(cs.hasCoveredSecret(null, "providerConnections")).toBe(false);
  });

  it("lost-DEK guard fails closed across providerNodes, budgetWebhooks, Default settings, corrupt JSON, lookalikes, and move target", async () => {
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const root = await loadMasterKey();
    const real = cs.prepareCredentialContext(a2, root);
    const mctx = cs.createMigrationContext(a2, root);
    const now = new Date().toISOString();

    // 1. Encrypted providerNode with deleted DEK blocks create, import, and move provisioners.
    const wsNode = (await db.createSharedWorkspace(t.a.ctx, { name: "Lost-Node" })).id;
    cs.ensureWorkspaceDekSync(a2, wsNode, mctx);
    const nodeData = cs.encodeCredentialRowSync(
      a2,
      { id: "n-lost", data: { prefix: "p", apiKey: "sk-node" } },
      mctx,
      { table: "providerNodes", workspaceId: wsNode, mode: "migration" },
    );
    a2.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('n-lost', 'openai-compatible', 'N', ?, ?, ?, ?, ?)`,
      [nodeData, now, now, wsNode, t.a.user.id],
    );
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [wsNode]);
    cs.clearCredentialCache(a2);
    expect(() => cs.provisionConnectionCreateDekSync(a2, wsNode, real)).toThrow(
      code("KEY_MISSING"),
    );
    expect(() => cs.provisionWorkspaceImportDekSync(a2, wsNode, real)).toThrow(code("KEY_MISSING"));
    expect(() => cs.provisionMoveTargetDekSync(a2, wsNode, real)).toThrow(code("KEY_MISSING"));
    expect(() => cs.provisionBudgetWebhookDekSync(a2, wsNode, real)).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.provisionBudgetWebhookDekSync(a2, wsNode, real, { replacingWebhook: true }),
    ).toThrow(code("KEY_MISSING"));

    // 2. Encrypted budgetWebhook with deleted DEK blocks create/import/move provisioners.
    const wsHook = (await db.createSharedWorkspace(t.a.ctx, { name: "Lost-Hook" })).id;
    cs.ensureWorkspaceDekSync(a2, wsHook, mctx);
    const hookData = cs.encodeCredentialRowSync(
      a2,
      { id: "h-lost", data: { secret: "whsec_lost" } },
      mctx,
      { table: "budgetWebhooks", workspaceId: wsHook, mode: "migration" },
    );
    a2.run(
      `INSERT INTO budgetWebhooks(id, workspaceId, url, enabled, data, createdByUserId, createdAt, updatedAt)
       VALUES('h-lost', ?, 'https://hooks.example.com/x', 1, ?, ?, ?, ?)`,
      [wsHook, hookData, t.a.user.id, now, now],
    );
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [wsHook]);
    cs.clearCredentialCache(a2);
    expect(() => cs.provisionConnectionCreateDekSync(a2, wsHook, real)).toThrow(
      code("KEY_MISSING"),
    );

    // 3. Encrypted settings on Default with deleted DEK blocks Default, not sibling workspaces.
    const defaultWs = t.shared.id;
    cs.ensureWorkspaceDekSync(a2, defaultWs, mctx);
    const settingsData = cs.encodeCredentialRowSync(
      a2,
      { id: "1", data: { oidcClientSecret: "oidc-secret" } },
      mctx,
      { table: "settings", workspaceId: defaultWs, mode: "migration" },
    );
    a2.run(`INSERT OR REPLACE INTO settings(id, data) VALUES(1, ?)`, [settingsData]);
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [defaultWs]);
    cs.clearCredentialCache(a2);
    expect(() => cs.provisionConnectionCreateDekSync(a2, defaultWs, real)).toThrow(
      code("KEY_MISSING"),
    );
    const cleanSibling = (await db.createSharedWorkspace(t.a.ctx, { name: "Clean-Sibling" })).id;
    expect(cs.provisionConnectionCreateDekSync(a2, cleanSibling, real).kid).toBe(
      dekRow(cleanSibling).kid,
    );

    // 4. Corrupt JSON blob or envelope-lookalike in a keyless workspace fails closed.
    const wsCorrupt = (await db.createSharedWorkspace(t.a.ctx, { name: "Corrupt-Json" })).id;
    a2.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('c-corrupt', 'openai', 'apikey', 'Bad', 1, 1, '{not-json', ?, ?, ?, ?)`,
      [now, now, wsCorrupt, t.a.user.id],
    );
    expect(() => cs.provisionConnectionCreateDekSync(a2, wsCorrupt, real)).toThrow(
      code("KEY_MISSING"),
    );

    const wsLookalike = (await db.createSharedWorkspace(t.a.ctx, { name: "Lookalike" })).id;
    a2.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('c-look', 'openai', 'apikey', 'Look', 1, 1, ?, ?, ?, ?, ?)`,
      [
        JSON.stringify({ apiKey: { v: 99, kid: "x", iv: "a", ct: "b", tag: "c" } }),
        now,
        now,
        wsLookalike,
        t.a.user.id,
      ],
    );
    expect(() => cs.provisionConnectionCreateDekSync(a2, wsLookalike, real)).toThrow(
      code("KEY_MISSING"),
    );
  });

  it("keeps ensureWorkspaceDekSync, direct encodeCredentialRowSync, updateConnection, and updateNode fail-closed", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Confined" })).id;
    const ctx = ownerCtxFor(t.a, ws);

    // Create secretless connection & node so updateConnection / updateNode have a target row.
    const c = await db.createConnection(ctx, ws, {
      provider: "openai",
      authType: "apikey",
      name: "empty-c",
      apiKey: "",
    });
    const n = await db.createNode(ctx, ws, {
      type: "openai-compatible",
      name: "empty-n",
      prefix: "en",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
    });
    expect(dekRow(ws)).toBeUndefined();

    await expect(db.updateConnection(ctx, c.id, { apiKey: "sk-nope" })).rejects.toMatchObject({
      code: "KEY_MISSING",
    });
    await expect(db.updateNode(ctx, n.id, { apiKey: "sk-nope" })).rejects.toMatchObject({
      code: "KEY_MISSING",
    });
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const rt = cs.prepareCredentialContext(a2, await loadMasterKey());
    expect(() => cs.ensureWorkspaceDekSync(a2, ws, rt)).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.encodeCredentialRowSync(a2, { id: "direct", data: { apiKey: "sk-nope" } }, rt, {
        table: "providerConnections",
        workspaceId: ws,
      }),
    ).toThrow(code("KEY_MISSING"));
    expect(dekRow(ws)).toBeUndefined();
  });
});

describe("legacy unencrypted install unchanged", () => {
  it("never writes workspaceKeys on createConnection or importWorkspace when encryption is off", async () => {
    const src = t.shared.id;
    const dst = (await db.createSharedWorkspace(t.a.ctx, { name: "Legacy-Dst" })).id;
    const ctx = ownerCtxFor(t.a, src, dst);

    const created = await db.createConnection(ctx, src, apiKeyConn("legacy"));
    expect(dekRow(src)).toBeUndefined();
    expect(
      JSON.parse(a2.get(`SELECT data FROM providerConnections WHERE id = ?`, [created.id]).data)
        .apiKey,
    ).toBe("sk-legacy-secret");

    const doc = await transfer.exportWorkspace(ctx, src, { passphrase: "strong passphrase" });
    await transfer.importWorkspace(ctx, dst, doc, { passphrase: "strong passphrase" });
    expect(dekRow(dst)).toBeUndefined();
    expect((await db.listConnections(ctx, dst))[0].apiKey).toBe("sk-legacy-secret");
  });
});
