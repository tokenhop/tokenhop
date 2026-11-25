// YAN-2014: GET /v1/quota integration tests (route policy, CORS, legacy mode).
// Hashed-mode workspace isolation, grants, and key lifecycle live in
// tests/unit/v1-quota-route-hashed.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn(() => {
  throw new Error("GET /v1/quota must never call upstream fetch");
});
vi.stubGlobal("fetch", fetchMock);

import { getAdapter } from "@/lib/db/driver.js";
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
const LEGACY_TOKEN = `sk-legacy-${"L".repeat(24)}`;

let db;

function insertConnection(id, provider, patch = {}) {
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
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
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
    ],
  );
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
  db = await getAdapter();
  for (const t of ["connectionGrants", "providerConnections", "apiKeys"]) {
    db.run(`DELETE FROM ${t}`);
  }
  installLegacyTable();
  db.run(
    "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('lk1', ?, 'Remote key', 'm1', 1, ?)",
    [LEGACY_TOKEN, NOW],
  );
  setSettings({ requireApiKey: false, requireLogin: true });
});

afterEach(() => {
  vi.useRealTimers();
  clearApiKeyPrincipalCache();
  clearQuotaSnapshots();
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
  it("admits a remote gateway API key through dashboardGuard and returns per-account quota without secrets", async () => {
    insertConnection("c-apple", "claude", { name: "claude_apple", priority: 1 });
    insertConnection("c-iot", "claude", { name: "claude_iot", priority: 2 });
    insertConnection("c-codex", "codex", { name: "codex-main", priority: 1 });
    insertConnection("c-kimi", "kimi", { name: "kimi-main", authType: "apikey" });
    insertConnection("c-cursor", "cursor", { name: "cursor-pro" });
    insertConnection("c-off", "claude", { name: "disabled-acc", isActive: false });

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

    const allSpy = vi.spyOn(db, "all");
    const res = await getV1Quota(req);
    // Legacy metadata read must never select providerConnections.data or SELECT *.
    const connSql = allSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((s) => s.includes("providerConnections"));
    expect(connSql.length).toBeGreaterThan(0);
    for (const sql of connSql) {
      expect(sql).not.toMatch(/SELECT\s+(?:\*|pc\.\*)/i);
      expect(sql).not.toMatch(/\bdata\b/i);
    }
    allSpy.mockRestore();

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
    insertConnection("c-1", "claude", { name: "claude_apple" });
    insertConnection("c-2", "codex", { name: "codex-1" });

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
