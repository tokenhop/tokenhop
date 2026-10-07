// YAN-369: connectionGrantsRepo create/list/revoke, XOR CHECK, budgetId
// stored-unwired, gateway reader filtering, migration 015 (idempotent +
// pre-015 DB fixture), resolveSharing classes, assertGrantable matrix.
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

let repo;
let grants;
let db;

const acode = (p) => p.catch((e) => e.code);
const scode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};

const CLEAR = [
  "connectionGrants",
  "providerConnections",
  "auditEvents",
  "memberships",
  "identities",
  "workspaces",
  "users",
];

beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  grants = await import("@/lib/users/grants.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of CLEAR) db.run(`DELETE FROM ${t}`);
});

const NOW = "2026-01-01T00:00:00.000Z";

async function seed({ provider = "openai", authType = "apikey" } = {}) {
  const t = await seedTenancy();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, data, createdAt, updatedAt, workspaceId) VALUES('conn-1', ?, ?, 'C', '{}', ?, ?, ?)`,
    [provider, authType, NOW, NOW, t.shared.id],
  );
  return { ...t, connId: "conn-1" };
}

describe("migration 015", () => {
  it("is idempotent and additive on a pre-015 DB (table absent pre-migration)", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const pre = await createSqlJsAdapter(
      path.join(process.env.TOKENHOP_TEST_ROOT, "pre015.sqlite"),
    );
    runVersionedMigrations(
      pre,
      MIGRATIONS.filter((m) => m.version < 15),
    );
    expect(
      pre.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'connectionGrants'`),
    ).toBeUndefined();
    runVersionedMigrations(pre);
    expect(pre.get(`SELECT COUNT(*) AS c FROM connectionGrants`).c).toBe(0);
    const cols = pre.all(`PRAGMA table_info(connectionGrants)`).map((c) => c.name);
    expect(cols).toContain("budgetId");
    expect(cols).toContain("tosAcknowledgedAt");
    pre.close();
  });
});

