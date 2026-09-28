import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-config-"));
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
