// YAN-2014: GET /v1/quota integration tests in hashed storage mode.
// Covers workspace isolation, key lifecycle (revoked/expired/paused/removed-member),
// grants & grantor-email redaction, ToS acknowledgement, allowedModels scoping,
// metadata-only SQL (never selecting providerConnections.data), and fail-closed 503.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn(() => {
  throw new Error("GET /v1/quota must never call upstream fetch");
});
vi.stubGlobal("fetch", fetchMock);

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { clearQuotaSnapshots } from "open-sse/services/quotaSnapshot.js";
import { GET as getV1Quota } from "@/app/api/v1/quota/route.js";
import { proxy as dashboardProxy } from "@/dashboardGuard.js";

const NOW = "2026-11-25T12:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const HASHED_TOKEN = `th_${"Q".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

let db;

function hashedKeyRow(patch = {}) {
  return {
    id: "key-q1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(HASHED_TOKEN),
    hashKid: KID,
    prefix: "th_QQQQ…QQQQ",
    name: "Quota reader key",
    machineId: null,
    legacy: 0,
    isActive: 1,
    revokedAt: null,
    allowedModels: [],
    allowedCombos: [],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...patch,
  };
}

function insertConnection(id, provider, workspaceId, patch = {}) {
  const secretData = {
    accessToken: `secret-access-${id}`,
    refreshToken: `secret-refresh-${id}`,
    apiKey: `secret-apikey-${id}`,
    ...(patch.data || {}),
  };
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      provider,
      patch.authType ?? "oauth",
      patch.name ?? null,
      patch.email ?? null,
      patch.priority ?? 1,
      patch.isActive === false ? 0 : 1,
      JSON.stringify(secretData),
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

function installHashedTable() {
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
}

function remoteRequest(pathname, headers = {}) {
  return new NextRequest(`https://gateway.example.com${pathname}`, {
    method: "GET",
    headers: { host: "gateway.example.com", "x-9r-via-proxy": "1", ...headers },
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  fetchMock.mockClear();
  clearApiKeyPrincipalCache();
  clearQuotaSnapshots();
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await getAdapter();
  for (const t of [
    "connectionGrants",
    "providerConnections",
    "apiKeys",
    "memberships",
    "workspaces",
    "users",
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run(
    "DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  db.run(
    "INSERT INTO users(id, email, instanceRole, status, createdAt, updatedAt) VALUES ('u1','u1@x.test','owner','active',?,?), ('u2','u2@x.test','user','active',?,?)",
    [NOW, NOW, NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES ('w1','Default','shared','u1',?,?), ('w2','Other','personal','u2',?,?)",
    [NOW, NOW, NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES ('w1','u1','owner','manual',?), ('w2','u2','owner','manual',?)",
    [NOW, NOW],
  );
  db.run("INSERT INTO _meta(key, value) VALUES ('defaultWorkspaceId', 'w1')");
  installHashedTable();
  insertHashedApiKeySync(db, hashedKeyRow());
});

afterEach(() => {
  vi.useRealTimers();
  clearApiKeyPrincipalCache();
  clearQuotaSnapshots();
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("GET /v1/quota in hashed storage mode", () => {
  it("scopes accounts to the key's workspace and rejects invalid, revoked, expired, paused, and removed-member keys", async () => {
    insertConnection("w1-claude", "claude", "w1", { name: "claude_itcn" });
    insertConnection("w2-claude", "claude", "w2", { name: "other-tenant-claude" });

    const req = remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` });
    expect((await dashboardProxy(req)).headers.get("x-middleware-next")).toBe("1");
    const res = await getV1Quota(req);
    expect(res.status).toBe(200);
    expect((await res.json()).accounts.map((a) => a.id)).toEqual(["w1-claude"]);

    const badReq = remoteRequest("/v1/quota", { authorization: "Bearer th_invalid" });
    expect((await dashboardProxy(badReq)).status).toBe(401);
    expect((await getV1Quota(badReq)).status).toBe(401);

    db.run("UPDATE apiKeys SET isActive = 0 WHERE id = 'key-q1'");
    expect((await getV1Quota(req)).status).toBe(401);

    db.run("UPDATE apiKeys SET isActive = 1, expiresAt = ? WHERE id = 'key-q1'", [NOW]);
    expect((await getV1Quota(req)).status).toBe(401);

    db.run("UPDATE apiKeys SET expiresAt = NULL, revokedAt = ? WHERE id = 'key-q1'", [NOW]);
    expect((await getV1Quota(req)).status).toBe(401);

    db.run("UPDATE apiKeys SET revokedAt = NULL WHERE id = 'key-q1'");
    expect((await getV1Quota(req)).status).toBe(200);
    db.run("DELETE FROM memberships WHERE workspaceId = 'w1' AND userId = 'u1'");
    expect((await getV1Quota(req)).status).toBe(401);
  });

  it("redacts grantor email and OAuth email-default name on granted connections, never selects data, enforces ToS ack, and drops revoked grants", async () => {
    insertConnection("w1-own", "claude", "w1", { name: "own-claude" });
    insertConnection("w2-shared-null", "groq", "w2", {
      name: null,
      email: "private-grantor@example.com",
      authType: "apikey",
    });
    insertConnection("w2-shared-oauth-email", "claude", "w2", {
      name: "oauth-owner@example.com",
      email: "oauth-owner@example.com",
      authType: "oauth",
    });
    insertConnection("w2-shared-labeled", "claude", "w2", {
      name: "Shared Team Claude",
      email: "hidden-team@example.com",
      authType: "oauth",
    });
    insertConnection("w2-personal-unacked", "claude", "w2", {
      name: "personal-unacked",
      authType: "oauth",
    });
    const ts = Date.parse(NOW);
    db.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, tosAcknowledgedAt, createdAt, revokedAt)
       VALUES ('g1', 'w2-shared-null', 'w1', NULL, NULL, NULL, ?, NULL),
              ('g2', 'w2-shared-oauth-email', 'w1', NULL, NULL, ?, ?, NULL),
              ('g3', 'w2-shared-labeled', 'w1', NULL, NULL, ?, ?, NULL),
              ('g4', 'w2-personal-unacked', 'w1', NULL, NULL, NULL, ?, NULL)`,
      [ts, ts, ts, ts, ts, ts],
    );

    const allSpy = vi.spyOn(db, "all");
    const res1 = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
    const connSql = allSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((s) => s.includes("providerConnections"));
    expect(connSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of connSql) {
      expect(sql).not.toMatch(/SELECT\s+(?:\*|pc\.\*)/i);
      expect(sql).not.toMatch(/\bdata\b/i);
    }
    allSpy.mockRestore();

    expect(res1.status).toBe(200);
    const raw1 = await res1.text();
    expect(raw1).not.toContain("private-grantor@example.com");
    expect(raw1).not.toContain("oauth-owner@example.com");
    expect(raw1).not.toContain("hidden-team@example.com");

    const body1 = JSON.parse(raw1);
    expect(body1.accounts.map((a) => [a.id, a.name])).toEqual([
      ["w1-own", "own-claude"],
      ["w2-shared-null", "w2-shared-null"],
      ["w2-shared-oauth-email", "w2-shared-oauth-email"],
      ["w2-shared-labeled", "Shared Team Claude"],
    ]);

    db.run("UPDATE connectionGrants SET revokedAt = ? WHERE id IN ('g1','g2','g3')", [ts + 1000]);
    const res2 = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
    expect((await res2.json()).accounts.map((a) => a.id)).toEqual(["w1-own"]);
  });

  it("filters accounts to providers in allowedModels (including grant model overlap)", async () => {
    const scopedToken = `th_${"S".repeat(32)}`;
    insertHashedApiKeySync(
      db,
      hashedKeyRow({
        id: "key-scoped",
        keyHash: digest(scopedToken),
        prefix: "th_SSSS…SSSS",
        allowedModels: ["claude/claude-sonnet-4-6"],
      }),
    );
    insertConnection("w1-claude", "claude", "w1", { name: "claude_ry" });
    insertConnection("w1-codex", "codex", "w1", { name: "codex-hidden" });
    insertConnection("w2-claude-opus", "claude", "w2", { name: "shared-opus" });
    insertConnection("w2-claude-sonnet", "claude", "w2", { name: "shared-sonnet" });
    const ts = Date.parse(NOW);
    db.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, tosAcknowledgedAt, createdAt, revokedAt)
       VALUES ('g-opus', 'w2-claude-opus', 'w1', NULL, ?, ?, ?, NULL),
              ('g-sonnet', 'w2-claude-sonnet', 'w1', NULL, ?, ?, ?, NULL)`,
      [
        JSON.stringify(["claude/claude-opus-4-6"]),
        ts,
        ts,
        JSON.stringify(["claude/claude-sonnet-4-6"]),
        ts,
        ts,
      ],
    );

    const res = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${scopedToken}` }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).accounts.map((a) => a.id)).toEqual(["w1-claude", "w2-claude-sonnet"]);
  });

  it("never decrypts providerConnections.data and fails closed (503) when master key is missing", async () => {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES ('w1-enc', 'claude', 'oauth', 'claude_apple', NULL, 1, 1, '{"__enc":true,"corrupt":"blob"}', ?, ?, 'w1', NULL)`,
      [NOW, NOW],
    );

    const okRes = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).accounts).toEqual([
      expect.objectContaining({ id: "w1-enc", name: "claude_apple", provider: "claude" }),
    ]);

    delete process.env.TOKENHOP_MASTER_KEY;
    const failRes = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
    expect(failRes.status).toBe(503);
  });
});
