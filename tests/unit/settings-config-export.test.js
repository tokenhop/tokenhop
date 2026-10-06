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
