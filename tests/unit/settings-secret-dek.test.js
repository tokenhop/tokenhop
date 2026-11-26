// YAN-2460: lazy runtime DEK provisioning for the Default workspace when saving
// encrypted instance settings secrets on an empty encrypted install, with
// lost-DEK fail-closed protection, rollback cache eviction, and strict
// confinement of runtime contexts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";
import { collectFilesText } from "../helpers/secretScan.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedMaster = process.env.TOKENHOP_MASTER_KEY;
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 29 + 7) % 256));
const code = (c) => expect.objectContaining({ code: c });

let a2;
let db;
let t;
let cs;

async function load(switchValue = "on") {
  vi.resetModules();
  process.env[ENV] = switchValue;
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
  a2 = await (await import("@/lib/db/driver.js")).getAdapter();
  cs = await import("@/lib/db/helpers/credentialStorage.js");
}

async function clean() {
  for (const sql of [
    `DELETE FROM budgets`,
    `DELETE FROM budgetWebhooks`,
    `DELETE FROM connectionGrants`,
    `DELETE FROM providerConnections`,
    `DELETE FROM providerNodes`,
    `DELETE FROM combos`,
    `DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels')`,
    `DELETE FROM workspaceSettings`,
    `UPDATE settings SET data = '{}' WHERE id = 1`,
    `DELETE FROM auditEvents`,
    `DELETE FROM workspaceKeys`,
    `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  ])
    a2.run(sql);
  cs.clearCredentialCache(a2);
  t = await seedTenancy();
  await db.setMeta("defaultWorkspaceId", t.shared.id);
}

async function useHashedKeys() {
  const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  a2.exec(`DROP TABLE IF EXISTS apiKeys`);
  a2.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
  for (const idx of HASHED_API_KEYS_TABLE.indexes) a2.exec(idx);
  a2.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`, [
    masterKeyId(MASTER),
  ]);
}

async function activate() {
  const { loadMasterKey } = await import("@/lib/security/masterKey.js");
  const root = await loadMasterKey({ create: true });
  const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
  const result = await activateCredentialEncryption(a2, {
    enabled: true,
    beforeServing: true,
    root,
  });
  expect(result).toMatchObject({ status: "ready" });
  cs.clearCredentialCache(a2);
  return root;
}

const dekRow = (ws) => a2.get(`SELECT * FROM workspaceKeys WHERE workspaceId = ?`, [ws]);
const rawSettings = () => a2.get(`SELECT data FROM settings WHERE id = 1`)?.data ?? "{}";

beforeEach(async () => {
  assertIsolatedHome();
  await load("on");
  await clean();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedMaster === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = savedMaster;
});

describe("instance settings secrets on an empty encrypted install (YAN-2460)", () => {
  beforeEach(async () => {
    await useHashedKeys();
    await activate();
  });

  it("lazily provisions Default workspace DEK when saving oidcClientSecret and mitmSudoEncrypted, then decrypts", async () => {
    const defaultWs = t.shared.id;
    expect(dekRow(defaultWs)).toBeUndefined();

    const first = await db.updateSettings({ oidcClientSecret: "oidc-fresh-secret" });
    expect(first.oidcClientSecret).toBe("oidc-fresh-secret");

    const provisionedDek = dekRow(defaultWs);
    expect(provisionedDek).toBeTruthy();

    const storedAfterOidc = rawSettings();
    expect(storedAfterOidc).not.toContain("oidc-fresh-secret");
    expect(JSON.parse(storedAfterOidc).oidcClientSecret).toMatchObject({
      v: 1,
      kid: provisionedDek.kid,
    });

    // Second secret write reuses the same Default DEK.
    const second = await db.updateSettings({
      mitmSudoEncrypted: "mitm-fresh-sudo",
      samlPrivateKey: "saml-fresh-key",
    });
    expect(second.oidcClientSecret).toBe("oidc-fresh-secret");
    expect(second.mitmSudoEncrypted).toBe("mitm-fresh-sudo");
    expect(second.samlPrivateKey).toBe("saml-fresh-key");
    expect(dekRow(defaultWs).kid).toBe(provisionedDek.kid);

    const storedAfterAll = rawSettings();
    expect(storedAfterAll).not.toContain("mitm-fresh-sudo");
    expect(storedAfterAll).not.toContain("saml-fresh-key");
    expect(JSON.parse(storedAfterAll).mitmSudoEncrypted).toMatchObject({
      v: 1,
      kid: provisionedDek.kid,
    });

    cs.clearCredentialCache(a2);
    const reread = await db.getSettings();
    expect(reread.oidcClientSecret).toBe("oidc-fresh-secret");
    expect(reread.mitmSudoEncrypted).toBe("mitm-fresh-sudo");
    expect(reread.samlPrivateKey).toBe("saml-fresh-key");

    await a2.flush?.();
    const leaks = collectFilesText(process.env.DATA_DIR).filter(
      (f) =>
        f.text.includes("oidc-fresh-secret") ||
        f.text.includes("mitm-fresh-sudo") ||
        f.text.includes("saml-fresh-key"),
    );
    expect(leaks.map((f) => f.name)).toEqual([]);
  });

  it("does not provision a Default DEK on non-secret updates, empty/null clears, or rejected envelopes", async () => {
    const defaultWs = t.shared.id;
    expect(dekRow(defaultWs)).toBeUndefined();

    await db.updateSettings({ requireLogin: true, oidcIssuerUrl: "https://idp.example.com" });
    await db.updateSettings({ oidcClientSecret: "", mitmSudoEncrypted: null });
    await expect(
      db.updateSettings({ oidcClientSecret: { v: 1, kid: "k", iv: "a", ct: "b", tag: "c" } }),
    ).rejects.toMatchObject({ code: "ENVELOPE_REJECTED" });

    expect(dekRow(defaultWs)).toBeUndefined();
  });

  it("rolls back the Default DEK and immediately zeroes/evicts the cached DEK on transaction failure", async () => {
    const defaultWs = t.shared.id;
    expect(dekRow(defaultWs)).toBeUndefined();

    // Force a failure after encodeSecretUpdates has provisioned the DEK, on the
    // settings table upsert itself (covers both fresh INSERT and UPDATE paths).
    a2.exec(`
      CREATE TRIGGER fail_settings_insert
      BEFORE INSERT ON settings
      BEGIN
        SELECT RAISE(ABORT, 'simulated settings write failure');
      END;
      CREATE TRIGGER fail_settings_update
      BEFORE UPDATE ON settings
      BEGIN
        SELECT RAISE(ABORT, 'simulated settings write failure');
      END;
    `);

    const env = await import("@/lib/security/envelope.js");
    const capturedDeks = [];
    const origDecrypt = env.decryptBytes;
    const decSpy = vi.spyOn(env, "decryptBytes").mockImplementation((...args) => {
      const out = origDecrypt(...args);
      if (typeof args[2] === "string" && args[2].startsWith("v1|workspaceKeys|")) {
        capturedDeks.push(out);
      }
      return out;
    });

    try {
      await expect(db.updateSettings({ oidcClientSecret: "rolled-back-secret" })).rejects.toThrow(
        /simulated settings write failure/,
      );
    } finally {
      decSpy.mockRestore();
      a2.exec(
        `DROP TRIGGER IF EXISTS fail_settings_insert; DROP TRIGGER IF EXISTS fail_settings_update`,
      );
    }

    expect(dekRow(defaultWs)).toBeUndefined();
    expect(rawSettings()).not.toContain("rolled-back-secret");
    expect(capturedDeks.length).toBeGreaterThan(0);
    for (const buf of capturedDeks) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }

    // Cache must stay clean (no resurrection on subsequent runtime reads).
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const rt = cs.prepareCredentialContext(a2, await loadMasterKey());
    expect(() => cs.ensureWorkspaceDekSync(a2, defaultWs, rt)).toThrow(code("KEY_MISSING"));
  });

  it("fails closed with KEY_MISSING when Default DEK was deleted while encrypted settings or workspace rows exist", async () => {
    const defaultWs = t.shared.id;

    // 1. Existing encrypted settings secret with deleted Default DEK.
    await db.updateSettings({ oidcClientSecret: "existing-oidc-secret" });
    expect(dekRow(defaultWs)).toBeTruthy();
    const beforeSettings = rawSettings();

    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [defaultWs]);
    cs.clearCredentialCache(a2);

    await expect(
      db.updateSettings({ mitmSudoEncrypted: "should-not-overwrite" }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(dekRow(defaultWs)).toBeUndefined();
    expect(rawSettings()).toBe(beforeSettings);

    // 2. Existing encrypted providerConnection in Default with empty settings and deleted DEK.
    a2.run(`UPDATE settings SET data = '{}' WHERE id = 1`);
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      authType: "apikey",
      name: "default-conn",
      apiKey: "sk-default-conn",
    });
    expect(dekRow(defaultWs)).toBeTruthy();
    a2.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [defaultWs]);
    cs.clearCredentialCache(a2);

    await expect(
      db.updateSettings({ oidcClientSecret: "should-fail-closed" }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(dekRow(defaultWs)).toBeUndefined();
    expect(rawSettings()).toBe("{}");
  });

  it("confines provisionSettingsSecretDekSync to Default + genuine runtime contexts and keeps ensureWorkspaceDekSync fail-closed", async () => {
    const defaultWs = t.shared.id;
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const root = await loadMasterKey();
    const real = cs.prepareCredentialContext(a2, root);

    // Non-Default workspace is rejected even with a genuine runtime context.
    expect(() => cs.provisionSettingsSecretDekSync(a2, t.a.personal, real)).toThrow(
      code("KEY_MISSING"),
    );
    expect(dekRow(t.a.personal)).toBeUndefined();

    // Forged, migration, rootless, unknown workspace, and KEK mismatch are all rejected.
    expect(() => cs.provisionSettingsSecretDekSync(a2, defaultWs, { ...real })).toThrow(
      code("KEY_MISSING"),
    );
    expect(() =>
      cs.provisionSettingsSecretDekSync(a2, defaultWs, cs.createMigrationContext(a2, root)),
    ).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.provisionSettingsSecretDekSync(a2, defaultWs, cs.prepareCredentialContext(a2, null)),
    ).toThrow(code("KEY_MISSING"));
    expect(() => cs.provisionSettingsSecretDekSync(a2, "no-such-workspace", real)).toThrow(
      code("KEY_MISSING"),
    );

    a2.run(`UPDATE _meta SET value = 'ffffffffffffffff' WHERE key = 'credentialsKekKid'`);
    try {
      expect(() => cs.provisionSettingsSecretDekSync(a2, defaultWs, real)).toThrow(
        code("KEY_MISMATCH"),
      );
    } finally {
      a2.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [root.kid]);
    }
    expect(dekRow(defaultWs)).toBeUndefined();

    // Generic runtime entry points remain fail-closed on keyless Default.
    expect(() => cs.ensureWorkspaceDekSync(a2, defaultWs, real)).toThrow(code("KEY_MISSING"));
    expect(() =>
      cs.encodeCredentialRowSync(a2, { id: "1", data: { oidcClientSecret: "nope" } }, real, {
        table: "settings",
        workspaceId: defaultWs,
      }),
    ).toThrow(code("KEY_MISSING"));
    expect(dekRow(defaultWs)).toBeUndefined();
  });
});

describe("legacy unencrypted install unchanged (YAN-2460)", () => {
  it("never writes workspaceKeys when saving settings secrets with encryption off", async () => {
    const defaultWs = t.shared.id;
    const saved = await db.updateSettings({ oidcClientSecret: "legacy-plain-secret" });
    expect(saved.oidcClientSecret).toBe("legacy-plain-secret");
    expect(dekRow(defaultWs)).toBeUndefined();
    expect(JSON.parse(rawSettings()).oidcClientSecret).toBe("legacy-plain-secret");
  });
});
