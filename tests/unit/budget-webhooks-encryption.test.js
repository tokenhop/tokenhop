// YAN-1831 budget webhook secrets under credential encryption (D10): legacy
// plaintext encrypted by activation; on an encrypted instance a webhook
// create in a keyless workspace mints its DEK through the purpose-named
// guarded provisioner (and only there: createConnection still fails
// KEY_MISSING); a failed audit rolls the DEK back; DEK rotation re-encrypts
// the secret; a lost DEK fails delivery closed until a rotate re-provisions;
// workspace delete and snapshot restore remove the row; the secret never
// lands in the database files.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";
import { collectFilesText } from "../helpers/secretScan.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedMaster = process.env.TOKENHOP_MASTER_KEY;
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 17 + 9) % 256));
const URL_OK = "https://hooks.example.com/budget";
const code = (c) => expect.objectContaining({ code: c });

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const m = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return m ? { name: n, value: m[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let a2;
let db;
let t;
let repo;
let cs;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
  a2 = await (await import("@/lib/db/driver.js")).getAdapter();
  repo = await import("@/lib/db/repos/budgetWebhooksRepo.js");
  cs = await import("@/lib/db/helpers/credentialStorage.js");
}

async function clean() {
  for (const sql of [
    `DELETE FROM budgetWebhooks`,
    `DELETE FROM providerConnections`,
    `DELETE FROM providerNodes`,
    `DELETE FROM auditEvents`,
    `DELETE FROM workspaceKeys`,
    `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  ])
    a2.run(sql);
  cs.clearCredentialCache(a2);
  await db.updateSettings({ budgetWebhookAllowPrivateNetworks: false });
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

async function put(seeded, ws, body) {
  const route = await import("@/app/api/workspaces/[id]/budget-webhook/route.js");
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(route.PUT, `/api/workspaces/${ws}/budget-webhook`, {
      as: seeded,
      method: "PUT",
      body,
      params: { id: ws },
    });
  } finally {
    jar.cookie = "";
  }
}

const hookRow = (ws) => a2.get(`SELECT * FROM budgetWebhooks WHERE workspaceId = ?`, [ws]);
const dekRow = (ws) => a2.get(`SELECT * FROM workspaceKeys WHERE workspaceId = ?`, [ws]);

beforeEach(async () => {
  assertIsolatedHome();
  await load();
  await clean();
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedMaster === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = savedMaster;
});

describe("legacy install, then activation", () => {
  it("activation encrypts the plaintext secret and mints the workspace DEK", async () => {
    const ws = t.shared.id;
    const { secret } = await repo.saveBudgetWebhook(t.a.ctx, { workspaceId: ws, url: URL_OK });
    expect(JSON.parse(hookRow(ws).data)).toEqual({ secret });
    expect(dekRow(ws)).toBeUndefined();

    await useHashedKeys();
    await activate();
    const stored = JSON.parse(hookRow(ws).data).secret;
    expect(stored).toMatchObject({ v: expect.anything(), kid: expect.any(String) });
    expect(hookRow(ws).data).not.toContain(secret);
    expect(dekRow(ws)).toBeTruthy();
    expect((await repo.getBudgetWebhookForDeliveryUnscoped(ws)).secret).toBe(secret);
  });
});

describe("encrypted instance", () => {
  beforeEach(async () => {
    await useHashedKeys();
    await activate();
  });

  it("create in a keyless workspace provisions its DEK; createConnection elsewhere still fails", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Fresh" })).id;
    const other = (await db.createSharedWorkspace(t.a.ctx, { name: "Other" })).id;
    expect(dekRow(ws)).toBeUndefined();
    const owner = {
      ...t.a,
      ctx: { ...t.a.ctx, workspaceIds: [...t.a.ctx.workspaceIds, ws, other] },
    };
    const res = await put(owner, ws, { url: URL_OK });
    expect(res.status).toBe(201);
    const { secret } = await res.json();
    expect(dekRow(ws)).toBeTruthy();
    expect(hookRow(ws).data).not.toContain(secret);
    expect((await repo.getBudgetWebhookForDeliveryUnscoped(ws)).secret).toBe(secret);

    await expect(
      db.createConnection(owner.ctx, other, {
        provider: "openai",
        authType: "apikey",
        name: "x",
        apiKey: "sk-x",
      }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(dekRow(other)).toBeUndefined();
  });

  it("the webhook provisioner rejects forged contexts, marker mismatch and unknown workspaces", async () => {
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const root = await loadMasterKey();
    const ws = t.a.personal;
    const real = cs.prepareCredentialContext(a2, root);
    expect(() => cs.provisionBudgetWebhookDekSync(a2, ws, { ...real })).toThrow(
      code("KEY_MISSING"),
    );
    expect(() =>
      cs.provisionBudgetWebhookDekSync(a2, ws, {
        encrypted: true,
        kek: root.key,
        kekKid: root.kid,
        state: real.state,
        allowCreate: true,
      }),
    ).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.provisionBudgetWebhookDekSync(a2, ws, cs.createMigrationContext(a2, root)),
    ).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.provisionBudgetWebhookDekSync(a2, ws, cs.prepareCredentialContext(a2, null)),
    ).toThrow(code("KEY_MISSING"));
    expect(() => cs.provisionBudgetWebhookDekSync(a2, "no-such-ws", real)).toThrow(
      code("KEY_MISSING"),
    );
    a2.run(`UPDATE _meta SET value = 'ffffffffffffffff' WHERE key = 'credentialsKekKid'`);
    try {
      expect(() => cs.provisionBudgetWebhookDekSync(a2, ws, real)).toThrow(code("KEY_MISMATCH"));
    } finally {
      a2.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [root.kid]);
    }
    expect(dekRow(ws)).toBeUndefined();
    const first = cs.provisionBudgetWebhookDekSync(a2, ws, real);
    expect(first.kid).toBe(dekRow(ws).kid);
    expect(cs.provisionBudgetWebhookDekSync(a2, ws, real).kid).toBe(first.kid);
  });

  it("a failed audit rolls back the webhook and the freshly minted DEK", async () => {
    const ws = (await db.createSharedWorkspace(t.a.ctx, { name: "Rollback" })).id;
    const owner = { ...t.a, ctx: { ...t.a.ctx, workspaceIds: [...t.a.ctx.workspaceIds, ws] } };
    const run = a2.run.bind(a2);
    const spy = vi.spyOn(a2, "run").mockImplementation((sql, ...rest) => {
      if (String(sql).includes("INSERT INTO auditEvents")) throw new Error("audit down");
      return run(sql, ...rest);
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await put(owner, ws, { url: URL_OK })).status).toBe(500);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(hookRow(ws)).toBeUndefined();
    expect(dekRow(ws)).toBeUndefined();
  });

  it("DEK rotation re-encrypts the secret; a lost DEK fails closed until a rotate", async () => {
    const ws = t.shared.id;
    const { secret } = await repo.saveBudgetWebhook(t.a.ctx, { workspaceId: ws, url: URL_OK });
    const kidBefore = JSON.parse(hookRow(ws).data).secret.kid;
    const { rotateWorkspaceDek } = await import("@/lib/security/keyRotation.js");
    await rotateWorkspaceDek(a2, ws);
    cs.clearCredentialCache(a2);
    expect(JSON.parse(hookRow(ws).data).secret.kid).not.toBe(kidBefore);
    expect((await repo.getBudgetWebhookForDeliveryUnscoped(ws)).secret).toBe(secret);

    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [ws]);
    cs.clearCredentialCache(a2);
    await expect(repo.getBudgetWebhookForDeliveryUnscoped(ws)).rejects.toThrow(code("KEY_MISSING"));
    const { secret: fresh } = await repo.saveBudgetWebhook(t.a.ctx, {
      workspaceId: ws,
      rotateSecret: true,
    });
    expect(fresh).not.toBe(secret);
    expect(dekRow(ws)).toBeTruthy();
    expect((await repo.getBudgetWebhookForDeliveryUnscoped(ws)).secret).toBe(fresh);
  });
});

describe("lifecycle", () => {
  it("workspace delete and snapshot restore remove the row; DB files never hold the secret", async () => {
    await useHashedKeys();
    await activate();
    const doomed = (await db.createSharedWorkspace(t.a.ctx, { name: "Doomed" })).id;
    const owner = { ...t.a, ctx: { ...t.a.ctx, workspaceIds: [...t.a.ctx.workspaceIds, doomed] } };
    const { secret: s1 } = await (await put(owner, doomed, { url: URL_OK })).json();
    const { deleteWorkspaceUnscoped } = await import("@/lib/db/repos/workspacesRepo.js");
    await deleteWorkspaceUnscoped(a2, doomed);
    expect(hookRow(doomed)).toBeUndefined();

    const snapshot = await db.exportDb();
    const { secret: s2 } = await repo.saveBudgetWebhook(t.a.ctx, {
      workspaceId: t.shared.id,
      url: URL_OK,
    });
    await a2.flush?.();
    const leaks = collectFilesText(process.env.DATA_DIR).filter(
      (f) => f.text.includes(s1) || f.text.includes(s2),
    );
    expect(leaks.map((f) => f.name)).toEqual([]);

    await db.importDb(snapshot);
    a2 = await (await import("@/lib/db/driver.js")).getAdapter();
    expect(a2.get(`SELECT COUNT(*) AS c FROM budgetWebhooks`).c).toBe(0);
  });
});
