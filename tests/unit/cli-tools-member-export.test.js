// YAN-374: members export CLI tool configs (builders + their own key); the host
// writers stay host-only. Multi-user ON, real DB, real dashboardGuard + session
// principals (no guard mocks), same harness shape as gateway-key-routes.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTE_POLICY } from "@/lib/auth/routePolicy";

const ENV = "TOKENHOP_MULTI_USER";
const saved = {
  switch: process.env[ENV],
  peer: process.env.TOKENHOP_PEER_TOKEN,
  master: process.env.TOKENHOP_MASTER_KEY,
};
process.env.TOKENHOP_PEER_TOKEN = "peer-token-yan-374";
const PEER = process.env.TOKENHOP_PEER_TOKEN;

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const SHARED = "shared";
const OTHER = "other";
const API = path.resolve(import.meta.dirname, "../../src/app/api");
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// Host-only surface, derived from the policy table so a new row can't drift out:
// every /api/cli-tools/* row plus the settings store, presets and tunnel status.
const HOST_ROWS = [
  ...Object.keys(ROUTE_POLICY).filter((k) => k.startsWith("/api/cli-tools/")),
  "/api/cli-tool-settings",
  "/api/cli-tool-settings/[toolId]",
  "/api/cli-tool-presets",
  "/api/tunnel/status",
];

// Methods each route file exports (same extraction as route-policy.test.js).
function methodsOf(row) {
  const src = fs.readFileSync(path.join(API, row.replace(/^\/api\//, ""), "route.js"), "utf8");
  const exported = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/g)) {
    exported.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const n of m[1].split(","))
      exported.add(
        n
          .trim()
          .split(/\s+as\s+/)
          .pop(),
      );
  }
  return HTTP.filter((x) => exported.has(x));
}
const ENDPOINTS = HOST_ROWS.flatMap((row) =>
  methodsOf(row).map((method) => ({
    row,
    method,
    url: row.replace("[toolId]", "claude"),
    // The owner reaches it remotely only when the row is not localOnly or remoteMethods lifts it.
    remoteOwner:
      !ROUTE_POLICY[row].localOnly || Boolean(ROUTE_POLICY[row].remoteMethods?.includes(method)),
  })),
);

let db;
let jwt;
let cliToken;
let proxy;
let keys;
let NextRequest;
let seeded;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  jwt = await import("@/lib/auth/dashboardSession.js");
  cliToken = await import("@/lib/auth/cliToken.js");
  keys = await import("@/lib/users/apiKeyManagement.js");
  proxy = (await import("../../src/dashboardGuard.js")).proxy;
  ({ NextRequest } = await import("next/server"));
}

async function seed() {
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  const users = await import("@/lib/db/index.js");
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  for (const t of ["memberships", "identities", "workspaces", "users"]) db.run(`DELETE FROM ${t}`);
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  await (await import("@/lib/users/bootstrap.js")).ensureOwnerBootstrap();
  db.run("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE instanceRole = 'owner'", [
    "$2b$10$maUNk5tLUAmdidX5dRsQKueBpGd3eSvGPVmLbLoQVUk2tx5GEHqNK",
  ]);
  globalThis.__tokenhopSessionCache?.clear();
  const owner = await users.getOwnerUnscoped();
  const member = await users.createUserUnscoped({ email: "m@export.test", instanceRole: "user" });
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
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, 'Other', 'shared', ?, ?)",
    [OTHER, NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES (?, ?, 'manager', ?)",
    [OTHER, owner.id, NOW],
  );
  const personalId = db.get(
    `SELECT w.id AS id FROM workspaces w JOIN memberships m ON m.workspaceId = w.id
     WHERE m.userId = ? AND w.kind = 'personal'`,
    [member.id],
  ).id;
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
    [masterKeyId(MASTER)],
  );
  const ctx = (id, role, ws) => ({
    userId: id,
    instanceRole: role,
    workspaceIds: [ws],
    workspaceRoles: { [ws]: role === "owner" ? "manager" : "member" },
    via: "session",
  });
  return {
    ownerId: owner.id,
    memberId: member.id,
    personalId,
    ownerCtx: ctx(owner.id, "owner", SHARED),
    memberCtx: ctx(member.id, "user", SHARED),
  };
}

