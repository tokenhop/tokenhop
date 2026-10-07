// YAN-369 gateway side of connection grants: own-first union, revocation on the
// next request, grant allowedModels, per-grant rpm 429, no persisted rotation
// writes on granted rows, grantId in usage, legacy path untouched.
import { beforeEach, describe, expect, it } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const NOW = "2026-01-01T00:00:00.000Z";
let db;
let t;

const gw = (workspaceId, userId = null) =>
  Object.freeze({ via: "local", workspaceId, userId, apiKeyId: null });

function conn(id, workspaceId, { provider = "openai", authType = "apikey", priority = 1 } = {}) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId)
     VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      id,
      provider,
      authType,
      id,
      priority,
      JSON.stringify({ apiKey: `sk-${id}` }),
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

function grant(id, connectionId, grantee, patch = {}) {
  db.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, tosAcknowledgedAt, createdAt, revokedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      connectionId,
      grantee.workspaceId ?? null,
      grantee.userId ?? null,
      patch.allowedModels ? JSON.stringify(patch.allowedModels) : null,
      patch.rpm ?? null,
      patch.tpm ?? null,
      patch.tosAcknowledgedAt ?? null,
      Date.now(),
    ],
  );
}

let res;
let auth;
let limiter;

beforeEach(async () => {
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of ["connectionGrants", "usageHistory", "providerConnections"]) {
    db.run(`DELETE FROM ${tbl}`);
  }
  t = await seedTenancy();
  res = await import("@/lib/auth/gatewayResources.js");
  auth = await import("@/sse/services/auth.js");
  limiter = await import("@/sse/services/grantRateLimiter.js");
});

describe("gateway grant resolution", () => {
  it("lists own connections first, then active grants; revocation applies on the next call", async () => {
    conn("own", t.b.personal, { priority: 5 });
    conn("shared-src", t.a.personal, { priority: 0 }); // higher priority, but granted
    grant("g1", "shared-src", { workspaceId: t.b.personal });
    const p = gw(t.b.personal, t.b.user.id);

    const list = await res.getGatewayConnections(p, { provider: "openai", isActive: true });
    expect(list.map((c) => c.id)).toEqual(["own", "shared-src"]);
    expect(list[1]).toMatchObject({ grantId: "g1", grantAllowedModels: null });
    expect(list[0].grantId).toBeUndefined();

    db.run("UPDATE connectionGrants SET revokedAt = ? WHERE id = 'g1'", [Date.now()]);
    const after = await res.getGatewayConnections(p, { provider: "openai", isActive: true });
    expect(after.map((c) => c.id)).toEqual(["own"]);
  });

  it("never resolves an unacknowledged grant on a personal connection", async () => {
    conn("claude-src", t.a.personal, { provider: "claude", authType: "oauth" });
    grant("g1", "claude-src", { workspaceId: t.b.personal });
    const p = gw(t.b.personal);
    expect(await res.getGatewayConnections(p, { provider: "claude" })).toEqual([]);
  });

  it("filters granted candidates by the grant's allowedModels", async () => {
    conn("src", t.a.personal);
    grant("g1", "src", { userId: t.b.user.id }, { allowedModels: ["openai/gpt-5"] });
    const p = gw(t.b.personal, t.b.user.id);
    const ok = await auth.getProviderCredentials("openai", null, "gpt-5", { principal: p });
    expect(ok).toMatchObject({ connectionId: "src", grantId: "g1" });
    const denied = await auth.getProviderCredentials("openai", null, "gpt-4o", { principal: p });
    expect(denied).toBeNull();
  });

  it("enforces grant rpm with the ADR-0007 429 and releases failed attempts", async () => {
    conn("src", t.a.personal);
    grant("g-rpm", "src", { workspaceId: t.b.personal }, { rpm: 1 });
    const p = gw(t.b.personal);
    const first = await auth.getProviderCredentials("openai", null, "gpt-5", { principal: p });
    expect(first.grantId).toBe("g-rpm");
    const second = await auth.getProviderCredentials("openai", null, "gpt-5", { principal: p });
    expect(second.grantRateLimit).toEqual({ limit: "rpm" });
    const r = limiter.grantRateLimitResponse(second.grantRateLimit);
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatchObject({ type: "rate_limit_exceeded", level: "grant" });

    limiter.releaseGrantReservation(first.grantReservation);
    const third = await auth.getProviderCredentials("openai", null, "gpt-5", { principal: p });
    expect(third.grantId).toBe("g-rpm");
  });

  it("does not persist rotation counters on a granted connection", async () => {
    db.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
      JSON.stringify({ fallbackStrategy: "round-robin" }),
    ]);
    conn("src", t.a.personal);
    grant("g1", "src", { workspaceId: t.b.personal });
    await auth.getProviderCredentials("openai", null, "gpt-5", { principal: gw(t.b.personal) });
    const row = db.get("SELECT data FROM providerConnections WHERE id = 'src'");
    expect(row.data).not.toMatch(/lastUsedAt|consecutiveUseCount/);
  });

  it("stores grantId on usage rows", async () => {
    const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
    await saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-5",
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      workspaceId: t.b.personal,
      grantId: "g-usage",
    });
    expect(db.get("SELECT grantId FROM usageHistory").grantId).toBe("g-usage");
  });
});
