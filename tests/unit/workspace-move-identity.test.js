// YAN-1053: the workspace-move planner must use the same connection identity as
// creation dedup (connectionsRepo createInTx), not a weaker email/name guess.
// Same email + distinct Codex chatgptAccountId (or distinct OAuth usernames) are
// different accounts and must move; same-name access_token rows never dedup.
// Pattern: workspace-move.test.js (real route + repo on the tenancy harness).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 17 + 3) % 256));

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

let db;
let t;
let a2;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
  a2 = await (await import("@/lib/db/driver.js")).getAdapter();
}

async function moveAs(seeded, sourceId, body) {
  const route = await import("@/app/api/workspaces/[id]/move/route.js");
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(route.POST, `/api/workspaces/${sourceId}/move`, {
      as: seeded,
      method: "POST",
      body,
      params: { id: sourceId },
    });
  } finally {
    jar.cookie = "";
  }
}

async function clean() {
  for (const sql of [
    `DELETE FROM connectionGrants`,
    `DELETE FROM providerConnections`,
    `DELETE FROM auditEvents`,
    `DELETE FROM workspaceKeys`,
    `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped')`,
  ])
    a2.run(sql);
  const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
  clearCredentialCache(a2);
}

async function establishEncryption(workspaces) {
  const { loadMasterKey, deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
  const { encryptBytes, buildHashKeyWrapAad } = await import("@/lib/security/envelope.js");
  const { createMigrationContext, ensureWorkspaceDekSync, clearCredentialCache } = await import(
    "@/lib/db/helpers/credentialStorage.js"
  );
  const root = await loadMasterKey({ create: true });
  const set = (key, value) =>
    a2.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  set("credentialsEncryptedVersion", "1");
  set("credentialsKekKid", root.kid);
  set(
    "apiKeyHashKeyWrapped",
    JSON.stringify(
      encryptBytes(
        root.key,
        root.kid,
        deriveApiKeyHashKey(root.key),
        buildHashKeyWrapAad(workspaces[0], "0123456789abcdef"),
      ),
    ),
  );
  const mctx = createMigrationContext(a2, root);
  for (const ws of workspaces) ensureWorkspaceDekSync(a2, ws, mctx);
  clearCredentialCache(a2);
}

const codex = (accountId, token, extra = {}) => ({
  provider: "codex",
  authType: "oauth",
  email: "same@x.test",
  accessToken: `at-${token}`,
  refreshToken: `rt-${token}`,
  providerSpecificData: accountId ? { chatgptAccountId: accountId } : {},
  ...extra,
});

const wsOf = (id) =>
  a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [id]).workspaceId;