const sessionCookie = async (userId) =>
  `auth_token=${await jwt.createDashboardAuthToken({
    sub: userId,
    sv: db.get("SELECT sessionVersion AS sv FROM users WHERE id = ?", [userId]).sv,
    wid: SHARED,
  })}`;
const LOCAL = { "x-9r-peer-token": PEER, "x-9r-real-ip": "127.0.0.1" };
const REMOTE = { "x-9r-peer-token": PEER, "x-9r-real-ip": "203.0.113.7" };

async function call(path, method, userId, peer = LOCAL) {
  const headers = new Headers(peer);
  if (userId) headers.set("cookie", await sessionCookie(userId));
  return proxy(new NextRequest(new URL(path, "http://localhost"), { method, headers }));
}
async function callKeys(userId, workspaceId, body) {
  const headers = new Headers({ ...REMOTE, "content-type": "application/json" });
  headers.set("cookie", await sessionCookie(userId));
  const url = new URL("http://localhost/api/keys");
  url.searchParams.set("workspaceId", workspaceId);
  const req = () => new NextRequest(url, { method: "POST", headers, body: JSON.stringify(body) });
  const guard = await proxy(req());
  const route = await import("@/app/api/keys/route.js");
  return { guard, res: await route.POST(req()) };
}
const allowed = (res) => res.headers.get("x-middleware-next") === "1";