describe("connectionGrantsRepo", () => {
  it("creates, lists and reads back a workspace grant; budgetId stored unwired", async () => {
    const { a, b, shared, connId } = await seed();
    const grant = await repo.createGrant(a.ctx, {
      connectionId: connId,
      workspaceId: b.personal,
      allowedModels: ["openai/gpt-5"],
      rpm: 60,
      tpm: 90000,
      budgetId: "budget-1",
    });
    expect(grant.id).toBeTruthy();
    expect(grant.budgetId).toBe("budget-1");
    expect(grant.allowedModels).toEqual(["openai/gpt-5"]);
    expect(grant.revokedAt).toBeNull();
    expect(grant.createdByUserId).toBe(a.user.id);

    const list = await repo.listGrantsForConnection(a.ctx, connId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: grant.id, workspaceId: b.personal, rpm: 60, tpm: 90000 });
    expect(await repo.getGrantById(a.ctx, grant.id)).toMatchObject({ id: grant.id });
    // budgetId is stored but unwired: no foreign key on it.
    const fks = db.all(`PRAGMA foreign_key_list(connectionGrants)`);
    expect(fks.map((f) => f.from)).not.toContain("budgetId");
    expect(fks.map((f) => f.from)).toEqual(
      expect.arrayContaining(["connectionId", "workspaceId", "userId", "createdByUserId"]),
    );
    // Cross-workspace invisibility: B (member, not manager) cannot read.
    expect(await repo.getGrantById(b.ctx, grant.id)).toBeNull();
    expect(await acode(repo.listGrantsForConnection(b.ctx, connId))).toBe("FORBIDDEN");
    expect(shared.id).toBeTruthy();
  });

  it("enforces exactly-one-grantee at repo and CHECK levels", async () => {
    const { a, b, connId } = await seed();
    const base = { connectionId: connId };
    expect(await acode(repo.createGrant(a.ctx, { ...base }))).toBe("INVALID");
    expect(
      await acode(repo.createGrant(a.ctx, { ...base, workspaceId: b.personal, userId: b.user.id })),
    ).toBe("INVALID");
    expect(() =>
      db.run(
        `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES('g-both', ?, ?, ?, 0)`,
        [connId, b.personal, b.user.id],
      ),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.run(`INSERT INTO connectionGrants(id, connectionId, createdAt) VALUES('g-none', ?, 0)`, [
        connId,
      ]),
    ).toThrow(/CHECK/i);
    expect((await repo.createGrant(a.ctx, { ...base, userId: b.user.id })).userId).toBe(b.user.id);
  });

  it("revokes idempotently and the gateway reader excludes revoked grants", async () => {
    const { a, b, connId } = await seed();
    const grant = await repo.createGrant(a.ctx, { connectionId: connId, workspaceId: b.personal });
    const active = () =>
      repo.listActiveGrantsForPrincipal(db, { workspaceId: b.personal, userId: b.user.id });
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({
      grantId: grant.id,
      connectionId: connId,
      workspaceId: b.personal,
      userId: null,
      allowedModels: null,
    });
    // The joined connection row is present and raw (no secrets field touched here).
    expect(active()[0].connection).toMatchObject({ id: connId, provider: "openai" });

    const revoked = await repo.revokeGrant(a.ctx, grant.id);
    expect(revoked.revokedAt).toBeGreaterThan(0);
    const again = await repo.revokeGrant(a.ctx, grant.id); // idempotent
    expect(again.revokedAt).toBe(revoked.revokedAt);
    expect(active()).toEqual([]);
    // Null-scope principal (legacy path): no grants, by construction.
    expect(repo.listActiveGrantsForPrincipal(db, {})).toEqual([]);
    expect(await acode(repo.revokeGrant(b.ctx, grant.id))).toBe("FORBIDDEN");
    expect(await acode(repo.revokeGrant(a.ctx, "nope"))).toBe("NOT_FOUND");
  });

  it("validates limits/models and stamps tosAcknowledgedAt only on the exact echo", async () => {
    const { a, b, connId } = await seed({ provider: "claude" });
    const bad = (extra) =>
      acode(repo.createGrant(a.ctx, { connectionId: connId, workspaceId: b.personal, ...extra }));
    expect(await bad({ allowedModels: [] })).toBe("INVALID");
    expect(await bad({ allowedModels: ["ok", ""] })).toBe("INVALID");
    expect(await bad({ rpm: 0 })).toBe("INVALID");
    expect(await bad({ tpm: 1.5 })).toBe("INVALID");
    expect(await bad({ budgetId: "" })).toBe("INVALID");

    const echo = { providerId: "claude", sharing: "personal" };
    const g1 = await repo.createGrant(a.ctx, {
      connectionId: connId,
      workspaceId: b.personal,
      tosAcknowledged: echo,
    });
    expect(g1.tosAcknowledgedAt).toBeGreaterThan(0);
    const g2 = await repo.createGrant(a.ctx, {
      connectionId: connId,
      workspaceId: b.personal,
      tosAcknowledged: { providerId: "openai", sharing: "personal" },
    });
    expect(g2.tosAcknowledgedAt).toBeNull();
  });

  it("audits create and revoke without secrets (allow-listed keys only)", async () => {
    const { a, b, connId } = await seed();
    const grant = await repo.createGrant(a.ctx, {
      connectionId: connId,
      workspaceId: b.personal,
      rpm: 10,
    });
    await repo.revokeGrant(a.ctx, grant.id);
    const rows = db.all(`SELECT * FROM auditEvents WHERE action LIKE 'connectionGrant.%'`);
    expect(rows.map((r) => r.action)).toEqual(["connectionGrant.create", "connectionGrant.revoke"]);
    expect(rows[0].targetId).toBe(grant.id);
    const after = JSON.parse(rows[0].after);
    expect(after).toMatchObject({ connectionId: connId, granteeWorkspaceId: b.personal, rpm: 10 });
    expect(JSON.stringify(rows)).not.toContain("apiKey");
  });
});