const body = (target, ids, extra = {}) => ({
  targetWorkspaceId: target,
  items: ids.map((id) => ({ type: "connection", id })),
  ...extra,
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("matchesConnectionIdentity (pure)", () => {
  async function m() {
    return (await import("@/lib/db/helpers/connectionIdentity.js")).matchesConnectionIdentity;
  }
  const oauth = (email, psd, provider = "claude") => ({
    provider,
    authType: "oauth",
    email,
    providerSpecificData: psd,
  });

  it("codex needs both truthy, equal chatgptAccountIds", async () => {
    const match = await m();
    const row = (id) => oauth("e@x", id ? { chatgptAccountId: id } : {}, "codex");
    expect(match(row("a1"), row("a1"))).toBe(true);
    expect(match(row("a1"), row("a2"))).toBe(false);
    expect(match(row(null), row(null))).toBe(false);
    expect(match(row("a1"), row(null))).toBe(false);
    expect(match(row(null), row("a1"))).toBe(false);
  });

  it("other OAuth: account ids first, one-sided is distinct, then usernames, else email", async () => {
    const match = await m();
    expect(match(oauth("e@x", { username: "u1" }), oauth("e@x", { username: "u1" }))).toBe(true);
    expect(match(oauth("e@x", { username: "u1" }), oauth("e@x", { username: "u2" }))).toBe(false);
    expect(match(oauth("e@x", { username: "u1" }), oauth("e@x", {}))).toBe(false);
    expect(match(oauth("e@x", {}), oauth("e@x", { username: "u1" }))).toBe(false);
    expect(match(oauth("e@x", {}), oauth("e@x", {}))).toBe(true);
    expect(match(oauth("e@x", {}), oauth("f@x", {}))).toBe(false);
    expect(
      match(oauth("e@x", { chatgptAccountId: "w1" }), oauth("e@x", { chatgptAccountId: "w1" })),
    ).toBe(true);
    expect(
      match(oauth("e@x", { chatgptAccountId: "w1" }), oauth("e@x", { chatgptAccountId: "w2" })),
    ).toBe(false);
    expect(match(oauth("e@x", { chatgptAccountId: "w1" }), oauth("e@x", {}))).toBe(false);
  });

  it("apikey matches by name only; access_token, nameless and cross-provider never match", async () => {
    const match = await m();
    const key = (name, provider = "openai") => ({ provider, authType: "apikey", name });
    expect(match(key("k"), key("k"))).toBe(true);
    expect(match(key("k"), key("j"))).toBe(false);
    expect(match(key(null), key(null))).toBe(false);
    expect(match(key("k", "openai"), key("k", "claude"))).toBe(false);
    const tok = (name) => ({ provider: "openai", authType: "access_token", name });
    expect(match(tok("k"), tok("k"))).toBe(false);
    expect(match({ ...key("k"), authType: "oauth" }, key("k"))).toBe(false);
    expect(match(oauth("", {}), oauth("", {}))).toBe(false);
  });
});

describe("workspace move: connection identity parity with creation dedup", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  it("moves a Codex login whose email matches a different chatgptAccountId in the target", async () => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-src", "src"));
    const stayer = await db.createConnection(a.ctx, a.personal, codex("acct-dst", "dst"));

    const preview = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect(preview.status).toBe(200);
    expect((await preview.json()).conflicts).toEqual([]);

    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(200);
    expect(wsOf(mover.id)).toBe(a.personal);
    expect(wsOf(stayer.id)).toBe(a.personal);
    const m = await db.getProviderConnectionByIdUnscoped(mover.id);
    const s = await db.getProviderConnectionByIdUnscoped(stayer.id);
    expect(m).toMatchObject({ accessToken: "at-src", refreshToken: "rt-src" });
    expect(m.providerSpecificData.chatgptAccountId).toBe("acct-src");
    expect(s).toMatchObject({ accessToken: "at-dst", refreshToken: "rt-dst" });
    expect(s.providerSpecificData.chatgptAccountId).toBe("acct-dst");
    expect(a2.get(`SELECT COUNT(*) AS n FROM providerConnections`).n).toBe(2);
  });

  it("blocks a Codex login with the same email and the same chatgptAccountId (NAME_TAKEN)", async () => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-1", "src"));
    const stayer = await db.createConnection(a.ctx, a.personal, codex("acct-1", "dst"));
    const before = JSON.stringify(a2.all(`SELECT * FROM providerConnections ORDER BY id`));

    const preview = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect((await preview.json()).conflicts).toEqual([
      { type: "connection", id: mover.id, code: "NAME_TAKEN", message: expect.any(String) },
    ]);
    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("move_conflict");
    expect(wsOf(mover.id)).toBe(shared.id);
    expect(wsOf(stayer.id)).toBe(a.personal);
    expect(JSON.stringify(a2.all(`SELECT * FROM providerConnections ORDER BY id`))).toBe(before);
  });

  it("allows same-name access_token rows (creation never dedups them)", async () => {
    const { a, shared } = t;
    const tok = (n) => ({
      provider: "openai",
      authType: "access_token",
      name: "same",
      accessToken: n,
    });
    const mover = await db.createConnection(a.ctx, shared.id, tok("tok-src"));
    const stayer = await db.createConnection(a.ctx, a.personal, tok("tok-dst"));
    const preview = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect((await preview.json()).conflicts).toEqual([]);
    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(200);
    expect(wsOf(mover.id)).toBe(a.personal);
    expect(wsOf(stayer.id)).toBe(a.personal);
  });

  it("does not conflict with a different destination auth type despite equal name/email", async () => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-1", "src"));
    await db.createConnection(a.ctx, a.personal, {
      provider: "codex",
      authType: "apikey",
      name: mover.name,
      email: mover.email,
      apiKey: "sk-destination",
    });
    const preview = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect((await preview.json()).conflicts).toEqual([]);
    expect((await moveAs(a, shared.id, body(a.personal, [mover.id]))).status).toBe(200);
  });

  const MALFORMED = {
    "invalid JSON": "{invalid-json",
    "non-object providerSpecificData": JSON.stringify({ providerSpecificData: "corrupt" }),
    "array providerSpecificData": JSON.stringify({ providerSpecificData: ["corrupt"] }),
    "object-valued chatgptAccountId": JSON.stringify({
      providerSpecificData: { chatgptAccountId: { rogue: true } },
    }),
    "object-valued username": JSON.stringify({
      providerSpecificData: { username: { rogue: true } },
    }),
  };

  it.each(
    Object.entries(MALFORMED).flatMap(([label, blob]) =>
      ["source", "target"].map((side) => [`${label} (${side} side)`, side, blob]),
    ),
  )("fails closed for malformed credential metadata: %s", async (_, side, blob) => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-src", "src"));
    let corruptId = mover.id;
    if (side === "target") {
      corruptId = (await db.createConnection(a.ctx, a.personal, codex("acct-dst", "dst"))).id;
    }
    a2.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [blob, corruptId]);
    const before = a2.all(`SELECT * FROM providerConnections ORDER BY id`);
    const preview = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect(preview.status).toBe(200);
    expect((await preview.json()).conflicts).toEqual([
      { type: "connection", id: mover.id, code: "NAME_TAKEN", message: expect.any(String) },
    ]);
    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("move_conflict");
    expect(a2.all(`SELECT * FROM providerConnections ORDER BY id`)).toEqual(before);
  });

  it("non-Codex OAuth: distinct usernames move, equal usernames conflict", async () => {
    const { a, shared } = t;
    const oauth = (username) => ({
      provider: "claude",
      authType: "oauth",
      email: "same@x.test",
      accessToken: `at-${username}`,
      providerSpecificData: { username },
    });
    const mover = await db.createConnection(a.ctx, shared.id, oauth("google|1"));
    await db.createConnection(a.ctx, a.personal, oauth("hf|2"));
    const ok = await moveAs(a, shared.id, body(a.personal, [mover.id], { preview: true }));
    expect((await ok.json()).conflicts).toEqual([]);

    const dupMover = await db.createConnection(a.ctx, shared.id, oauth("hf|2"));
    const bad = await moveAs(a, shared.id, body(a.personal, [dupMover.id], { preview: true }));
    expect((await bad.json()).conflicts).toEqual([
      { type: "connection", id: dupMover.id, code: "NAME_TAKEN", message: expect.any(String) },
    ]);
  });
});

