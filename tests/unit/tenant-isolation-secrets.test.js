// YAN-378 tenant-isolation audit: seeded sentinel credentials must never leave
// the process on any read surface — JSON read routes (incl. error paths),
// persisted audit rows, console warnings, deep request-log files, and the
// encrypted DB bytes. Sentinels are unique fake values (tests/helpers/
// secretScan.js); a hit means a leak. A reproduced leak is an ordinary FAILING
// test (never it.fails/skip): it blocks commit/PR until the production fix
// lands. Exact sentinels are the primary check; a JWT-shape heuristic is
// added only for responses and log files.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveApiKeyHashKey, hashApiKey } from "@/lib/security/masterKey.js";
import {
  SENT,
  SCAN,
  NO_LEAKS,
  NOW,
  MASTER,
  KID,
  HASHED_KEYS_TABLE,
} from "../helpers/tenantSecretFixture.js";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

import { captureConsole, findSecretLeaks, leakSummary } from "../helpers/secretScan.js";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { env: process.env[ENV], master: process.env.TOKENHOP_MASTER_KEY };
process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");

// Routes that resolve the principal via next/headers (users, workspaces, …)
// need the request cookie visible there; callRoute only sets NextRequest.
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

/** callRoute as a seeded user, with the session cookie visible to next/headers. */
async function callAs(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

afterAll(() => {
  if (saved.env === undefined) delete process.env[ENV];
  else process.env[ENV] = saved.env;
  if (saved.master === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = saved.master;
});

let adapter;
let routes;
let guardProxy;
let NextRequest;
let exportConfig;
let auditFn;

async function load(state = "on") {
  vi.resetModules();
  process.env[ENV] = state;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  routes = {
    providersList: await import("@/app/api/providers/route.js"),
    providersDetail: await import("@/app/api/providers/[id]/route.js"),
    keysList: await import("@/app/api/keys/route.js"),
    keysDetail: await import("@/app/api/keys/[id]/route.js"),
    settings: await import("@/app/api/settings/route.js"),
    configExport: await import("@/app/api/settings/config/export/route.js"),
    usageStats: await import("@/app/api/usage/stats/route.js"),
    auditRead: await import("@/app/api/audit/route.js"),
    users: await import("@/app/api/users/route.js"),
    userDetail: await import("@/app/api/users/[id]/route.js"),
    workspaces: await import("@/app/api/workspaces/route.js"),
  };
  ({ proxy: guardProxy } = await import("@/dashboardGuard.js"));
  ({ exportConfig } = await import("@/lib/db/configExport.js"));
  ({ audit: auditFn } = await import("@/lib/users/audit.js"));
  ({ NextRequest } = await import("next/server"));
}

const expectClean = (subject, label) => {
  const leaks = findSecretLeaks(subject, { sentinels: SCAN, shapes: ["jwt"] });
  expect(leakSummary(leaks), `${label}: ${NO_LEAKS}`).toBe("");
};

// ─── 1. Read-route JSON responses ─────────────────────────────────────────

describe("read-route JSON responses", () => {
  let t;

  beforeEach(async () => {
    await load("on");
    for (const tbl of ["connectionGrants", "auditEvents", "providerConnections"]) {
      adapter.run(`DELETE FROM ${tbl}`);
    }
    adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
      JSON.stringify({
        oidcClientSecret: SENT.password,
        samlPrivateKey: SENT.hexHash,
        displayName: "Instance",
      }),
    ]);
    adapter.run(
      "INSERT OR REPLACE INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
      [KID],
    );
    adapter.exec("DROP TABLE IF EXISTS apiKeys");
    adapter.exec(HASHED_KEYS_TABLE);
    t = await seedTenancy();
    for (const [id, ws] of [
      ["conn-personal", t.a.personal],
      ["conn-shared", t.shared.id],
    ]) {
      adapter.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
         VALUES(?, 'openai', 'apikey', ?, 'owner@secret.test', 1, ?, ?, ?, ?, ?)`,
        [
          id,
          id,
          JSON.stringify({
            apiKey: SENT.connectionApiKey,
            accessToken: SENT.oauthAccessToken,
            refreshToken: SENT.oauthRefreshToken,
            providerSpecificData: { cookie: SENT.password, apiKey: SENT.base64Hash },
          }),
          NOW,
          NOW,
          ws,
          t.a.user.id,
        ],
      );
    }
    adapter.run(
      `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
       VALUES('key-shared', ?, ?, ?, ?, ?, 'sk-se', 'Runner', 1, 1, '[]', ?)`,
      [
        t.shared.id,
        t.a.user.id,
        t.a.user.id,
        hashApiKey(SENT.gatewayKey, deriveApiKeyHashKey(MASTER)),
        KID,
        NOW,
      ],
    );
  });

  const readDefs = [
    {
      name: "providers list",
      route: () => routes.providersList,
      url: () => `/api/providers?workspaceId=${t.shared.id}`,
    },
    {
      name: "connection detail",
      route: () => routes.providersDetail,
      url: () => "/api/providers/conn-shared",
      params: () => ({ id: "conn-shared" }),
    },
    {
      name: "keys list",
      route: () => routes.keysList,
      url: () => `/api/keys?workspaceId=${t.shared.id}`,
    },
    {
      name: "key detail",
      route: () => routes.keysDetail,
      url: () => `/api/keys/key-shared?workspaceId=${t.shared.id}`,
      params: () => ({ id: "key-shared" }),
    },
    { name: "settings", route: () => routes.settings, url: () => "/api/settings" },
    {
      name: "usage stats",
      route: () => routes.usageStats,
      url: () => `/api/usage/stats?workspaceId=${t.shared.id}`,
    },
    {
      name: "audit read",
      route: () => routes.auditRead,
      url: () => `/api/audit?workspaceId=${t.shared.id}`,
    },
    { name: "users list", route: () => routes.users, url: () => "/api/users" },
    {
      name: "user detail",
      route: () => routes.userDetail,
      url: () => `/api/users/${t.b.user.id}`,
      params: () => ({ id: t.b.user.id }),
    },
    { name: "workspaces list", route: () => routes.workspaces, url: () => "/api/workspaces" },
  ];

  for (const def of readDefs) {
    it(`redacts credential values in ${def.name} responses`, async () => {
      const res = await callAs(t.a, def.route().GET, def.url(), {
        params: def.params?.(),
      });
      expect(res.status, `${def.name} status`).toBe(200);
      expectClean(await res.text(), def.name);
    });

    it(`redacts credential values in ${def.name} error responses`, async () => {
      const res = await callRoute(def.route().GET, def.url(), {
        apiKey: SENT.oauthAccessToken,
        params: def.params?.(),
      });
      expect(res.status, `${def.name} error-path status`).toBeGreaterThanOrEqual(400);
      expectClean(await res.text(), `${def.name} error path`);
    });
  }

  it("redacts credential values in export metadata", async () => {
    expectClean(await exportConfig(), "export metadata document");
    const res = await callRoute(routes.configExport.GET, "/api/settings/config/export", {
      apiKey: SENT.oauthAccessToken,
    });
    expect(res.status).toBe(401);
    expectClean(await res.text(), "export metadata error path");
  });

  it("redacts credential values in guard-denied responses", async () => {
    const req = new NextRequest(
      new URL(`/api/providers/${SENT.oauthAccessToken}`, "http://localhost"),
      { headers: { authorization: `Bearer ${SENT.gatewayKey}` } },
    );
    const res = await guardProxy(req);
    expect(res.status).toBe(401);
    expectClean(await res.text(), "guard-denied response");
  });
});

// ─── 2. Audit rows + console warnings ─────────────────────────────────────

describe("audit persistence and console output", () => {
  let t;

  beforeEach(async () => {
    await load("on");
    adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, '{}')");
    t = await seedTenancy();
    adapter.run("DELETE FROM auditEvents");
  });

  const auditRows = () => adapter.all("SELECT * FROM auditEvents");
  const scanRows = () => findSecretLeaks(auditRows(), { sentinels: SCAN, shapes: ["jwt"] });

  it("redacts credential values in audit snapshots", async () => {
    await auditFn(
      { principal: { userId: t.a.user.id, via: "session" }, ip: "127.0.0.1" },
      "settings.update",
      { type: "settings" },
      {
        before: {
          accessToken: SENT.oauthAccessToken,
          apiKey: SENT.connectionApiKey,
          password: SENT.password,
          oidcClientSecret: SENT.password,
        },
        after: { name: "plain-name" },
      },
    );
    expect(auditRows()).toHaveLength(1);
    expect(JSON.parse(auditRows()[0].after).name).toBe("plain-name");
    expect(leakSummary(scanRows()), `audit snapshots: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in permitted audit string fields", async () => {
    await auditFn(
      { principal: { userId: t.a.user.id, via: "session" } },
      "settings.update",
      { type: "settings" },
      {
        after: {
          name: SENT.connectionApiKey,
          reason: SENT.oauthRefreshToken,
          email: SENT.password,
        },
      },
    );
    expect(leakSummary(scanRows()), `permitted audit fields: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in audit target ids", async () => {
    await auditFn({ principal: { userId: t.a.user.id, via: "session" } }, "auth.denied", {
      type: "route",
      id: `GET /api/x/${SENT.oauthAccessToken}`,
    });
    expect(auditRows()).toHaveLength(1);
    expect(leakSummary(scanRows()), `audit target ids: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in the denied route path", async () => {
    const req = new NextRequest(
      new URL(`/api/providers/${SENT.oauthAccessToken}`, "http://localhost"),
      { headers: { authorization: `Bearer ${SENT.gatewayKey}` } },
    );
    const res = await guardProxy(req);
    expect(res.status).toBe(401);
    expect(auditRows().length).toBeGreaterThan(0);
    expect(leakSummary(scanRows()), `denied route path: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in audit error messages", async () => {
    await auditFn(
      { principal: { userId: t.a.user.id, via: "session" } },
      "workspace.export",
      { type: "workspace", id: "ws-x" },
      { result: "failure", after: { reason: `decrypt failed: ${SENT.connectionApiKey}` } },
    );
    expect(leakSummary(scanRows()), `audit error messages: ${NO_LEAKS}`).toBe("");
  });

  it("redacts credential values in audit read responses", async () => {
    await auditFn({}, "auth.denied", {
      type: "route",
      id: `GET /api/x/${SENT.oauthAccessToken}`,
    });
    const res = await callAs(t.a, routes.auditRead.GET, "/api/audit");
    expect(res.status).toBe(200);
    expectClean(await res.text(), "audit read response");
  });

  it("console warnings redact secret-bearing insertion failures", async () => {
    const cap = captureConsole("warn");
    const run = vi.spyOn(adapter, "run").mockImplementation(() => {
      throw new Error(`insert failed for ${SENT.oauthAccessToken}`);
    });
    try {
      await auditFn({ principal: { userId: "u1", via: "session" } }, "auth.denied", {
        type: "route",
        id: `GET /api/x/${SENT.oauthAccessToken}`,
      });
      expect(run).toHaveBeenCalled();
    } finally {
      cap.restore();
      run.mockRestore();
    }
    expect(cap.lines.join("\n")).toContain("insert failed for [REDACTED]");
    expectClean(cap.lines.join("\n"), "audit console warnings");
  });

  it("redacts historical audit response copies without changing stored rows", async () => {
    adapter.run(
      `INSERT INTO auditEvents(id, ts, action, targetId, before, after, ip) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        "historical",
        NOW,
        "auth.denied",
        SENT.oauthAccessToken,
        JSON.stringify({ name: `\\n${SENT.connectionApiKey}` }),
        JSON.stringify({ reason: SENT.bearerJwt }),
        SENT.oauthRefreshToken,
      ],
    );
    const raw = adapter.get("SELECT * FROM auditEvents WHERE id = 'historical'");
    expect(raw.targetId).toBe(SENT.oauthAccessToken);
    const res = await callAs(t.a, routes.auditRead.GET, "/api/audit");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.some((row) => row.id === "historical")).toBe(true);
    expectClean(body, "historical audit response");
    expect(adapter.get("SELECT * FROM auditEvents WHERE id = 'historical'")).toEqual(raw);
  });

  // Read-time masking is shape-only: opaque legacy values are documented as
  // unchanged because there is no global lookup of stored secrets.
  it("leaves opaque unshaped historical audit values unchanged", async () => {
    const opaque = "opaque-legacy-history-ZZ55";
    adapter.run(`INSERT INTO auditEvents(id, ts, action, targetId) VALUES(?, ?, ?, ?)`, [
      "opaque-historical",
      NOW,
      "auth.denied",
      opaque,
    ]);
    const res = await callAs(t.a, routes.auditRead.GET, "/api/audit");
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.events.find((r) => r.id === "opaque-historical");
    expect(row.targetId).toBe(opaque);
  });
});
