// YAN-361: workspace ownership of provider connections and nodes. Migration
// fixture, cross-workspace negatives on the YAN-354 two-user harness (repos and
// routes), per-workspace dedup/priority/prefixes, and the switch-off regression.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, denied, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");

// Route handlers read cookies(); the harness cookie is mirrored into this jar.
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

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
}

// Call a route as a seeded user: the session goes to both the request and next/headers.
async function as(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

const apiKeyConn = (name, extra = {}) => ({
  provider: "openai",
  authType: "apikey",
  name,
  apiKey: `sk-${name}`,
  ...extra,
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("migration 005 connection-ownership", () => {
  it("adds nullable owner columns to a v1.0.0 DB, keeps rows, reruns as a no-op", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const m005 = (await import("@/lib/db/migrations/005-connection-ownership.js")).default;
    const { adoptOwnerlessRowsUnscoped } = await import("@/lib/db/repos/ownership.js");
    const fx = await createSqlJsAdapter(path.join(process.env.TOKENHOP_TEST_ROOT, "v1.sqlite"));
    fx.exec(FIXTURE);
    runVersionedMigrations(fx);
    m005.up(fx);
    expect(fx.get(`SELECT id, workspaceId, createdByUserId FROM providerConnections`)).toEqual({
      id: "pc1",
      workspaceId: null,
      createdByUserId: null,
    });
    // Before any bootstrap there is nothing to adopt into.
    expect(fx.transaction(() => adoptOwnerlessRowsUnscoped(fx))).toBe(0);
    fx.close();
  });
});

describe("switch on: two users", () => {
  beforeEach(async () => {
    await load("on");
    const a = await (await import("@/lib/db/driver.js")).getAdapter();
    a.run(`DELETE FROM providerConnections`);
    a.run(`DELETE FROM providerNodes`);
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  it("bootstrap adopts ownerless rows into Default, idempotently", async () => {
    const a = await (await import("@/lib/db/driver.js")).getAdapter();
    const legacy = await db.createProviderConnectionUnscoped(apiKeyConn("legacy"));
    expect(legacy.workspaceId).toBeUndefined();
    a.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    expect(await db.adoptOwnerlessUnscoped()).toBe(1);
    expect(await db.adoptOwnerlessUnscoped()).toBe(0);
    const row = await db.getConnection(t.a.ctx, legacy.id);
    expect(row).toMatchObject({ workspaceId: t.shared.id, createdByUserId: t.a.user.id });
    // Unscoped writers (OAuth flows) now land in Default too.
    const later = await db.createProviderConnectionUnscoped(apiKeyConn("oauth-flow"));
    expect(later.workspaceId).toBe(t.shared.id);
  });

  it("B cannot get, update, delete or list A's personal connection", async () => {
    const { a, b } = t;
    const c = await db.createConnection(a.ctx, a.personal, apiKeyConn("mine"));
    expect(c).toMatchObject({ workspaceId: a.personal, createdByUserId: a.user.id });
    expect(await denied(db.getConnection(b.ctx, c.id))).toBe(true);
    expect(await denied(db.updateConnection(b.ctx, c.id, { name: "x" }))).toBe(true);
    expect(await denied(db.deleteConnection(b.ctx, c.id))).toBe(true);
    expect(await denied(db.listConnections(b.ctx, a.personal))).toBe(true);
    expect(await denied(db.createConnection(b.ctx, a.personal, apiKeyConn("x")))).toBe(true);
    expect((await db.listConnections(b.ctx, b.personal)).map((r) => r.id)).not.toContain(c.id);
    expect((await db.getConnection(a.ctx, c.id)).name).toBe("mine");
  });

  it("same account email in two workspaces is two rows; priority is per workspace", async () => {
    const { a, b } = t;
    const oauth = { provider: "claude", authType: "oauth", email: "me@x.test", accessToken: "t" };
    const ca = await db.createConnection(a.ctx, a.personal, oauth);
    const cb = await db.createConnection(b.ctx, b.personal, { ...oauth, accessToken: "u" });
    expect(cb.id).not.toBe(ca.id);
    expect(cb.priority).toBe(1);
    // Re-login inside one workspace still merges.
    const again = await db.createConnection(a.ctx, a.personal, { ...oauth, accessToken: "v" });
    expect(again.id).toBe(ca.id);
    const a2 = await db.createConnection(a.ctx, a.personal, { ...oauth, email: "two@x.test" });
    expect(a2.priority).toBe(2);
    expect((await db.getConnection(b.ctx, cb.id)).priority).toBe(1);
  });

  it("node prefixes are unique per workspace; nodes are IDOR-safe", async () => {
    const { a, b } = t;
    const node = { type: "openai-compatible", name: "N", prefix: "my", baseUrl: "http://x" };
    const na = await db.createNode(a.ctx, a.personal, { ...node, id: "openai-compatible-a" });
    await db.createNode(b.ctx, b.personal, { ...node, id: "openai-compatible-b" });
    await expect(db.createNode(a.ctx, a.personal, { ...node, id: "dup" })).rejects.toMatchObject({
      code: "PREFIX_TAKEN",
    });
    expect(await denied(db.getNode(b.ctx, na.id))).toBe(true);
    expect(await denied(db.updateNode(b.ctx, na.id, { name: "x" }))).toBe(true);
    expect(await denied(db.deleteNode(b.ctx, na.id))).toBe(true);
    expect((await db.listNodes(b.ctx, b.personal)).map((n) => n.id)).toEqual([
      "openai-compatible-b",
    ]);
  });

  it("routes: B gets 404 on A's rows, a member gets 403 on manage, secrets never leak", async () => {
    const { a, b, shared } = t;
    const item = await import("@/app/api/providers/[id]/route.js");
    const test = await import("@/app/api/providers/[id]/test/route.js");
    const list = await import("@/app/api/providers/route.js");
    const nodes = await import("@/app/api/provider-nodes/[id]/route.js");
    const c = await db.createConnection(a.ctx, a.personal, apiKeyConn("a-key"));
    const sc = await db.createConnection(
      a.ctx,
      shared.id,
      apiKeyConn("team", { providerSpecificData: { copilotToken: "secret-psd" } }),
    );
    const n = await db.createNode(a.ctx, a.personal, {
      id: "openai-compatible-chat-n1",
      type: "openai-compatible",
      name: "N",
      prefix: "n1",
      apiType: "chat",
      baseUrl: "http://x",
    });
    const p = { id: c.id };
    expect((await as(b, item.GET, `/api/providers/${c.id}`, { params: p })).status).toBe(404);
    const put = { method: "PUT", body: { name: "x" }, params: p };
    expect((await as(b, item.PUT, `/api/providers/${c.id}`, put)).status).toBe(404);
    const del = { method: "DELETE", params: p };
    expect((await as(b, item.DELETE, `/api/providers/${c.id}`, del)).status).toBe(404);
    const tst = { method: "POST", params: p };
    expect((await as(b, test.POST, `/api/providers/${c.id}/test`, tst)).status).toBe(404);
    const usage = await import("@/app/api/usage/[connectionId]/route.js");
    const reset = await import("@/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const up = { params: { connectionId: c.id } };
    expect((await as(b, usage.GET, `/api/usage/${c.id}?force=1`, up)).status).toBe(404);
    const rp = { method: "POST", params: { connectionId: c.id } };
    expect((await as(b, reset.POST, `/api/usage/${c.id}/codex-reset-credits`, rp)).status).toBe(
      404,
    );
    // Collection routes that touch connections by provider stay in B's workspace.
    const avail = await import("@/app/api/models/availability/route.js");
    await db.updateConnection(a.ctx, c.id, { "modelLock_gpt-5": "2999-01-01T00:00:00Z" });
    const clear = {
      method: "POST",
      body: { action: "clearCooldown", provider: "openai", model: "gpt-5" },
    };
    expect(
      (await as(b, avail.POST, `/api/models/availability?workspaceId=${b.personal}`, clear)).status,
    ).toBe(200);
    expect((await db.getConnection(a.ctx, c.id))["modelLock_gpt-5"]).toBeTruthy();
    const np = { method: "DELETE", params: { id: n.id } };
    expect((await as(b, nodes.DELETE, `/api/provider-nodes/${n.id}`, np)).status).toBe(404);
    expect(await db.getNode(a.ctx, n.id)).not.toBeNull();

    // B is a plain member of the shared workspace: may not manage or read metadata.
    const sp = { method: "DELETE", params: { id: sc.id } };
    expect((await as(b, item.DELETE, `/api/providers/${sc.id}`, sp)).status).toBe(403);
    const other = `/api/providers?workspaceId=${a.personal}`;
    expect((await as(b, list.GET, other)).status).toBe(404);

    // A lists the shared workspace: own rows only, never secret fields.
    const res = await as(a, list.GET, `/api/providers?workspaceId=${shared.id}`);
    const { connections } = await res.json();
    expect(connections.map((x) => x.id)).toEqual([sc.id]);
    expect(connections[0].apiKey).toBeUndefined();
    expect(connections[0].providerSpecificData?.copilotToken).toBeUndefined();
    const one = await (
      await as(a, item.GET, `/api/providers/${sc.id}`, { params: { id: sc.id } })
    ).json();
    expect(one.connection.apiKey).toBeUndefined();
    expect(one.connection.name).toBe("team");
  }, 30_000); // cold imports of the route modules (open-sse) under a loaded run
});

// YAN-365: encrypted repo behavior against the real B1 storage helpers. The
// marker/DEK fixture stands in for B3 activation (realistic shapes, migration
// context trusted-internal) so repos can be validated independently.
async function establishEncryption(adapter, workspaces) {
  const { loadMasterKey, deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
  const { encryptBytes, buildHashKeyWrapAad } = await import("@/lib/security/envelope.js");
  const { createMigrationContext, ensureWorkspaceDekSync, clearCredentialCache } = await import(
    "@/lib/db/helpers/credentialStorage.js"
  );
  const root = await loadMasterKey({ create: true });
  const set = (key, value) =>
    adapter.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  set("credentialsEncryptedVersion", "1");
  set("credentialsKekKid", root.kid);
  // Presence-shape placeholder: the real activation wraps the derived hash key
  // under the KEK with this AAD (B3 owns the writer).
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
  const mctx = createMigrationContext(adapter, root);
  for (const ws of workspaces) ensureWorkspaceDekSync(adapter, ws, mctx);
  clearCredentialCache(adapter);
  return root;
}

describe("YAN-365 encrypted storage: repos, gateway reads, metadata lists", () => {
  beforeEach(async () => {
    await load("on");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM providerConnections`);
    adapter.run(`DELETE FROM providerNodes`);
    adapter.run(`DELETE FROM workspaceKeys`);
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    await establishEncryption(adapter, [t.shared.id, t.a.personal, t.b.personal]);
  });

  afterAll(async () => {
    // Leave the shared file-level DB legacy for the remaining describes.
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM providerConnections`);
    adapter.run(`DELETE FROM providerNodes`);
    adapter.run(`DELETE FROM workspaceKeys`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped')`,
    );
    const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
    clearCredentialCache(adapter);
  });

  it("writes opaque envelopes and reads them back decrypted", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const c = await db.createConnection(t.a.ctx, t.a.personal, {
      ...apiKeyConn("enc"),
      providerSpecificData: { clientSecret: "psd-secret", planTier: "free", nodeName: "n" },
    });
    const raw = JSON.parse(
      adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data,
    );
    expect(raw.apiKey).toMatchObject({ v: 1, kid: expect.stringMatching(/^dk_/) });
    expect(raw.providerSpecificData.clientSecret).toMatchObject({ v: 1 });
    expect(raw.providerSpecificData.planTier).toBe("free"); // non-covered leaf untouched
    expect(JSON.stringify(raw)).not.toContain("sk-enc");
    expect(JSON.stringify(raw)).not.toContain("psd-secret");
    const got = await db.getConnection(t.a.ctx, c.id);
    expect(got.apiKey).toBe("sk-enc");
    expect(got.providerSpecificData.clientSecret).toBe("psd-secret");
    // OAuth dedup sees decrypted identity metadata on re-login.
    const again = await db.createConnection(t.a.ctx, t.a.personal, {
      provider: "openai",
      authType: "apikey",
      name: "enc",
      apiKey: "sk-enc-2",
    });
    expect(again.id).toBe(c.id);
    expect((await db.getConnection(t.a.ctx, c.id)).apiKey).toBe("sk-enc-2");
  });

  it("updates merge live PSD siblings, honor explicit nulls, reject caller envelopes with zero writes", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const c = await db.createConnection(t.a.ctx, t.a.personal, {
      provider: "claude",
      authType: "oauth",
      email: "enc@x.test",
      accessToken: "at-1",
      refreshToken: "rt-1",
      providerSpecificData: { clientSecret: "s1", copilotToken: "c1", deviceId: "d1" },
    });
    // Delta update: siblings survive, changed key wins.
    await db.updateConnection(t.a.ctx, c.id, { providerSpecificData: { clientSecret: "s2" } });
    expect((await db.getConnection(t.a.ctx, c.id)).providerSpecificData).toMatchObject({
      clientSecret: "s2",
      copilotToken: "c1",
      deviceId: "d1",
    });
    // Stale queued PSD delta does not resurrect old values.
    await db.updateConnection(t.a.ctx, c.id, { providerSpecificData: { deviceId: "d2" } });
    expect((await db.getConnection(t.a.ctx, c.id)).providerSpecificData).toMatchObject({
      clientSecret: "s2",
      copilotToken: "c1",
      deviceId: "d2",
    });
    // Explicit null clears the leaf; other secrets survive.
    await db.updateConnection(t.a.ctx, c.id, { refreshToken: null, accessToken: "at-2" });
    const cleared = await db.getConnection(t.a.ctx, c.id);
    expect(cleared.refreshToken).toBeNull();
    expect(cleared.accessToken).toBe("at-2");
    expect(cleared.providerSpecificData.copilotToken).toBe("c1");
    // A caller-supplied envelope is rejected and writes nothing.
    const before = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data;
    const stolen = JSON.parse(before).providerSpecificData.clientSecret;
    await expect(db.updateConnection(t.a.ctx, c.id, { accessToken: stolen })).rejects.toMatchObject(
      { code: "ENVELOPE_REJECTED" },
    );
    expect(adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data).toBe(
      before,
    );
  });

  it("corrupt or swapped envelopes fail that credential use typed; metadata lists survive", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const { listConnectionsMetadata } = await import("@/lib/db/repos/connectionsRepo.js");
    const mine = await db.createConnection(t.a.ctx, t.a.personal, {
      ...apiKeyConn("mine"),
      providerSpecificData: { cookie: "cookie-1", apiKey: "psd-key" },
    });
    const shared = await db.createConnection(t.a.ctx, t.shared.id, apiKeyConn("team"));
    const read = (id) =>
      JSON.parse(adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [id]).data);
    const write = (id, data) =>
      adapter.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
        JSON.stringify(data),
        id,
      ]);

    // Swap ciphertext across workspaces: the AAD binds row+workspace, so both
    // copies must fail with the same safe typed error.
    const a = read(mine.id);
    const b = read(shared.id);
    const swapped = a.apiKey.ct;
    a.apiKey.ct = b.apiKey.ct;
    b.apiKey.ct = swapped;
    write(mine.id, a);
    write(shared.id, b);
    await expect(db.getConnection(t.a.ctx, mine.id)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
    await expect(db.getConnection(t.a.ctx, shared.id)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });

    // Metadata list never decrypts: the corrupt rows still list with their
    // configured paths intact (dotted PSD included).
    const meta = await listConnectionsMetadata(t.a.ctx, t.a.personal);
    const row = meta.find((x) => x.id === mine.id);
    expect(row.configured).toEqual(
      expect.arrayContaining([
        "apiKey",
        "providerSpecificData.cookie",
        "providerSpecificData.apiKey",
      ]),
    );
    expect(row.apiKey).toBeUndefined();
    expect(row.providerSpecificData.cookie).toBeUndefined();

    // Cross-workspace denial is unchanged under encryption.
    expect(await denied(db.getConnection(t.b.ctx, mine.id))).toBe(true);
  });

  it("routes: metadata-mode provider list stays green over corrupt envelopes and never leaks secrets", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const list = await import("@/app/api/providers/route.js");
    const nodes = await import("@/app/api/provider-nodes/route.js");
    const c = await db.createConnection(t.a.ctx, t.shared.id, {
      ...apiKeyConn("enc-route"),
      providerSpecificData: { copilotToken: "psd-1", baseUrl: "http://up" },
    });
    const n = await db.createNode(t.a.ctx, t.shared.id, {
      id: "openai-compatible-chat-enc1",
      type: "openai-compatible",
      name: "N",
      prefix: "enc1",
      apiType: "chat",
      baseUrl: "http://x",
    });
    await db.updateNode(t.a.ctx, n.id, { apiKey: "node-key" });
    expect(
      JSON.parse(adapter.get(`SELECT data FROM providerNodes WHERE id = ?`, [n.id]).data).apiKey,
    ).toMatchObject({ v: 1 });

    // Corrupt one envelope, then list: HTTP 200 with configured flags.
    const data = JSON.parse(
      adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data,
    );
    data.apiKey.ct = data.apiKey.ct.slice(0, -2) + (data.apiKey.ct.endsWith("A") ? "B" : "A");
    adapter.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
      JSON.stringify(data),
      c.id,
    ]);

    const res = await as(t.a, list.GET, `/api/providers?workspaceId=${t.shared.id}`);
    expect(res.status).toBe(200);
    const { connections } = await res.json();
    const listed = connections.find((x) => x.id === c.id);
    expect(listed.apiKey).toBeUndefined();
    expect(listed.providerSpecificData.copilotToken).toBeUndefined();
    expect(listed.providerSpecificData.baseUrl).toBe("http://up");
    expect(listed.configured).toEqual(
      expect.arrayContaining(["apiKey", "providerSpecificData.copilotToken"]),
    );

    const nres = await as(t.a, nodes.GET, `/api/provider-nodes?workspaceId=${t.shared.id}`);
    expect(nres.status).toBe(200);
    const { nodes: listedNodes } = await nres.json();
    const listedNode = listedNodes.find((x) => x.id === n.id);
    expect(listedNode.apiKey).toBeUndefined();
    expect(listedNode.configured).toContain("apiKey");
    expect(listedNode.baseUrl).toBe("http://x");
  }, 30_000);

  it("a refresh landing between a handler's load and write survives the write (delta PUT)", async () => {
    const c = await db.createConnection(t.a.ctx, t.a.personal, {
      provider: "claude",
      authType: "oauth",
      email: "race@x.test",
      accessToken: "at-1",
      providerSpecificData: { copilotToken: "old", deviceId: "dev", planTier: "free" },
    });
    // The handler loads its view of the row (potentially stale from here on).
    await db.getConnection(t.a.ctx, c.id);
    // A token refresh lands after that load.
    await db.updateConnection(t.a.ctx, c.id, {
      providerSpecificData: { copilotToken: "fresh" },
    });
    // The PUT writes only the keys the client sent; null clears a live key.
    await db.updateConnection(t.a.ctx, c.id, {
      name: "renamed",
      providerSpecificData: { weight: 5, deviceId: null },
    });
    const after = await db.getConnection(t.a.ctx, c.id);
    expect(after.name).toBe("renamed");
    expect(after.providerSpecificData).toMatchObject({ copilotToken: "fresh", planTier: "free" });
    expect(after.providerSpecificData.weight).toBe(5);
    expect(after.providerSpecificData.deviceId).toBeUndefined();
    expect(after.accessToken).toBe("at-1");
  });

  it("raw gateway reads decrypt after SQL scope selection; missing DEKs fail typed with zero writes", async () => {
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const { getGatewayConnections } = await import("@/lib/auth/gatewayResources.js");
    const c = await db.createConnection(t.a.ctx, t.a.personal, apiKeyConn("gw"));
    const principal = Object.freeze({
      workspaceId: t.a.personal,
      via: "apiKey",
      apiKeyId: "ak_test",
    });
    const conns = await getGatewayConnections(principal, { provider: "openai" });
    expect(conns.find((x) => x.id === c.id).apiKey).toBe("sk-gw");
    expect(JSON.stringify(conns)).not.toContain('"data"');

    // A workspace without its key row: runtime writes fail closed and write nothing.
    const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
    adapter.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [t.a.personal]);
    clearCredentialCache(adapter);
    await expect(
      db.updateConnection(t.a.ctx, c.id, { accessToken: "should-not-persist" }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(
      adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data,
    ).not.toContain("should-not-persist");
    await expect(
      db.createConnection(t.a.ctx, t.a.personal, apiKeyConn("nokey")),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(
      adapter.get(
        `SELECT COUNT(*) AS n FROM providerConnections WHERE provider = 'openai' AND workspaceId = ?`,
        [t.a.personal],
      ).n,
    ).toBe(1);
  });
});

