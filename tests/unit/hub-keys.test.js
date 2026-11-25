// YAN-2019: read-only usage hub management keys. Real DB (isolated DATA_DIR),
// real hub gate, real dashboardGuard edge. Covers: hashed storage, scope
// enforcement (only the hub read routes), immediate revocation, 401 on a
// missing/wrong/malformed key, gateway keys and sessions never authorize the
// hub, a hub key never authorizes /v1 or the dashboard, rate limits, audit
// rows without the key, the TOKENHOP_USAGE_HUB switch, and the routes.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const ENV = "TOKENHOP_USAGE_HUB";
const saved = process.env[ENV];

let db;
let repo;
let hub;

const HUB_ROUTES = [
  ["GET", "/v0/management/auth-files"],
  ["GET", "/v0/management/auth-files/models?name=a.json"],
  ["POST", "/v0/management/api-call"],
];

function req(path, { method = "GET", bearer, headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (bearer !== undefined) h.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) h.set("content-type", "application/json");
  return new NextRequest(new URL(path, "http://localhost"), {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env[ENV] = "on";
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.run("DELETE FROM hubKeys");
  db.run("DELETE FROM auditEvents");
  repo = await import("@/lib/db/repos/hubKeysRepo.js");
  hub = await import("@/lib/hub/hubAuth.js");
  hub.resetHubAuthState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

// Audit writes are fire-and-forget; let them land before reading.
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("hub key storage", () => {
  it("stores only a SHA-256 hash and a short prefix; the raw key is returned once", async () => {
    const { key, metadata } = await repo.createHubKeyUnscoped({ name: "T3 laptop" });
    expect(key).toMatch(/^thm_[A-Za-z0-9]{32}$/);
    const row = db.get("SELECT * FROM hubKeys WHERE id = ?", [metadata.id]);
    expect(row.keyHash).toBe(repo.hashHubKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.prefix).toBe(`${key.slice(0, 8)}…${key.slice(-4)}`);
    const list = await repo.listHubKeysUnscoped();
    expect(list).toEqual([
      {
        id: metadata.id,
        prefix: row.prefix,
        name: "T3 laptop",
        createdAt: row.createdAt,
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(row.keyHash);
  });

  it("rejects bad names and caps active keys", async () => {
    await expect(repo.createHubKeyUnscoped({ name: "x".repeat(65) })).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(repo.createHubKeyUnscoped({ name: "a\nb" })).rejects.toMatchObject({
      code: "INVALID",
    });
    for (let i = 0; i < repo.MAX_ACTIVE_HUB_KEYS; i++) await repo.createHubKeyUnscoped();
    await expect(repo.createHubKeyUnscoped()).rejects.toMatchObject({ code: "LIMIT" });
  });
});

describe("hub gate (authorizeHubRequest)", () => {
  it("admits a valid key on exactly the hub read routes", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    for (const [method, path] of HUB_ROUTES) {
      const verdict = await hub.authorizeHubRequest(req(path, { method, bearer: key }));
      expect(verdict.ok, `${method} ${path}`).toBe(true);
    }
    // Case never changes the verdict (Next routes case-insensitively).
    expect(
      (await hub.authorizeHubRequest(req("/V0/Management/Auth-Files", { bearer: key }))).ok,
    ).toBe(true);
    expect(
      await hub.authorizeHubRequest(
        req("/v0/management/RESET-QUOTA", { method: "POST", bearer: key }),
      ),
    ).toMatchObject({ status: 403 });
    // The rewritten /api form resolves the same way.
    expect(
      (await hub.authorizeHubRequest(req("/api/v0/management/auth-files", { bearer: key }))).ok,
    ).toBe(true);
  });

  it("rejects every other route and method for a valid key with 403", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    for (const [method, path] of [
      ["POST", "/v0/management/reset-quota"],
      ["POST", "/v0/management/auth-files"],
      ["DELETE", "/v0/management/auth-files"],
      ["GET", "/v0/management/api-call"],
      ["GET", "/v0/management/config"],
      ["PUT", "/v0/management/config"],
      ["GET", "/v0/management"],
      ["GET", "/v0/management/auth-files/models/x"],
    ]) {
      const verdict = await hub.authorizeHubRequest(req(path, { method, bearer: key }));
      expect(verdict, `${method} ${path}`).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("answers 401 for a missing, malformed, wrong or non-Bearer key", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    const path = "/v0/management/auth-files";
    const cases = [
      req(path),
      req(path, { bearer: "" }),
      req(path, { bearer: "thm_short" }),
      req(path, { bearer: `thm_${"A".repeat(32)}` }),
      req(path, { bearer: `${key}x` }),
      req(path, { bearer: key.toLowerCase() }),
      req(path, { headers: { authorization: `Basic ${key}` } }),
      req(path, { headers: { "x-management-key": key } }),
      req(path, { headers: { "x-api-key": key } }),
    ];
    for (const r of cases) {
      expect(await hub.authorizeHubRequest(r)).toMatchObject({
        ok: false,
        status: 401,
        body: { error: "Unauthorized" },
      });
    }
  });

  it("revocation takes effect on the next request", async () => {
    const { key, metadata } = await repo.createHubKeyUnscoped();
    const r = () => req("/v0/management/auth-files", { bearer: key });
    expect((await hub.authorizeHubRequest(r())).ok).toBe(true);
    expect(await repo.revokeHubKeyUnscoped(metadata.id)).toMatchObject({ id: metadata.id });
    expect(await hub.authorizeHubRequest(r())).toMatchObject({ ok: false, status: 401 });
    expect(await repo.listHubKeysUnscoped()).toEqual([]);
    expect(await repo.revokeHubKeyUnscoped(metadata.id)).toBeNull();
  });

  it("is hidden (404) while TOKENHOP_USAGE_HUB is off, even for a valid key", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    for (const value of [undefined, "", "off", "true", "ON"]) {
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      expect(
        await hub.authorizeHubRequest(req("/v0/management/auth-files", { bearer: key })),
      ).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("rate limits failures per IP and requests per key", async () => {
    const path = "/v0/management/auth-files";
    const now = 1_000_000;
    for (let i = 0; i < 30; i++)
      await hub.authorizeHubRequest(req(path, { bearer: "wrong" }), { now });
    const { key } = await repo.createHubKeyUnscoped();
    // Locked out IPs get 429 even with a valid key until the window passes.
    expect(await hub.authorizeHubRequest(req(path, { bearer: key }), { now })).toMatchObject({
      status: 429,
    });
    expect(
      (await hub.authorizeHubRequest(req(path, { bearer: key }), { now: now + 60_000 })).ok,
    ).toBe(true);

    hub.resetHubAuthState();
    let last;
    for (let i = 0; i < 601; i++)
      last = await hub.authorizeHubRequest(req(path, { bearer: key }), { now });
    expect(last).toMatchObject({ ok: false, status: 429 });
  });

  it("audits uses with the key prefix, route and result, never the key", async () => {
    const { key, metadata } = await repo.createHubKeyUnscoped();
    await hub.authorizeHubRequest(req("/v0/management/auth-files", { bearer: key }));
    // A second identical read inside the minute is coalesced.
    await hub.authorizeHubRequest(req("/v0/management/auth-files", { bearer: key }));
    await hub.authorizeHubRequest(
      req("/v0/management/reset-quota", { method: "POST", bearer: key }),
    );
    await hub.authorizeHubRequest(
      req("/v0/management/auth-files", { bearer: `thm_${"Z".repeat(32)}` }),
    );
    await settle();
    const rows = db.all(
      "SELECT action, targetId, after, result, via, ts FROM auditEvents WHERE action = 'hubKey.use' ORDER BY ts, rowid",
    );
    expect(rows.map((r) => [r.targetId, r.result, JSON.parse(r.after)])).toEqual([
      [
        metadata.id,
        "success",
        { keyPrefix: metadata.prefix, method: "GET", path: "/v0/management/auth-files" },
      ],
      [
        metadata.id,
        "denied",
        { keyPrefix: metadata.prefix, method: "POST", path: "/v0/management/reset-quota" },
      ],
      [null, "denied", { method: "GET", path: "/v0/management/auth-files" }],
    ]);
    expect(rows.every((r) => r.via === "hubKey")).toBe(true);
    const everything = JSON.stringify(db.all("SELECT * FROM auditEvents"));
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(key.slice(8, 28));
  });
});

describe("dashboardGuard edge", () => {
  async function proxy(r) {
    return (await import("../../src/dashboardGuard.js")).proxy(r);
  }
  const passed = (res) => res.headers.get("x-middleware-next") === "1";

  it("routes /v0/management through the hub gate in both path forms", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    for (const path of ["/v0/management/auth-files", "/api/v0/management/auth-files"]) {
      expect(passed(await proxy(req(path, { bearer: key }))), path).toBe(true);
      const denied = await proxy(req(path));
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "Unauthorized" });
    }
    expect(
      (await proxy(req("/v0/management/reset-quota", { method: "POST", bearer: key }))).status,
    ).toBe(403);
    // Encoded or dot segments never fall through the hub gate.
    for (const path of [
      "/v0/management/%2e%2e/auth-files",
      "/v0/management/a%2Fb",
      "/api/v0/management/%2e%2e/x",
      "/v0/other",
      "/V0/management/config",
      "/API/V0/management/config",
    ]) {
      expect((await proxy(req(path, { bearer: key }))).status, path).toBe(403);
      expect((await proxy(req(path))).status, path).toBe(401);
    }
  });

  it("a hub key never authorizes the gateway or the dashboard API", async () => {
    const { key } = await repo.createHubKeyUnscoped();
    expect((await proxy(req("/v1/models", { bearer: key }))).status).toBe(401);
    expect(
      (await proxy(req("/api/v1/chat/completions", { method: "POST", bearer: key }))).status,
    ).toBe(401);
    expect((await proxy(req("/api/settings", { bearer: key }))).status).toBe(401);
    expect((await proxy(req("/api/hub-keys", { bearer: key }))).status).toBe(401);
  });

  it("a gateway key, the CLI token and a session never authorize the hub", async () => {
    const { getCliToken } = await import("@/lib/auth/cliToken.js");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    db.run("DELETE FROM apiKeys");
    db.run(
      `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('gw', 'sk-gateway-raw-0123456789', 'k', 1, ?)`,
      [new Date().toISOString()],
    );
    const path = "/v0/management/auth-files";
    expect((await proxy(req(path, { bearer: "sk-gateway-raw-0123456789" }))).status).toBe(401);
    expect(
      (await proxy(req(path, { headers: { "x-tokenhop-cli-token": await getCliToken() } }))).status,
    ).toBe(401);
    const cookie = `auth_token=${await createDashboardAuthToken({})}`;
    expect((await proxy(req(path, { headers: { cookie } }))).status).toBe(401);
  });
});

describe("hub key management routes", () => {
  const routes = async () => ({
    list: await import("@/app/api/hub-keys/route.js"),
    item: await import("@/app/api/hub-keys/[id]/route.js"),
  });

  it("creates (key shown once), lists metadata only and revokes", async () => {
    const { list, item } = await routes();
    const created = await list.POST(req("/api/hub-keys", { method: "POST", body: { name: "T3" } }));
    expect(created.status).toBe(201);
    const { key, metadata } = await created.json();
    expect(key).toMatch(/^thm_/);
    const listed = await (await list.GET(req("/api/hub-keys"))).json();
    expect(listed.keys).toEqual([expect.objectContaining({ id: metadata.id, name: "T3" })]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const del = await item.DELETE(req(`/api/hub-keys/${metadata.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: metadata.id }),
    });
    expect(del.status).toBe(200);
    expect(
      await hub.authorizeHubRequest(req("/v0/management/auth-files", { bearer: key })),
    ).toMatchObject({ status: 401 });
    const again = await item.DELETE(req(`/api/hub-keys/${metadata.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: metadata.id }),
    });
    expect(again.status).toBe(404);
    await settle();
    const actions = db
      .all("SELECT action, after, before FROM auditEvents WHERE action LIKE 'hubKey.%'")
      .map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["hubKey.create", "hubKey.revoke"]));
    expect(JSON.stringify(db.all("SELECT * FROM auditEvents"))).not.toContain(key);
  });

  it("refuses credentials, bad bodies, and hides while the hub is off", async () => {
    const { list } = await routes();
    const { key } = await repo.createHubKeyUnscoped();
    expect((await list.GET(req("/api/hub-keys", { bearer: key }))).status).toBe(401);
    expect(
      (await list.GET(req("/api/hub-keys", { headers: { "x-api-key": "sk-x" } }))).status,
    ).toBe(401);
    expect(
      (await list.POST(req("/api/hub-keys", { method: "POST", body: { name: "a", extra: 1 } })))
        .status,
    ).toBe(400);
    expect(
      (await list.POST(req("/api/hub-keys", { method: "POST", body: { name: 7 } }))).status,
    ).toBe(400);
    process.env[ENV] = "off";
    expect((await list.GET(req("/api/hub-keys"))).status).toBe(404);
  });
});
