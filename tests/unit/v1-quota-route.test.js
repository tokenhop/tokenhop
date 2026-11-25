// YAN-2014: GET /v1/quota integration tests against real SQLite + dashboardGuard.
// Verifies remote API-key admission (never 403 LOCAL_ONLY), legacy & hashed key
// lifecycle (revoked/expired/paused/removed-member), workspace isolation, grants
// (including H1 OAuth grantor-email redaction & ToS ack), allowedModels scoping,
// zero secret leakage, zero credential decryption, and zero upstream fetches.
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
import {
  clearQuotaSnapshots,
  recordHeaderWindows,
  recordProbeWindows,
} from "open-sse/services/quotaSnapshot.js";
import { recordUsageSnapshot } from "@/sse/services/quotaSnapshotSync.js";
import { GET as getV1Quota, OPTIONS as optionsV1Quota } from "@/app/api/v1/quota/route.js";
import { proxy as dashboardProxy } from "@/dashboardGuard.js";
import { resolveRoutePolicy } from "@/lib/auth/routePolicy.js";

const NOW = "2026-11-25T12:00:00.000Z";
const RESET_5H = "2026-11-25T17:00:00.000Z";
const RESET_7D = "2026-12-02T00:00:00.000Z";
const RESET_MONTH = "2026-12-01T00:00:00.000Z";

const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const HASHED_TOKEN = `th_${"Q".repeat(32)}`;
const LEGACY_TOKEN = `sk-legacy-${"L".repeat(24)}`;
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
    idToken: `secret-id-${id}`,
    apiKey: `secret-apikey-${id}`,
    providerSpecificData: {
      cookie: `secret-cookie-${id}`,
      copilotToken: `secret-copilot-${id}`,
    },
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

function installLegacyTable() {
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
    isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
}

function setSettings(patch) {
  const cur = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1")?.data || "{}");
  db.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
    JSON.stringify({ ...cur, ...patch }),
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
  setSettings({ requireApiKey: false, requireLogin: true });
});