describe("workspace move: connection identity under encrypted storage", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    await establishEncryption([t.shared.id, t.a.personal, t.b.personal]);
  });

  it("moves a Codex login with a distinct chatgptAccountId; tokens stay independent", async () => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-src", "src"));
    const stayer = await db.createConnection(a.ctx, a.personal, codex("acct-dst", "dst"));
    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(200);
    expect(wsOf(mover.id)).toBe(a.personal);
    const m = await db.getProviderConnectionByIdUnscoped(mover.id);
    const s = await db.getProviderConnectionByIdUnscoped(stayer.id);
    expect(m).toMatchObject({ accessToken: "at-src", refreshToken: "rt-src" });
    expect(s).toMatchObject({ accessToken: "at-dst", refreshToken: "rt-dst" });
    expect(JSON.stringify(a2.all(`SELECT data FROM providerConnections`))).not.toContain("at-src");
  });

  it("still blocks the same chatgptAccountId", async () => {
    const { a, shared } = t;
    const mover = await db.createConnection(a.ctx, shared.id, codex("acct-1", "src"));
    await db.createConnection(a.ctx, a.personal, codex("acct-1", "dst"));
    const res = await moveAs(a, shared.id, body(a.personal, [mover.id]));
    expect(res.status).toBe(409);
    expect(wsOf(mover.id)).toBe(shared.id);
  });
});