afterAll(() => {
  for (const [k, v] of [
    [ENV, saved.switch],
    ["TOKENHOP_PEER_TOKEN", saved.peer],
    ["TOKENHOP_MASTER_KEY", saved.master],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await load();
  seeded = await seed();
});

describe("member vs host-only CLI tool routes (multi-user on)", () => {
  it("covers every host row and its mapped methods", () => {
    const rows = new Set(ENDPOINTS.map((e) => e.row));
    expect([...rows].sort()).toEqual([...new Set(HOST_ROWS)].sort());
    expect(HOST_ROWS.length).toBeGreaterThan(20);
    for (const row of HOST_ROWS) expect(methodsOf(row).length, row).toBeGreaterThan(0);
    // Under /api/cli-tools only the remoteMethods rows are remote-capable for the owner.
    const remote = ENDPOINTS.filter((e) => e.row.startsWith("/api/cli-tools/") && e.remoteOwner);
    expect(remote.map((e) => `${e.method} ${e.row}`).sort()).toEqual([
      "GET /api/cli-tools/antigravity-mitm/alias",
      "GET /api/cli-tools/cowork-mcp-registry",
      "PUT /api/cli-tools/antigravity-mitm/alias",
    ]);
  });

  it("denies a member every host route and mapped method, locally and remotely", async () => {
    for (const { method, url } of ENDPOINTS) {
      for (const peer of [LOCAL, REMOTE]) {
        const res = await call(url, method, seeded.memberId, peer);
        expect(res.status, `${method} ${url} ${peer === LOCAL ? "local" : "remote"}`).toBe(403);
      }
    }
  });

  it("member in only their personal + shared workspaces creates their own key end-to-end", async () => {
    // Not a member of Default: scoped admits keys.create in ANY own workspace.
    for (const ws of [SHARED, seeded.personalId]) {
      const { guard, res } = await callKeys(seeded.memberId, ws, { name: "cli" });
      expect(allowed(guard), ws).toBe(true);
      expect(res.status, ws).toBe(201);
      const body = await res.json();
      expect(body.key).toMatch(/^th_/);
      expect(body.metadata).toMatchObject({ userId: seeded.memberId, type: "user" });
      expect(db.get("SELECT workspaceId FROM apiKeys WHERE id = ?", [body.id]).workspaceId).toBe(
        ws,
      );
    }
  });

  it("rejects POST /api/keys for a workspace the member is not in", async () => {
    // liveAccess: non-membership is NOT_FOUND, deliberately indistinguishable
    // from a missing workspace — no cross-workspace existence leak (404, not 403).
    const { guard, res } = await callKeys(seeded.memberId, OTHER, { name: "sneaky" });
    expect(allowed(guard)).toBe(true); // edge is any-workspace by design
    expect(res.status).toBe(404); // non-membership is deliberately indistinguishable from not found
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys WHERE workspaceId = ?", [OTHER]).n).toBe(0);
  });

  it("rejects a member minting a service key or a key for another user", async () => {
    const svc = await callKeys(seeded.memberId, SHARED, { name: "s", type: "service" });
    expect(svc.res.status).toBe(403);
    const other = await callKeys(seeded.memberId, SHARED, { name: "o", userId: seeded.ownerId });
    expect(other.res.status).toBe(403);
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(0);
  });

  it("lets the owner use every host route and mapped method locally", async () => {
    for (const { method, url } of ENDPOINTS) {
      const res = await call(url, method, seeded.ownerId);
      expect(allowed(res), `${method} ${url} → ${res.status}`).toBe(true);
    }
  });

  it("lets the owner reach a host row remotely only when it is not localOnly or remoteMethods lifts it", async () => {
    for (const { method, url, remoteOwner } of ENDPOINTS) {
      const res = await call(url, method, seeded.ownerId, REMOTE);
      expect(allowed(res), `${method} ${url} remote → ${res.status}`).toBe(remoteOwner);
      if (!remoteOwner) expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it("lets the owner CLI token (direct loopback) use a writer", async () => {
    const headers = new Headers({
      ...LOCAL,
      [cliToken.CLI_TOKEN_HEADER]: await cliToken.getCliToken(),
    });
    const req = new NextRequest(new URL("/api/cli-tools/claude-settings", "http://localhost"), {
      method: "POST",
      headers,
    });
    expect(allowed(await proxy(req))).toBe(true);
  });
});

describe("member key export (apiKeyManagement)", () => {
  it("creates a user key owned by the member, never for another user", async () => {
    const { key, metadata } = await keys.createApiKey(seeded.memberCtx, SHARED, {
      type: "user",
      name: "cli",
    });
    expect(metadata).toMatchObject({ userId: seeded.memberId, type: "user" });
    expect(key).toMatch(/^th_/);
    await expect(
      keys.createApiKey(seeded.memberCtx, SHARED, { type: "user", userId: seeded.ownerId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      keys.createApiKey(seeded.memberCtx, SHARED, { type: "service", name: "svc" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists only the member's own keys and never a raw key", async () => {
    const own = await keys.createApiKey(seeded.memberCtx, SHARED, { type: "user", name: "mine" });
    const other = await keys.createApiKey(seeded.ownerCtx, SHARED, {
      type: "user",
      name: "owner-key",
    });
    await keys.createApiKey(seeded.ownerCtx, SHARED, { type: "service", name: "svc" });
    const list = await keys.listApiKeys(seeded.memberCtx, SHARED);
    expect(list.map((k) => k.id)).toEqual([own.metadata.id]);
    expect(list.map((k) => k.id)).not.toContain(other.metadata.id);
    const text = JSON.stringify(list);
    expect(text).not.toContain(own.key);
    expect(text).not.toContain(other.key);
    for (const field of ["key", "keyHash", "hashKid"]) expect(list[0]).not.toHaveProperty(field);
  });
});

describe("manual export key selection", () => {
  it("hashed storage with no pasted key yields the placeholder, never a stored key", async () => {
    const { manualApiKey, API_KEY_PLACEHOLDER } = await import("@/lib/cliToolConfigs/shared.js");
    const stored = [{ key: "th_someone_elses_key" }];
    expect(manualApiKey(undefined, stored, false, { hashed: true })).toBe(API_KEY_PLACEHOLDER);
    expect(manualApiKey("  ", stored, false, { hashed: true })).toBe(API_KEY_PLACEHOLDER);
    expect(manualApiKey("th_pasted", stored, false, { hashed: true })).toBe("th_pasted");
  });
});
