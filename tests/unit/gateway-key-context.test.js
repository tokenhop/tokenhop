// YAN-363: GET /api/keys/context. Real session and CLI principals through
// resolvePrincipal (switch on, real DB, real peer policy). Metadata-only
// envelope: storage/workspaceId/capabilities, never keys, counts or identity.
// Gateway bearers are rejected; foreign workspaces are 404, not leaks.
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV], peer: process.env.TOKENHOP_PEER_TOKEN };
process.env.TOKENHOP_PEER_TOKEN = "peer-token-yan-363-context";
const PEER = process.env.TOKENHOP_PEER_TOKEN;

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const SHARED = "shared";

let db; // adapter
let jwt; // @/lib/auth/dashboardSession
let context; // @/app/api/keys/context/route.js
let cliToken; // @/lib/auth/cliToken
let seeded; // { ownerId, memberId, defaultWorkspaceId, memberPersonalWorkspaceId }
let NextRequest;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  globalThis.__tokenhopSessionCache?.clear();
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  jwt = await import("@/lib/auth/dashboardSession.js");
  context = await import("@/app/api/keys/context/route.js");
  cliToken = await import("@/lib/auth/cliToken.js");
  ({ NextRequest } = await import("next/server"));
}

/** Manager-owner + plain member, one shared workspace, hashed storage live. */
async function seed({ hashedMarker = true } = {}) {
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
  // YAN-358: a hashless bootstrap owner must rotate first; give the fixture
  // owner a real password so its management session is a full one.
  db.run("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE instanceRole = 'owner'", [
    "$2b$10$maUNk5tLUAmdidX5dRsQKueBpGd3eSvGPVmLbLoQVUk2tx5GEHqNK",
  ]);
  globalThis.__tokenhopSessionCache?.clear();
  const owner = await users.getOwnerUnscoped();
  const member = await users.createUserUnscoped({ email: "b@context.test", instanceRole: "user" });
  // Hashed fixture table (migrations do not carry the hashed columns yet);
  // the marker below switches storage on. Context never reads apiKeys rows.
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
  if (hashedMarker) {
    db.run(
      "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
      [masterKeyId(MASTER)],
    );
  }
  return {
    ownerId: owner.id,
    memberId: member.id,
    defaultWorkspaceId: db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`).value,
    memberPersonalWorkspaceId: db.get(
      `SELECT w.id AS id FROM workspaces w JOIN memberships m ON m.workspaceId = w.id
       WHERE m.userId = ? AND w.kind = 'personal'`,
      [member.id],
    ).id,
  };
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

function callContext({ cookie, headers = {}, workspaceId } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  const url = new URL("http://localhost/api/keys/context");
  if (workspaceId !== undefined) url.searchParams.set("workspaceId", workspaceId);
  return context.GET(new NextRequest(url, { method: "GET", headers: h }));
}

const ENVELOPE = [
  "canCreate",
  "canCreateService",
  "canManage",
  "migrationAcknowledged",
  "storage",
  "workspaceId",
];
const LEGACY_ENVELOPE = ["canCreate", "canCreateService", "canManage", "storage", "workspaceId"];

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

describe("hashed context via session principal", () => {
  beforeEach(async () => {
    await load("on");
    seeded = await seed();
  });

  it("manager session: exact no-store envelope, full capabilities", async () => {
    const res = await callContext({ cookie: await sessionCookie(seeded.ownerId, SHARED) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(ENVELOPE);
    expect(body).toEqual({
      storage: "hashed",
      workspaceId: SHARED,
      canCreate: true,
      canManage: true,
      canCreateService: true,
      migrationAcknowledged: false,
    });
  });

  it("member own context: create-only capabilities, no keys or counts", async () => {
    const res = await callContext({ cookie: await sessionCookie(seeded.memberId, SHARED) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(ENVELOPE);
    expect(body).toMatchObject({
      storage: "hashed",
      workspaceId: SHARED,
      canCreate: true,
      canManage: false,
      canCreateService: false,
    });
  });

  it("member explicit authorized selector wins; foreign workspace is 404, never leaked", async () => {
    const own = await callContext({
      cookie: await sessionCookie(seeded.memberId, SHARED),
      workspaceId: seeded.memberPersonalWorkspaceId,
    });
    expect(own.status).toBe(200);
    expect((await own.json()).workspaceId).toBe(seeded.memberPersonalWorkspaceId);

    // The Default workspace exists but the member never joined it.
    const foreign = await callContext({
      cookie: await sessionCookie(seeded.memberId, SHARED),
      workspaceId: seeded.defaultWorkspaceId,
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Not found" });
    expect(foreign.headers.get("cache-control")).toBe("no-store");

    const unknown = await callContext({
      cookie: await sessionCookie(seeded.ownerId, SHARED),
      workspaceId: "no-such-workspace",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Not found" });
  });

  it("migration ack: false before, true after a manager PATCH — members read the same flag", async () => {
    const keys = await import("@/app/api/keys/route.js");
    const manager = await sessionCookie(seeded.ownerId, SHARED);
    const member = await sessionCookie(seeded.memberId, SHARED);
    const read = (cookie) => callContext({ cookie });
    expect((await (await read(member)).json()).migrationAcknowledged).toBe(false);
    const h = new Headers();
    h.set("cookie", manager);
    h.set("content-type", "application/json");
    const url = new URL("http://localhost/api/keys");
    url.searchParams.set("workspaceId", SHARED);
    const patched = await keys.PATCH(
      new NextRequest(url, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ acknowledgeMigration: true }),
      }),
    );
    expect(patched.status).toBe(200);
    for (const cookie of [manager, member]) {
      const res = await read(cookie);
      expect(res.status).toBe(200);
      expect((await res.json()).migrationAcknowledged).toBe(true);
    }
  });

  it("session without a workspace claim falls back to a live personal membership", async () => {
    const res = await callContext({ cookie: await sessionCookie(seeded.memberId) });
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceId).toBe(seeded.memberPersonalWorkspaceId);
  });

  it("roles are re-read live: a demoted-to-viewer cookie reports viewer capabilities", async () => {
    const cookie = await sessionCookie(seeded.memberId, SHARED); // minted while member
    db.run(`UPDATE memberships SET role = 'viewer' WHERE workspaceId = ? AND userId = ?`, [
      SHARED,
      seeded.memberId,
    ]);
    const res = await callContext({ cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspaceId: SHARED,
      canCreate: false,
      canManage: false,
      canCreateService: false,
    });
  });

  it("a disabled user's live session is denied: 401", async () => {
    const cookie = await sessionCookie(seeded.memberId, SHARED);
    const users = await import("@/lib/db/index.js");
    await users.updateUserUnscoped(seeded.memberId, { status: "disabled" });
    const res = await callContext({ cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("a forged session cookie resolves no principal: 401", async () => {
    const res = await callContext({ cookie: "auth_token=forged.token.value" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("a gateway bearer is rejected even alongside a valid session cookie: 403", async () => {
    const res = await callContext({
      cookie: await sessionCookie(seeded.ownerId, SHARED),
      headers: { authorization: "Bearer th_liveordead" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("an invalid storage marker is 503, not a fallback envelope", async () => {
    db.run(`UPDATE _meta SET value = '9' WHERE key = 'apiKeysHashedVersion'`);
    const res = await callContext({ cookie: await sessionCookie(seeded.ownerId, SHARED) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Key storage unavailable" });
  });
});

describe("hashed context via CLI token", () => {
  beforeEach(async () => {
    await load("on");
    seeded = await seed();
  });

  it("direct loopback CLI: the vetted Default workspace, server-side read", async () => {
    const res = await callContext({ headers: await loopbackCli() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(ENVELOPE);
    expect(body).toEqual({
      storage: "hashed",
      workspaceId: seeded.defaultWorkspaceId,
      canCreate: true,
      canManage: true,
      canCreateService: true,
      migrationAcknowledged: false,
    });
  });

  it("a forged CLI token or non-loopback/proxied peer resolves no principal: 401", async () => {
    const forged = { [cliToken.CLI_TOKEN_HEADER]: "forged", "x-9r-peer-token": PEER };
    expect((await callContext({ headers: forged })).status).toBe(401);
    const remote = {
      ...(await loopbackCli()),
      "x-9r-real-ip": "203.0.113.7",
    };
    expect((await callContext({ headers: remote })).status).toBe(401);
    const proxied = { ...(await loopbackCli()), "x-9r-via-proxy": "1" };
    expect((await callContext({ headers: proxied })).status).toBe(401);
  });
});

describe("storage reporting", () => {
  it("switch on without the hashed marker reports legacy, still authenticated", async () => {
    await load("on");
    seeded = await seed({ hashedMarker: false });
    const res = await callContext({ cookie: await sessionCookie(seeded.ownerId, SHARED) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage).toBe("legacy");
    expect(Object.keys(body).sort()).toEqual(LEGACY_ENVELOPE);
    expect("migrationAcknowledged" in body).toBe(false);
  });

  it("pristine switch-off authenticates nobody: 401, no envelope", async () => {
    // Switch off mints no owner, so seed hashed first (same isolated DB),
    // then flip off and drop only the marker — the users stay.
    await load("on");
    seeded = await seed();
    await load("off");
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.run("DELETE FROM _meta WHERE key LIKE 'migrationAcknowledgedWorkspace:%'");
    const res = await callContext({ cookie: await sessionCookie(seeded.ownerId, SHARED) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});
