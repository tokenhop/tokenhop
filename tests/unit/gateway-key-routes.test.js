// YAN-363: /api/keys + /api/keys/[id] routes. Hashed storage: real session and
// CLI principals resolve through resolvePrincipal (switch on, real DB, real
// peer policy), never through the router's own trust. Pristine off (no hashed
// marker, switch off): legacy responses are byte-for-byte today's shape.
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV], peer: process.env.TOKENHOP_PEER_TOKEN };
process.env.TOKENHOP_PEER_TOKEN = "peer-token-yan-363";
const PEER = process.env.TOKENHOP_PEER_TOKEN;

const NOW = "2026-10-03T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const SHARED = "shared";

let db; // adapter
let jwt; // @/lib/auth/dashboardSession
let item; // @/app/api/keys/[id]/route.js
let collection; // @/app/api/keys/route.js
let cliToken; // @/lib/auth/cliToken
let seeded; // { ownerId, memberId }
let NextRequest;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  jwt = await import("@/lib/auth/dashboardSession.js");
  item = await import("@/app/api/keys/[id]/route.js");
  collection = await import("@/app/api/keys/route.js");
  cliToken = await import("@/lib/auth/cliToken.js");
  ({ NextRequest } = await import("next/server"));
}

/** Manager-owner + plain member, one shared workspace, hashed storage live. */
async function seed() {
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  const users = await import("@/lib/db/index.js");
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  for (const t of ["memberships", "identities", "workspaces", "users"]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.run("DELETE FROM _meta WHERE key LIKE 'migrationAcknowledgedWorkspace:%'");
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  const { ensureOwnerBootstrap } = await import("@/lib/users/bootstrap.js");
  await ensureOwnerBootstrap();
  const owner = await users.getOwnerUnscoped();
  const member = await users.createUserUnscoped({ email: "b@keys.test", instanceRole: "user" });
  // Direct hashed fixture (same as gateway-key-management): migrations do not
  // carry the hashed columns yet; the marker below switches storage on.
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, 'Shared', 'shared', ?, ?)",
    [SHARED, NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES (?, ?, 'manager', ?), (?, ?, 'member', ?)",
    [SHARED, owner.id, NOW, SHARED, member.id, NOW],
  );
  // Management validation requires allowedCombos entries to reference real
  // combo IDs; the item-PUT test scopes to combo-1, so seed it via the real
  // combos schema (same fixture shape as gateway-key-management).
  db.run("DELETE FROM combos");
  db.run(
    "INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES ('combo-1', 'Primary combo', '[]', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
    [masterKeyId(MASTER)],
  );
  return { ownerId: owner.id, memberId: member.id };
}

const sessionCookie = async (userId, workspaceId) =>
  `auth_token=${await jwt.createDashboardAuthToken({
    sub: userId,
    sv: db.get("SELECT sessionVersion AS sv FROM users WHERE id = ?", [userId]).sv,
    wid: workspaceId,
  })}`;
const loopbackCli = async () => ({
  [cliToken.CLI_TOKEN_HEADER]: await cliToken.getCliToken(),
  "x-9r-peer-token": PEER,
  "x-9r-real-ip": "127.0.0.1",
});