describe("YAN-365 established storage with the switch off", () => {
  afterAll(async () => {
    // Leave the shared file-level DB legacy for the remaining describe.
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM providerConnections`);
    adapter.run(`DELETE FROM providerNodes`);
    adapter.run(`DELETE FROM workspaceKeys`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped')`,
    );
    const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
    clearCredentialCache(adapter);
  });

  it("item GET strips every D10 leaf even with a null scope (encrypted established)", async () => {
    await load("off");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM providerConnections`);
    adapter.run(`DELETE FROM providerNodes`);
    adapter.run(`DELETE FROM workspaceKeys`);
    t = await seedTenancy();
    await establishEncryption(adapter, [t.shared.id, t.a.personal, t.b.personal]);
    const c = await db.createConnection(t.a.ctx, t.shared.id, {
      ...apiKeyConn("enc-off"),
      providerSpecificData: {
        cookie: "ck",
        clientSecret: "cs",
        secretAccessKey: "sak",
        mimoPassToken: "mimo",
        firebaseIdToken: "fit",
        idToken: "psd-id",
        copilotToken: "cop",
        apiKey: "psd-key",
        baseUrl: "http://up",
      },
    });
    const item = await import("@/app/api/providers/[id]/route.js");
    const res = await callRoute(item.GET, `/api/providers/${c.id}`, { params: { id: c.id } });
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.apiKey).toBeUndefined();
    expect(connection.accessToken).toBeUndefined();
    for (const key of [
      "cookie",
      "clientSecret",
      "secretAccessKey",
      "mimoPassToken",
      "firebaseIdToken",
      "idToken",
      "copilotToken",
      "apiKey",
    ]) {
      expect(connection.providerSpecificData?.[key]).toBeUndefined();
    }
    expect(connection.providerSpecificData.baseUrl).toBe("http://up");
    // The stored row is still intact (redaction is response-only).
    expect((await db.getConnection(t.a.ctx, c.id)).providerSpecificData.cookie).toBe("ck");
  }, 30_000);
});

describe("switch off: single-user regression", () => {
  it("routes and repos behave as today: unscoped, no owner columns", async () => {
    await load("off");
    const list = await import("@/app/api/providers/route.js");
    const res = await callRoute(list.POST, "/api/providers", {
      method: "POST",
      body: { provider: "openai", apiKey: "sk-off", name: "off" },
    });
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection.workspaceId).toBeUndefined();
    const all = await (await callRoute(list.GET, "/api/providers")).json();
    expect(all.connections.map((c) => c.id)).toContain(connection.id);
    expect(all.connections.every((c) => c.apiKey === undefined)).toBe(true);
  }, 30_000);
});