describe("resolveSharing", () => {
  it("classifies by registry field; oauth rows always personal; unknown fails closed", () => {
    const { resolveSharing } = grants;
    expect(resolveSharing("claude", "oauth")).toBe("personal");
    expect(resolveSharing("claude", "apikey")).toBe("personal");
    expect(resolveSharing("openai", "apikey")).toBe("shareable");
    expect(resolveSharing("kimchi", "oauth")).toBe("personal");
    expect(resolveSharing("kimchi", "apikey")).toBe("shareable");
    expect(resolveSharing("not-a-provider", "apikey")).toBe("personal");
    expect(resolveSharing("not-a-provider")).toBe("personal");
  });
});

describe("assertGrantable", () => {
  const claude = { provider: "claude", authType: "oauth" };
  const openai = { provider: "openai", authType: "apikey" };
  const owner = { instanceRole: "owner" };
  const ack = { tosAcknowledged: { providerId: "claude", sharing: "personal" } };

  it("shareable connections pass with no toggle, role or ack", () => {
    expect(
      grants.assertGrantable({ principal: { instanceRole: "user" }, connection: openai }),
    ).toEqual({ sharing: "shareable" });
  });

  it("blocks personal grants without the toggle, without an admin, or without the ack", () => {
    const on = { allowPersonalConnectionGrants: true };
    const off = { allowPersonalConnectionGrants: false };
    const gate = (principal, body, settings) =>
      scode(() => grants.assertGrantable({ principal, connection: claude, body, settings }));
    expect(gate(owner, ack, off)).toBe("FORBIDDEN"); // toggle off
    expect(gate(owner, ack, {})).toBe("FORBIDDEN"); // toggle absent
    expect(gate({ instanceRole: "admin" }, ack, on)).toBeUndefined(); // admin + ack + toggle
    expect(gate({ instanceRole: "user" }, ack, on)).toBe("FORBIDDEN"); // non-admin
    expect(gate(null, ack, on)).toBe("FORBIDDEN"); // no principal
    expect(gate(owner, {}, on)).toBe("FORBIDDEN"); // no ack
    expect(
      gate(owner, { tosAcknowledged: { providerId: "openai", sharing: "personal" } }, on),
    ).toBe("FORBIDDEN"); // wrong echo
    expect(
      grants.assertGrantable({ principal: owner, connection: claude, body: ack, settings: on }),
    ).toMatchObject({ sharing: "personal", tosAcknowledgedAt: expect.any(Number) });
    expect(gate(owner, ack, { allowPersonalConnectionGrants: "yes" })).toBe("FORBIDDEN"); // non-boolean truthy
  });

  it("treats OAuth rows on shareable providers as personal", () => {
    const kimchi = { provider: "kimchi", authType: "oauth" };
    expect(
      scode(() => grants.assertGrantable({ principal: owner, connection: kimchi, settings: {} })),
    ).toBe("FORBIDDEN");
    expect(
      grants.assertGrantable({
        principal: { instanceRole: "user" },
        connection: { provider: "kimchi", authType: "apikey" },
      }),
    ).toEqual({ sharing: "shareable" });
  });

  it("returns the ADR-0006 warning copy verbatim", () => {
    const w = grants.getSharingWarning("claude");
    expect(w).toContain("personal Anthropic subscription");
    expect(w).toContain("https://www.anthropic.com/legal/consumer-terms");
    expect(w).toContain("Overriding may violate Anthropic's terms.");
    expect(grants.getSharingWarning("codex")).toContain(
      "You may not share your account credentials",
    );
    expect(grants.getSharingWarning("github")).toContain("Copilot Business");
    expect(grants.getSharingWarning("gemini-cli")).toContain("personal Google-account credentials");
    expect(grants.getSharingWarning("unknown-x")).toContain("sharing: personal");
  });
});