function callItem(method, id, { cookie, headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  if (body !== undefined) h.set("content-type", "application/json");
  const url = new URL(`http://localhost/api/keys/${id}`);
  url.searchParams.set("workspaceId", SHARED);
  const req = new NextRequest(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return item[method](req, { params: Promise.resolve({ id }) });
}

function callCollection(method, { cookie, headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  if (body !== undefined) h.set("content-type", "application/json");
  const url = new URL("http://localhost/api/keys");
  url.searchParams.set("workspaceId", SHARED);
  const req = new NextRequest(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return collection[method](req);
}

afterAll(() => {
  for (const [k, v] of [
    [ENV, saved.switch],
    ["TOKENHOP_PEER_TOKEN", saved.peer],
    ["TOKENHOP_MASTER_KEY", undefined],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("hashed item routes via CLI token", () => {
  beforeEach(async () => {
    await load("on");
    seeded = await seed();
  });

  it("GET/PUT/DELETE with a valid CLI token from a direct loopback peer succeed", async () => {
    const headers = await loopbackCli();
    const created = await (
      await callCollection("POST", { headers, body: { name: "ci", type: "service" } })
    ).json();
    const id = created.id;

    const got = await callItem("GET", id, { headers });
    expect(got.status).toBe(200);
    const detail = (await got.json()).key;
    expect(detail).toMatchObject({ id, name: "ci", type: "service" });
    for (const field of ["key", "keyHash", "hashKid"]) {
      expect(detail).not.toHaveProperty(field);
    }

    const put = await callItem("PUT", id, { headers, body: { name: "renamed" } });
    expect(put.status).toBe(200);
    expect((await put.json()).key).toMatchObject({ name: "renamed" });

    const del = await callItem("DELETE", id, { headers });
    expect(del.status).toBe(200);
    const tombstone = (await del.json()).key;
    expect(tombstone.revokedAt).toBeTruthy();
    expect(tombstone.revokedAt).toBe(
      (await (await callItem("GET", id, { headers })).json()).key.revokedAt,
    );
  });

  it("an invalid CLI token resolves no principal: 401, not 403", async () => {
    const headers = { [cliToken.CLI_TOKEN_HEADER]: "forged", "x-9r-peer-token": PEER };
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { name: "x" }],
      ["DELETE", undefined],
    ]) {
      const res = await callItem(method, "any", { headers, body });
      expect(res.status, method).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("CLI from a non-loopback or proxied peer is denied, even with a valid token", async () => {
    const remote = {
      [cliToken.CLI_TOKEN_HEADER]: await cliToken.getCliToken(),
      "x-9r-peer-token": PEER,
      "x-9r-real-ip": "203.0.113.7",
    };
    expect((await callItem("GET", "any", { headers: remote })).status).toBe(401);
    const proxied = { ...(await loopbackCli()), "x-9r-via-proxy": "1" };
    expect((await callItem("GET", "any", { headers: proxied })).status).toBe(401);
  });

  it("a gateway bearer is rejected before principal resolution on every item method", async () => {
    const headers = {
      authorization: "Bearer th_anything",
      cookie: await sessionCookie(seeded.ownerId, SHARED),
    };
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await callItem(method, "any", {
        headers,
        body: method === "PUT" ? { name: "x" } : undefined,
      });
      expect(res.status, method).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("cross-workspace: a live member without manage rights cannot touch another workspace's key", async () => {
    const headers = await loopbackCli();
    const created = await (
      await callCollection("POST", { headers, body: { name: "svc", type: "service" } })
    ).json();
    const asB = await sessionCookie(seeded.memberId, SHARED);
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { name: "x" }],
      ["DELETE", undefined],
    ]) {
      const res = await callItem(method, created.id, { cookie: asB, body });
      expect(res.status, method).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
    // The item route never enumerates: list stays the collection's job, and
    // the untouched row proves nothing leaked through the denials.
    const row = db.get("SELECT name, revokedAt FROM apiKeys WHERE id = ?", [created.id]);
    expect(row).toMatchObject({ name: "svc", revokedAt: null });
  });
});

describe("hashed routes via session principal", () => {
  beforeEach(async () => {
    await load("on");
    seeded = await seed();
  });

  it("create returns the raw secret exactly once; every readback is metadata-only", async () => {
    const cookie = await sessionCookie(seeded.ownerId, SHARED);
    const created = await callCollection("POST", {
      cookie,
      body: {
        name: "ci-bot",
        type: "service",
        allowedModels: ["openai/gpt-4o"],
        expiresAt: FUTURE,
      },
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.key).toMatch(/^th_[0-9A-Za-z]{32}$/);
    expect(body.storage).toBe("hashed");
    expect(body.metadata).toMatchObject({
      name: "ci-bot",
      type: "service",
      allowedModels: ["openai/gpt-4o"],
      expiresAt: FUTURE,
    });
    // Raw secret never again: not in metadata readbacks, not in any DB row.
    for (const res of [
      await callItem("GET", body.id, { cookie }),
      await callCollection("GET", { cookie }),
    ]) {
      const text = await res.text();
      expect(text).not.toContain(body.key);
      expect(text).not.toContain("keyHash");
      expect(text).not.toContain("hashKid");
    }
    expect(JSON.stringify(db.all("SELECT * FROM apiKeys"))).not.toContain(body.key);
    // The prefix projection is the only trace.
    const detail = (await (await callItem("GET", body.id, { cookie })).json()).key;
    expect(detail.prefix).toBe(`${body.key.slice(0, 7)}…${body.key.slice(-4)}`);
  });

  it("item PUT/DELETE write the mutable allowlist and the tombstone, read back identically", async () => {
    const cookie = await sessionCookie(seeded.ownerId, SHARED);
    const { id } = await (
      await callCollection("POST", { cookie, body: { name: "svc", type: "service" } })
    ).json();
    const put = await callItem("PUT", id, {
      cookie,
      body: { name: "svc-2", isActive: false, allowedCombos: ["combo-1"], expiresAt: FUTURE },
    });
    expect(put.status).toBe(200);
    const updated = (await put.json()).key;
    expect(updated).toMatchObject({
      name: "svc-2",
      isActive: false,
      allowedCombos: ["combo-1"],
      expiresAt: FUTURE,
    });
    expect((await (await callItem("GET", id, { cookie })).json()).key).toEqual(updated);
    const tombstone = (await (await callItem("DELETE", id, { cookie })).json()).key;
    expect(tombstone.revokedAt).toBeTruthy();
    // Revocation is permanent: reactivation is a 400, never a silent undo.
    const revive = await callItem("PUT", id, { cookie, body: { isActive: true } });
    expect(revive.status).toBe(400);
    expect((await (await callItem("GET", id, { cookie })).json()).key).toMatchObject({
      revokedAt: tombstone.revokedAt,
    });
  });
});

describe("hashed migration acknowledgement via session principal", () => {
  let context;
  beforeEach(async () => {
    await load("on");
    seeded = await seed();
    context = await import("@/app/api/keys/context/route.js");
  });

  const ack = (methodArgs) => callCollection("PATCH", methodArgs);
  const readContext = async ({ cookie, headers = {} } = {}) => {
    const h = new Headers(headers);
    if (cookie) h.set("cookie", cookie);
    const url = new URL("http://localhost/api/keys/context");
    url.searchParams.set("workspaceId", SHARED);
    return context.GET(new NextRequest(url, { method: "GET", headers: h }));
  };

  it("manager ack persists the flag; member read-back flips false→true across modules", async () => {
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    const member = await sessionCookie(seeded.memberId, SHARED);
    expect((await (await readContext({ cookie: member })).json()).migrationAcknowledged).toBe(
      false,
    );
    const res = await ack({ cookie: manager, body: { acknowledgeMigration: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      migrationAcknowledged: true,
      storage: "hashed",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Idempotent: a second ack from a fresh session resolves the same flag.
    const manager2 = await sessionCookie(seeded.ownerId, SHARED);
    expect(
      await (await ack({ cookie: manager2, body: { acknowledgeMigration: true } })).json(),
    ).toEqual({ success: true, migrationAcknowledged: true, storage: "hashed" });
    expect((await (await readContext({ cookie: member })).json()).migrationAcknowledged).toBe(true);
    const raw = db.get(`SELECT value FROM _meta WHERE key = ?`, [
      `migrationAcknowledgedWorkspace:${SHARED}`,
    ]);
    expect(raw?.value).toBe("1");
  });

  it("member ack is 403 and writes nothing; foreign workspace is 404, never leaked", async () => {
    const member = await sessionCookie(seeded.memberId, SHARED);
    const res = await ack({ cookie: member, body: { acknowledgeMigration: true } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(
      db.get(`SELECT value FROM _meta WHERE key = ?`, [`migrationAcknowledgedWorkspace:${SHARED}`]),
    ).toBeFalsy();
    // Explicit unknown workspace keeps the same not-found contract as GET/PUT.
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    const h = new Headers();
    h.set("cookie", manager);
    h.set("content-type", "application/json");
    const url = new URL("http://localhost/api/keys");
    url.searchParams.set("workspaceId", "no-such-workspace");
    const foreign = await collection.PATCH(
      new NextRequest(url, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ acknowledgeMigration: true }),
      }),
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Not found" });
  });

  it("gateway bearer with a manager cookie is 403; CLI token from loopback succeeds", async () => {
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    const bearer = await ack({
      headers: { authorization: "Bearer th_anything" },
      cookie: manager,
      body: { acknowledgeMigration: true },
    });
    expect(bearer.status).toBe(403);
    expect(await bearer.json()).toEqual({ error: "Forbidden" });
    const cli = await ack({ headers: await loopbackCli(), body: { acknowledgeMigration: true } });
    expect(cli.status).toBe(200);
    expect((await (await readContext({ cookie: manager })).json()).migrationAcknowledged).toBe(
      true,
    );
  });

  it("malformed bodies are 400 with no mutation: unknown fields, false, array, empty", async () => {
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    for (const body of [
      { acknowledgeMigration: true, extra: 1 },
      { acknowledgeMigration: false },
      {},
      [],
      { acknowledgeMigration: "yes" },
    ]) {
      const res = await ack({ cookie: manager, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "Bad request" });
    }
    expect(
      db.get(`SELECT value FROM _meta WHERE key = ?`, [`migrationAcknowledgedWorkspace:${SHARED}`]),
    ).toBeFalsy();
  });

  it("missing workspaceId keeps the collection contract: 400", async () => {
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    const h = new Headers();
    h.set("cookie", manager);
    h.set("content-type", "application/json");
    const res = await collection.PATCH(
      new NextRequest(new URL("http://localhost/api/keys"), {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ acknowledgeMigration: true }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId is required" });
  });
});

describe("pristine legacy routes", () => {
  beforeEach(async () => {
    await load("off");
    // Pristine means exactly no hashed marker and no keys, whatever earlier
    // describes in this file's shared DB left behind — including the
    // hashed-schema table this file's own seed creates; the legacy path
    // needs the migration-001 shape back.
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.run("DELETE FROM _meta WHERE key LIKE 'migrationAcknowledgedWorkspace:%'");
    db.exec("DROP TABLE IF EXISTS apiKeys");
    db.exec(
      "CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)",
    );
    db.run("DELETE FROM apiKeys");
  });

  it("pristine legacy PATCH is 405 and GET/POST envelopes keep their exact shape", async () => {
    const res = await callCollection("PATCH", { body: { acknowledgeMigration: true } });
    expect(res.status).toBe(405);
    expect("migrationAcknowledged" in (await res.json())).toBe(false);
  });

  it("keeps the exact legacy response shape with no auth, no hashed marker", async () => {
    const created = await callCollection("POST", { body: { name: "Laptop" } });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(Object.keys(body).sort()).toEqual(["id", "key", "machineId", "name"]);
    expect(body.name).toBe("Laptop");
    expect(typeof body.key).toBe("string");

    const got = await callItem("GET", body.id, {});
    expect(got.status).toBe(200);
    expect((await got.json()).key).toMatchObject({ id: body.id, name: "Laptop", isActive: true });

    const toggled = await callItem("PUT", body.id, { body: { isActive: false } });
    expect(toggled.status).toBe(200);
    expect((await toggled.json()).key).toMatchObject({ name: "Laptop", isActive: false });
    const renamed = await callItem("PUT", body.id, { body: { name: "  Desk  " } });
    expect((await renamed.json()).key.name).toBe("Desk");

    const deleted = await callItem("DELETE", body.id, {});
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ message: "Key deleted successfully" });
    expect((await callItem("GET", body.id, {})).status).toBe(404);
  });
});
