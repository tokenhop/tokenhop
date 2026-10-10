// YAN-1041: PUT /api/providers/[id] on the SCOPED (multi-user) path. loadScoped
// returns the full row through getConnection (runtime decode, decrypted apiKey),
// so `updateData.apiKey !== existing.apiKey` compares real plaintext keys: a
// re-sent identical key must not clear the lock, a rotated key must.
import { afterAll, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";

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

const lock = {
  reason: "credit_exhausted",
  code: "http_400",
  message: "Upstream reported exhausted credit or spend limit",
  lockedAt: NOW,
  nextProbeAt: NOW,
  lastProbeAt: null,
  lastProbeError: null,
  generation: 11,
};

let adapter;
let t;
let route;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM providerConnections");
  adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, '{}')");
  route = await import("../../src/app/api/providers/[id]/route.js");
  t = await seedTenancy();
}

function seedConn(id, apiKey) {
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt, workspaceId)
     VALUES(?, 'anthropic', 'apikey', ?, 1, ?, ?, ?, ?)`,
    [
      id,
      id,
      JSON.stringify({ apiKey, billingLock: lock, billingLockGeneration: 11 }),
      NOW,
      NOW,
      t.a.personal,
    ],
  );
}

async function putAs(id, body) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: t.a.user.id,
    sv: t.a.user.sessionVersion,
    wid: t.a.ctx.activeWorkspaceId,
  })}`;
  try {
    const res = await callRoute(route.PUT, `/api/providers/${id}`, {
      as: t.a,
      method: "PUT",
      body,
      params: { id },
    });
    return { status: res.status, body: await res.json() };
  } finally {
    jar.cookie = "";
  }
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("scoped PUT key comparison", () => {
  it("getConnection (the scoped load) returns the decrypted apiKey", async () => {
    await load();
    seedConn("sc1", "sk-old-key");
    const { getConnection } = await import("@/lib/db/index.js");
    const row = await getConnection(t.a.ctx, "sc1");
    expect(row.apiKey).toBe("sk-old-key");
    expect(row.billingLock.generation).toBe(11);
  });

  it("re-sending the same key keeps the lock; a rotated key clears it (no key in response)", async () => {
    await load();
    seedConn("sc2", "sk-old-key");
    const same = await putAs("sc2", { apiKey: "sk-old-key" });
    expect(same.status).toBe(200);
    expect(same.body.connection.billingLock?.reason).toBe("credit_exhausted");
    expect(JSON.stringify(same.body)).not.toMatch(/sk-old-key/);

    const rotated = await putAs("sc2", { apiKey: "sk-brand-new-key" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.connection.billingLock ?? null).toBeNull();
    expect(JSON.stringify(rotated.body)).not.toMatch(/sk-brand-new-key|sk-old-key/);
    const { getConnection } = await import("@/lib/db/index.js");
    const after = await getConnection(t.a.ctx, "sc2");
    expect(after.apiKey).toBe("sk-brand-new-key");
    expect(after.billingLock ?? null).toBeNull();
  });
});
