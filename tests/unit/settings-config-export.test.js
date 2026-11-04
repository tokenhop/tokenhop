import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-settings-config-"));
  process.env.DATA_DIR = tempDir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const exportConfig = () =>
  import("@/app/api/settings/config/export/route.js").then(({ GET }) =>
    GET(
      new Request("http://localhost/api/settings/config/export", {
        headers: { "x-9r-password": "123456" },
      }),
    ),
  );

const importConfig = (doc, extra = {}) =>
  import("@/app/api/settings/config/import/route.js").then(({ POST }) =>
    POST(
      new Request("http://localhost/api/settings/config/import", {
        method: "POST",
        body: JSON.stringify({ doc, password: "123456", ...extra }),
      }),
    ),
  );

const readStored = async () => {
  const { getSettings } = await import("@/lib/localDb");
  return getSettings();
};

describe("YAN-313 config export/import routes", () => {
  it("round-trips export → modify → preview → apply → zero diff", async () => {
    const res = await exportConfig();
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.settings).not.toHaveProperty("password");
    expect(doc.settings).not.toHaveProperty("oidcClientSecret");

    const changed = {
      ...doc,
      settings: { ...doc.settings, stickyRoundRobinLimit: 9 },
    };
    const preview = await (await importConfig(changed, { mode: "preview" })).json();
    expect(preview.valid).toBe(true);
    expect(
      preview.diff.settings.entries.find((e) => e.key === "stickyRoundRobinLimit").status,
    ).toBe("changed");

    const applied = await importConfig(changed, { mode: "apply" });
    expect(applied.status).toBe(200);
    expect((await readStored()).stickyRoundRobinLimit).toBe(9);

    const again = await (await importConfig(changed, { mode: "preview" })).json();
    expect(again.diff.settings.changed).toBe(0);
  });

  it("preserves stored credentials on URL round trip", async () => {
    // A credential-laden URL in storage: export masks it, import skips
    // tombstones (with warning), so the stored URL is never lost.
    const storedUrl = "http://alice:hunter2@proxy.corp:8080/path";
    const { updateSettings } = await import("@/lib/localDb");
    await updateSettings({ outboundProxyUrl: storedUrl });

    const doc = await (await exportConfig()).json();
    expect(doc.settings.outboundProxyUrl).toBe("http://***@proxy.corp:8080/path");
    expect(doc.redactedSettings).toContain("outboundProxyUrl");

    const preview = await importConfig(doc, { mode: "preview" });
    const previewJson = await preview.json();
    expect(previewJson.valid).toBe(true);
    expect(previewJson.warnings.some((w) => w.includes("outboundProxyUrl"))).toBe(true);

    const applied = await importConfig(doc, { mode: "apply" });
    expect(applied.status).toBe(200);
    expect((await readStored()).outboundProxyUrl).toBe(storedUrl);
  });

  it("requires password, rejects secrets, versions and sizes", async () => {
    const noAuth = await import("@/app/api/settings/config/export/route.js").then(({ GET }) =>
      GET(new Request("http://localhost/api/settings/config/export")),
    );
    expect(noAuth.status).toBe(401);

    const doc = await (await exportConfig()).json();
    const secret = await importConfig(
      { ...doc, settings: { ...doc.settings, password: "hash" } },
      { mode: "preview" },
    );
    expect(secret.status).toBe(400);

    const version = await importConfig({ ...doc, schemaVersion: 999 }, { mode: "preview" });
    expect(version.status).toBe(400);

    const oversized = await import("@/app/api/settings/config/import/route.js").then(({ POST }) =>
      POST(
        new Request("http://localhost/api/settings/config/import", {
          method: "POST",
          headers: { "x-9r-password": "123456" },
          body: "x".repeat(1024 * 1024 + 1),
        }),
      ),
    );
    expect(oversized.status).toBe(413);
  });

  it("never exports the metadata-only secretsConfigured presence map (YAN-365)", async () => {
    const { updateSettings } = await import("@/lib/localDb");
    await updateSettings({
      oidcIssuerUrl: "https://idp.example",
      oidcClientId: "client",
      oidcClientSecret: "shh",
    });

    const doc = await (await exportConfig()).json();
    expect(doc.settings).not.toHaveProperty("secretsConfigured");

    // A smuggled presence map is unknown to the config schema: warned and
    // dropped at validation, never persisted.
    const preview = await (
      await importConfig(
        { ...doc, settings: { ...doc.settings, secretsConfigured: { oidcClientSecret: false } } },
        { mode: "preview" },
      )
    ).json();
    expect(preview.valid).toBe(true);
    expect(preview.warnings.some((w) => w.includes("secretsConfigured"))).toBe(true);
    expect(JSON.stringify(preview.diff)).not.toContain("secretsConfigured");
  });

  it("never exports the MITM internal verifier and rejects it on import (YAN-363)", async () => {
    const { updateSettings } = await import("@/lib/localDb");
    await updateSettings({ mitmInternalVerifier: "a".repeat(64) });

    const doc = await (await exportConfig()).json();
    expect(doc.settings).not.toHaveProperty("mitmInternalVerifier");

    const smuggled = await importConfig(
      { ...doc, settings: { ...doc.settings, mitmInternalVerifier: "b".repeat(64) } },
      { mode: "preview" },
    );
    expect(smuggled.status).toBe(400);
    expect((await smuggled.json()).errors.join("\n")).toContain("mitmInternalVerifier");

    expect((await readStored()).mitmInternalVerifier).toBe("a".repeat(64));
    await updateSettings({ mitmInternalVerifier: null });
  });

  it("rejects combo cycles the same way the Combos page does", async () => {
    const doc = await (await exportConfig()).json();
    const cycling = await importConfig(
      {
        ...doc,
        combos: [
          { name: "yan313-a", models: ["yan313-b"] },
          { name: "yan313-b", models: ["yan313-a"] },
        ],
      },
      { mode: "preview" },
    );
    expect(cycling.status).toBe(400);
    expect((await cycling.json()).error).toMatch(/cycle/i);
  });

  it("rejects out-of-range values at the import boundary", async () => {
    const doc = await (await exportConfig()).json();
    const bad = await importConfig(
      { ...doc, settings: { ...doc.settings, stickyRoundRobinLimit: 0 } },
      { mode: "preview" },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBeTruthy();
  });

  it("applies combos and pricing atomically (a mid-apply write failure rolls back)", async () => {
    const before = await readStored();
    const target = before.stickyRoundRobinLimit === 7 ? 8 : 7;
    const changed = await (await exportConfig()).json();
    changed.settings.stickyRoundRobinLimit = target;
    changed.combos = [...changed.combos, { name: "yan313-e2e", models: [] }];
    changed.pricingOverrides = { "yan313-test": { m1: { input: 1 } } };

    const applied = await importConfig(changed, { mode: "apply" });
    expect(applied.status).toBe(200);
    const { getCombos, getUserPricing } = await import("@/lib/localDb");
    expect((await readStored()).stickyRoundRobinLimit).toBe(target);
    expect((await getCombos()).some((c) => c.name === "yan313-e2e")).toBe(true);
    expect((await getUserPricing())["yan313-test"]).toEqual({ m1: { input: 1 } });

    // Force a write failure inside the transaction (past validation) and
    // prove settings, combos and pricing all roll back together.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const realRun = db.run.bind(db);
    const failingRun = (sql, params) => {
      if (String(sql).includes("INSERT INTO kv(scope, key, value) VALUES('pricing'")) {
        throw new Error("boom at pricing");
      }
      return realRun(sql, params);
    };
    db.run = failingRun;
    let failed;
    try {
      changed.settings.stickyRoundRobinLimit = changed.settings.stickyRoundRobinLimit === 6 ? 5 : 6;
      failed = await importConfig(
        { ...changed, combos: [...changed.combos, { name: "yan313-rollback", models: [] }] },
        { mode: "apply" },
      );
    } finally {
      db.run = realRun;
    }
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toMatch(/boom at pricing/);
    // Rollback proves the failed apply wrote nothing: the pre-failure value
    // from the earlier successful apply is still stored.
    const after = await readStored();
    expect(after.stickyRoundRobinLimit).toBe(target);
    expect((await getCombos()).some((c) => c.name === "yan313-rollback")).toBe(false);
    expect((await getUserPricing())["yan313-test"]).toEqual({ m1: { input: 1 } });
  });
});