afterEach(() => {
  vi.useRealTimers();
  clearApiKeyPrincipalCache();
  clearQuotaSnapshots();
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("route policy and CORS for /v1/quota", () => {
  it("maps /v1/quota and /api/v1/quota as gateway routes (never LOCAL_ONLY)", () => {
    for (const p of ["/v1/quota", "/api/v1/quota"]) {
      expect(resolveRoutePolicy(p, "GET")).toMatchObject({
        key: "gateway",
        gateway: true,
        localOnly: false,
        public: false,
      });
    }
  });

  it("answers OPTIONS preflight with explicit Authorization and x-api-key headers", async () => {
    const res = await optionsV1Quota();
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-api-key");
  });
});

describe("GET /v1/quota in legacy storage mode", () => {
  beforeEach(() => {
    installLegacyTable();
    db.run(
      "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('lk1', ?, 'Remote key', 'm1', 1, ?)",
      [LEGACY_TOKEN, NOW],
    );
  });

  it("admits a remote gateway API key through dashboardGuard and returns per-account quota without secrets", async () => {
    insertConnection("c-apple", "claude", null, { name: "claude_apple", priority: 1 });
    insertConnection("c-iot", "claude", null, { name: "claude_iot", priority: 2 });
    insertConnection("c-codex", "codex", null, { name: "codex-main", priority: 1 });
    insertConnection("c-kimi", "kimi", null, { name: "kimi-main", authType: "apikey" });
    insertConnection("c-cursor", "cursor", null, { name: "cursor-pro" });
    insertConnection("c-off", "claude", null, { name: "disabled-acc", isActive: false });

    await recordUsageSnapshot({
      connectionId: "c-apple",
      provider: "claude",
      usage: {
        plan: "Claude Code",
        quotas: {
          "session (5h)": { used: 35, total: 100, remainingPercentage: 65, resetAt: RESET_5H },
          "weekly (7d)": { used: 20, total: 100, remainingPercentage: 80, resetAt: RESET_7D },
          "weekly sonnet (7d)": {
            used: 10,
            total: 100,
            remainingPercentage: 90,
            resetAt: RESET_7D,
          },
        },
      },
      fallbackTier: "default_claude_max_20x",
    });

    recordHeaderWindows(
      "c-codex",
      "codex",
      [
        { kind: "5h", usedFraction: 0.425, resetsAt: RESET_5H },
        { kind: "7d", usedFraction: 0.12, resetsAt: RESET_7D },
      ],
      Date.parse(NOW),
    );

    await recordUsageSnapshot({
      connectionId: "c-kimi",
      provider: "kimi",
      usage: {
        quotas: {
          "5h": { used: 120000, total: 500000, remainingPercentage: 76, resetAt: RESET_5H },
        },
      },
    });

    recordProbeWindows(
      "c-cursor",
      "cursor",
      [{ kind: "month", usedFraction: 0.55, used: 55, limit: 100, resetsAt: RESET_MONTH }],
      { planTier: "pro" },
      Date.parse(NOW),
    );

    const req = remoteRequest("/v1/quota", { authorization: `Bearer ${LEGACY_TOKEN}` });
    const guardRes = await dashboardProxy(req);
    expect(guardRes.status).toBe(200);
    expect(guardRes.headers.get("x-middleware-next")).toBe("1");

    const res = await getV1Quota(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const rawText = await res.text();
    for (const leaked of [
      "secret-access",
      "secret-refresh",
      "secret-id",
      "secret-apikey",
      "secret-cookie",
      "secret-copilot",
      "accessToken",
      "refreshToken",
      "idToken",
      "apiKey",
      "providerSpecificData",
      LEGACY_TOKEN,
    ]) {
      expect(rawText).not.toContain(leaked);
    }

    const body = JSON.parse(rawText);
    expect(body.object).toBe("list");
    expect(body.accounts.map((a) => a.id)).not.toContain("c-off");

    expect(body.accounts.find((a) => a.id === "c-apple")).toEqual({
      id: "c-apple",
      name: "claude_apple",
      provider: "claude",
      planTier: "default_claude_max_20x",
      fiveHour: {
        used: 35,
        limit: 100,
        unit: "provider",
        percentage: 35,
        remainingPercentage: 65,
        nextReset: RESET_5H,
        observedAt: NOW,
      },
      weekly: {
        used: 20,
        limit: 100,
        unit: "provider",
        percentage: 20,
        remainingPercentage: 80,
        nextReset: RESET_7D,
        observedAt: NOW,
      },
      windows: expect.arrayContaining([
        expect.objectContaining({ kind: "5h", used: 35, limit: 100, nextReset: RESET_5H }),
        expect.objectContaining({ kind: "7d", used: 20, limit: 100, nextReset: RESET_7D }),
        expect.objectContaining({
          kind: "model:sonnet",
          used: 10,
          limit: 100,
          nextReset: RESET_7D,
        }),
      ]),
      updatedAt: NOW,
      stale: false,
    });

    expect(body.accounts.find((a) => a.id === "c-iot")).toMatchObject({
      fiveHour: null,
      weekly: null,
      windows: [],
      updatedAt: null,
      stale: true,
    });

    expect(body.accounts.find((a) => a.id === "c-codex").fiveHour).toMatchObject({
      used: 42.5,
      limit: 100,
      unit: "percentage",
      percentage: 42.5,
      remainingPercentage: 57.5,
      nextReset: RESET_5H,
    });

    expect(body.accounts.find((a) => a.id === "c-kimi").fiveHour).toMatchObject({
      used: 120000,
      limit: 500000,
      unit: "provider",
      percentage: 24,
      remainingPercentage: 76,
    });

    expect(body.accounts.find((a) => a.id === "c-cursor").windows).toEqual([
      {
        kind: "month",
        used: 55,
        limit: 100,
        unit: "provider",
        percentage: 55,
        remainingPercentage: 45,
        nextReset: RESET_MONTH,
        observedAt: NOW,
        source: "probe",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters by ?provider= (alias or canonical) and handles prototype keys safely", async () => {
    insertConnection("c-1", "claude", null, { name: "claude_apple" });
    insertConnection("c-2", "codex", null, { name: "codex-1" });

    const byAlias = await getV1Quota(
      remoteRequest("/v1/quota?provider=cc", { "x-api-key": LEGACY_TOKEN }),
    );
    expect(byAlias.status).toBe(200);
    expect((await byAlias.json()).accounts.map((a) => a.id)).toEqual(["c-1"]);

    for (const bad of ["constructor", "__proto__", "toString"]) {
      const res = await getV1Quota(
        remoteRequest(`/v1/quota?provider=${bad}`, { authorization: `Bearer ${LEGACY_TOKEN}` }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).accounts).toEqual([]);
    }
  });

  it("rejects remote requests without a valid API key (401, never LOCAL_ONLY)", async () => {
    const missingGuard = await dashboardProxy(remoteRequest("/v1/quota"));
    expect(missingGuard.status).toBe(401);
    expect((await missingGuard.json()).code).not.toBe("LOCAL_ONLY");

    const badGuard = await dashboardProxy(
      remoteRequest("/v1/quota", { authorization: "Bearer wrong-key" }),
    );
    expect(badGuard.status).toBe(401);

    setSettings({ requireApiKey: true });
    expect((await getV1Quota(remoteRequest("/v1/quota"))).status).toBe(401);
    expect(
      (await getV1Quota(remoteRequest("/v1/quota", { authorization: "Bearer wrong-key" }))).status,
    ).toBe(401);
    expect(
      (await getV1Quota(remoteRequest("/v1/quota", { authorization: `Bearer ${LEGACY_TOKEN}` })))
        .status,
    ).toBe(200);
  });
});

describe("GET /v1/quota in hashed storage mode", () => {
  beforeEach(() => {
    installHashedTable();
    insertHashedApiKeySync(db, hashedKeyRow());
  });

  it("scopes accounts to the key's workspace and rejects invalid, revoked, expired, paused, and removed-member keys", async () => {
    insertConnection("w1-claude", "claude", "w1", { name: "claude_itcn" });
    insertConnection("w2-claude", "claude", "w2", { name: "other-tenant-claude" });

    const req = remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` });
    expect((await dashboardProxy(req)).headers.get("x-middleware-next")).toBe("1");
    const res = await getV1Quota(req);
    expect(res.status).toBe(200);
    expect((await res.json()).accounts.map((a) => a.id)).toEqual(["w1-claude"]);

    // Invalid key
    const badReq = remoteRequest("/v1/quota", { authorization: "Bearer th_invalid" });
    expect((await dashboardProxy(badReq)).status).toBe(401);
    expect((await getV1Quota(badReq)).status).toBe(401);

    // Paused key (isActive = 0) — immediately denied even with warm digest cache
    db.run("UPDATE apiKeys SET isActive = 0 WHERE id = 'key-q1'");
    expect((await getV1Quota(req)).status).toBe(401);

    // Expired key
    db.run("UPDATE apiKeys SET isActive = 1, expiresAt = ? WHERE id = 'key-q1'", [NOW]);
    expect((await getV1Quota(req)).status).toBe(401);

    // Revoked key
    db.run("UPDATE apiKeys SET expiresAt = NULL, revokedAt = ? WHERE id = 'key-q1'", [NOW]);
    expect((await getV1Quota(req)).status).toBe(401);

    // Removed workspace membership revokes user-key eligibility live
    db.run("UPDATE apiKeys SET revokedAt = NULL WHERE id = 'key-q1'");
    expect((await getV1Quota(req)).status).toBe(200);
    db.run("DELETE FROM memberships WHERE workspaceId = 'w1' AND userId = 'u1'");
    expect((await getV1Quota(req)).status).toBe(401);
  });

  it("redacts grantor email and OAuth email-default name on granted connections, enforces ToS ack, and drops revoked grants", async () => {
    insertConnection("w1-own", "claude", "w1", { name: "own-claude" });
    insertConnection("w2-shared-null", "groq", "w2", {
      name: null,
      email: "private-grantor@example.com",
      authType: "apikey",
    });
    // OAuth connection whose default `name` is the grantor's email (H1 regression test).
    insertConnection("w2-shared-oauth-email", "claude", "w2", {
      name: "oauth-owner@example.com",
      email: "oauth-owner@example.com",
      authType: "oauth",
    });
    // Granted OAuth connection with an explicit non-email label keeps its label.
    insertConnection("w2-shared-labeled", "claude", "w2", {
      name: "Shared Team Claude",
      email: "hidden-team@example.com",
      authType: "oauth",
    });
    // Personal subscription without ToS ack must stay excluded.
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

    const res1 = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
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

    // Missing/unreadable master key -> 503 fail-closed (never legacy fallback).
    delete process.env.TOKENHOP_MASTER_KEY;
    const failRes = await getV1Quota(
      remoteRequest("/v1/quota", { authorization: `Bearer ${HASHED_TOKEN}` }),
    );
    expect(failRes.status).toBe(503);
  });
});