// YAN-359: the SSO group policy keys ride the config document only while the
// users & teams switch is on. featureSwitch reads the env at import, so each
// state reloads modules.
describe("YAN-359 SSO policy keys in config export/import", () => {
  const SSO_KEYS = [
    "ssoGroupsClaim",
    "samlAttributeGroups",
    "ssoAllowedGroups",
    "ssoAdminGroups",
    "ssoGroupWorkspaceMap",
    "ssoDefaultRole",
  ];
  const originalSwitch = process.env.TOKENHOP_MULTI_USER;
  const setSwitch = (state) => {
    vi.resetModules();
    process.env.TOKENHOP_MULTI_USER = state;
  };
  const seedWorkspace = async (id, kind) => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, NULL, ?, ?)`,
      [id, id, kind, now, now],
    );
    return db;
  };

  afterAll(() => {
    vi.resetModules();
    if (originalSwitch === undefined) delete process.env.TOKENHOP_MULTI_USER;
    else process.env.TOKENHOP_MULTI_USER = originalSwitch;
  });

  it("off: export and state omit the keys; an import carrying them is 404 and writes nothing", async () => {
    setSwitch("off");
    const doc = await (await exportConfig()).json();
    for (const key of SSO_KEYS) expect(doc.settings).not.toHaveProperty(key);
    const { getConfigState } = await import("@/lib/db/configExport.js");
    const state = await getConfigState();
    for (const key of SSO_KEYS) expect(state.settings).not.toHaveProperty(key);

    const before = await readStored();
    const res = await importConfig(
      { ...doc, settings: { ...doc.settings, ssoAllowedGroups: ["eng"] } },
      { mode: "apply" },
    );
    expect(res.status).toBe(404);
    expect((await readStored()).ssoAllowedGroups).toEqual(before.ssoAllowedGroups);
  });

  it("on: valid shared target applies; personal/unknown target and owner role are 400", async () => {
    setSwitch("on");
    await seedWorkspace("ws-cfg-shared", "shared");
    await seedWorkspace("ws-cfg-personal", "personal");
    const doc = await (await exportConfig()).json();
    expect(doc.settings).toHaveProperty("ssoDefaultRole", "pending");

    const withMap = (map) => ({ ...doc, settings: { ...doc.settings, ssoGroupWorkspaceMap: map } });
    const ok = await importConfig(
      withMap([{ group: "eng", workspaceId: "ws-cfg-shared", role: "member" }]),
      { mode: "apply" },
    );
    expect(ok.status).toBe(200);
    expect((await readStored()).ssoGroupWorkspaceMap).toEqual([
      { group: "eng", workspaceId: "ws-cfg-shared", role: "member" },
    ]);

    for (const map of [
      [{ group: "eng", workspaceId: "ws-cfg-personal", role: "member" }],
      [{ group: "eng", workspaceId: "ws-cfg-missing", role: "member" }],
      [{ group: "eng", workspaceId: "ws-cfg-shared", role: "owner" }],
    ]) {
      const bad = await importConfig(withMap(map), { mode: "apply" });
      expect(bad.status).toBe(400);
    }
    expect((await readStored()).ssoGroupWorkspaceMap).toEqual([
      { group: "eng", workspaceId: "ws-cfg-shared", role: "member" },
    ]);
  });

  it("on: applyConfig rechecks targets inside its transaction", async () => {
    setSwitch("on");
    const db = await seedWorkspace("ws-cfg-doomed", "shared");
    const { getConfigState, applyConfig } = await import("@/lib/db/configExport.js");
    const state = await getConfigState();
    const before = await readStored();
    // Validated earlier, deleted before apply.
    db.run(`DELETE FROM workspaces WHERE id = ?`, ["ws-cfg-doomed"]);
    await expect(
      applyConfig({
        ...state,
        settings: {
          ...state.settings,
          ssoGroupWorkspaceMap: [{ group: "ops", workspaceId: "ws-cfg-doomed", role: "viewer" }],
        },
      }),
    ).rejects.toThrow(/ssoGroupWorkspaceMap/);
    expect((await readStored()).ssoGroupWorkspaceMap).toEqual(before.ssoGroupWorkspaceMap);
  });
});

// YAN-1834: Default-workspace budgets ride the config document (limits only)
// and import with the budget API's rules. Pristine install, switch off.
describe("YAN-1834 budgets in config export/import", () => {
  const originalSwitch = process.env.TOKENHOP_MULTI_USER;
  const OLD = "2026-01-01T00:00:00.000Z";
  const RAW = "sk-config-budget-key-0123456789abcdef";
  const PORTABLE_KEYS = [
    "limitRequests",
    "limitTokens",
    "limitUsd",
    "scopeId",
    "scopeType",
    "softLimitPct",
    "window",
  ];
  let db;

  const fresh = async () => {
    vi.resetModules();
    process.env.TOKENHOP_MULTI_USER = "off";
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const table of ["budgets", "usageHistory", "usageBudgetCarry", "apiKeys", "workspaces"])
      db.run(`DELETE FROM ${table}`);
    db.run(
      `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'usageAdoptedAt')`,
    );
    db.run(
      "INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('cfg-key', ?, 'cfg', 1, ?)",
      [RAW, OLD],
    );
  };
  const budget = (id, ws, scopeType, scopeId, limitRequests, softLimitPct = null) =>
    db.run(
      `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
       VALUES(?, ?, ?, ?, 'day', ?, ?, '2026-01-02T00:00:00.000Z', NULL, ?)`,
      [id, ws, scopeType, scopeId, limitRequests, softLimitPct, OLD],
    );
  // Pending Default with a workspace budget (2 requests/day) and a key budget (1).
  const seed = async () => {
    const { ensurePendingDefaultWorkspaceUnscoped } = await import("@/lib/db/repos/ownership.js");
    const ws = db.transaction(() => ensurePendingDefaultWorkspaceUnscoped(db));
    budget("cfg-ws", ws, "workspace", ws, 2, 80);
    budget("cfg-k", ws, "key", "cfg-key", 1);
    return ws;
  };
  const entry = (scopeType, scopeId, limits) => ({
    scopeType,
    scopeId,
    window: "day",
    limitUsd: null,
    limitTokens: null,
    limitRequests: null,
    softLimitPct: null,
    ...limits,
  });
  const budgetDump = () => JSON.stringify(db.all("SELECT * FROM budgets ORDER BY id"));
  // Budget-only document: no settings, so an apply fires no settings side effects.
  const exportDoc = async () => ({ ...(await (await exportConfig()).json()), settings: {} });
  const call = async (guard, apiKey) =>
    guard.budgeted(null, { provider: "openai", model: "gpt-x", nonToken: true, apiKey }, () =>
      Promise.resolve(new Response("ok")),
    );
  const expect429 = async (res, level) => {
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({ code: "budget_exceeded", level });
  };

  afterAll(() => {
    vi.resetModules();
    if (originalSwitch === undefined) delete process.env.TOKENHOP_MULTI_USER;
    else process.env.TOKENHOP_MULTI_USER = originalSwitch;
  });

  it("round-trips onto a fresh instance and enforces both levels", async () => {
    await fresh();
    const ws = await seed();
    db.run(
      `INSERT INTO budgetNotices(budgetId, kind, windowStart, signature, notifiedAt) VALUES('cfg-ws', 'soft', ?, 'sig', ?)`,
      [OLD, OLD],
    );
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, cost, status, apiKeyId, workspaceId) VALUES(?, 'openai', 'gpt-x', 1, 'success', 'cfg-key', ?)`,
      [OLD, ws],
    );
    const doc = await exportDoc();
    expect(doc.budgets).toEqual([
      entry("workspace", null, { limitRequests: 2, softLimitPct: 80 }),
      entry("key", "cfg-key", { limitRequests: 1 }),
    ]);
    for (const b of doc.budgets) expect(Object.keys(b).sort()).toEqual(PORTABLE_KEYS);
    expect(JSON.stringify(doc)).not.toContain(ws);

    // Fresh instance: no budgets, no budget workspace.
    db.run("DELETE FROM budgets");
    db.run("DELETE FROM workspaces");
    db.run(`DELETE FROM _meta WHERE key = 'pendingDefaultWorkspaceId'`);
    const res = await importConfig(doc, { mode: "apply" });
    expect(res.status).toBe(200);
    expect((await res.json()).diff.budgets).toMatchObject({ unchanged: 2 });

    const { pendingDefaultWorkspaceIdUnscoped } = await import("@/lib/db/repos/ownership.js");
    const next = pendingDefaultWorkspaceIdUnscoped(db);
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(ws);
    expect(
      db.all("SELECT workspaceId, scopeType, scopeId FROM budgets ORDER BY scopeType"),
    ).toEqual([
      { workspaceId: next, scopeType: "key", scopeId: "cfg-key" },
      { workspaceId: next, scopeType: "workspace", scopeId: next },
    ]);

    const guard = await import("@/sse/services/budgetGuard.js");
    expect((await call(guard, RAW)).status).toBe(200);
    await expect429(await call(guard, RAW), "key");
    expect((await call(guard, null)).status).toBe(200);
    await expect429(await call(guard, null), "workspace");
  });

  it("skips an unmapped key budget and still applies the workspace budget", async () => {
    await fresh();
    const doc = await exportDoc();
    doc.budgets = [
      entry("workspace", null, { limitRequests: 5 }),
      entry("key", "missing-key", { limitRequests: 1 }),
    ];
    const warning = "Budget key:missing-key:day skipped: target not found on this instance";
    const preview = await (await importConfig(doc, { mode: "preview" })).json();
    expect(preview.warnings).toContain(warning);
    expect(db.all("SELECT id FROM budgets")).toEqual([]);

    const applied = await (await importConfig(doc, { mode: "apply" })).json();
    expect(applied.warnings).toContain(warning);
    expect(db.all("SELECT scopeType, limitRequests FROM budgets")).toEqual([
      { scopeType: "workspace", limitRequests: 5 },
    ]);
  });

  it("skips membership and grant budgets while Users & teams is off", async () => {
    await fresh();
    await seed();
    const doc = await exportDoc();
    doc.budgets = [
      entry("membership", "user-1", { limitRequests: 1 }),
      entry("grant", "grant-1", { limitRequests: 1 }),
    ];
    const before = budgetDump();
    const applied = await (await importConfig(doc, { mode: "apply" })).json();
    expect(applied.warnings).toEqual(
      expect.arrayContaining([
        "Budget membership:user-1:day skipped: needs Users & teams",
        "Budget grant:grant-1:day skipped: needs Users & teams",
      ]),
    );
    expect(budgetDump()).toBe(before);
  });

  it("skips a key budget over the imported workspace ceiling", async () => {
    await fresh();
    const doc = await exportDoc();
    // Key first in the file: the workspace entry still sets the ceiling.
    doc.budgets = [
      entry("key", "cfg-key", { limitRequests: 5 }),
      entry("workspace", null, { limitRequests: 2 }),
    ];
    const applied = await (await importConfig(doc, { mode: "apply" })).json();
    expect(applied.warnings).toContain("Budget key:cfg-key:day skipped: Exceeds workspace budget");
    expect(db.all("SELECT scopeType FROM budgets")).toEqual([{ scopeType: "workspace" }]);
  });

  it("rejects invalid budget values with a 400 and writes nothing", async () => {
    await fresh();
    await seed();
    const doc = await exportDoc();
    doc.settings = { stickyRoundRobinLimit: 4 };
    doc.combos = [...doc.combos, { name: "yan1834-combo", models: [] }];
    const state = () =>
      JSON.stringify({
        settings: db.all("SELECT * FROM settings"),
        combos: db.all("SELECT * FROM combos ORDER BY id"),
        budgets: db.all("SELECT * FROM budgets ORDER BY id"),
      });
    const before = state();
    for (const bad of [
      entry("workspace", null, { limitRequests: 1, softLimitPct: 0 }),
      entry("workspace", null, { limitUsd: -1 }),
      entry("workspace", null, {}),
      entry("workspace", null, { limitTokens: 1.5 }),
      { ...entry("workspace", null, { limitRequests: 1 }), id: "smuggled" },
    ]) {
      const res = await importConfig({ ...doc, budgets: [bad] }, { mode: "apply" });
      expect(res.status).toBe(400);
      expect((await res.json()).errors[0]).toMatch(/^budgets\[0\]: /);
    }
    expect(state()).toBe(before);
  });

  it("an older file without budgets applies and keeps existing budgets", async () => {
    await fresh();
    await seed();
    const doc = await exportDoc();
    delete doc.budgets;
    const before = budgetDump();
    const res = await importConfig(doc, { mode: "apply" });
    expect(res.status).toBe(200);
    expect(budgetDump()).toBe(before);
  });

  it("updates a matching budget in place and audits it", async () => {
    await fresh();
    await seed();
    const doc = await exportDoc();
    doc.budgets[0] = { ...doc.budgets[0], limitRequests: 9 };
    const preview = await (await importConfig(doc, { mode: "preview" })).json();
    expect(preview.diff.budgets.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "workspace:workspace:day", status: "changed" }),
        expect.objectContaining({ key: "key:cfg-key:day", status: "unchanged" }),
      ]),
    );
    expect((await importConfig(doc, { mode: "apply" })).status).toBe(200);
    const row = db.get("SELECT * FROM budgets WHERE scopeType = 'workspace'");
    expect(row).toMatchObject({ id: "cfg-ws", limitRequests: 9, softLimitPct: 80 });
    expect(row.resetAt).not.toBe("2026-01-02T00:00:00.000Z");
    const audit = db.get(
      `SELECT before, after FROM auditEvents WHERE action = 'budget.update' AND targetId = 'cfg-ws'`,
    );
    expect(JSON.parse(audit.before)).toMatchObject({ limitRequests: 2 });
    expect(JSON.parse(audit.after)).toMatchObject({ limitRequests: 9 });
  });
});
