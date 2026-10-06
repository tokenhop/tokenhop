// YAN-605 / YAN-606 / YAN-607: settings routes must not leak credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalInitial = process.env.INITIAL_PASSWORD;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-settings-secrets-"));
  process.env.DATA_DIR = tempDir;
  process.env.INITIAL_PASSWORD = "initial-pw";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalInitial === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = originalInitial;
});

const req = (url, init = {}) => new Request(`http://localhost${url}`, init);

describe("database export/import re-auth (YAN-605)", () => {
  const exportWith = async (headers) => {
    const { GET } = await import("@/app/api/settings/database/route.js");
    return GET(req("/api/settings/database", { headers }));
  };
  const importWith = async (headers, body) => {
    const { POST } = await import("@/app/api/settings/database/route.js");
    return POST(
      req("/api/settings/database", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  };

  it("rejects a missing or wrong CLI token without a password", async () => {
    expect((await exportWith({})).status).toBe(401);
    expect((await exportWith({ "x-9r-cli-token": "x" })).status).toBe(401);
    expect((await exportWith({ "x-9r-password": "wrong" })).status).toBe(401);
    expect((await importWith({ "x-9r-cli-token": "x" }, {})).status).toBe(401);
  });

  it("accepts the real CLI token or the dashboard password", async () => {
    const { getCliToken } = await import("@/lib/auth/cliToken");
    const token = await getCliToken();
    expect((await exportWith({ "x-9r-cli-token": token })).status).toBe(200);
    expect((await exportWith({ "x-9r-password": "initial-pw" })).status).toBe(200);
    const payload = await (await exportWith({ "x-9r-password": "initial-pw" })).json();
    expect((await importWith({ "x-9r-cli-token": token }, payload)).status).toBe(200);
    expect((await importWith({}, { ...payload, password: "initial-pw" })).status).toBe(200);
  });
});

describe("public require-login response (YAN-606)", () => {
  it("returns only requireLogin, never tunnel or Tailscale URLs", async () => {
    await db.updateSettings({
      tunnelUrl: "https://secret.trycloudflare.com",
      tailscaleUrl: "https://box.tail123.ts.net",
    });
    const { GET } = await import("@/app/api/settings/require-login/route.js");
    expect(await (await GET()).json()).toEqual({ requireLogin: true });
  });
});

describe("settings API omits credentials (YAN-607)", () => {
  it("GET and PATCH responses contain no secret keys", async () => {
    await db.updateSettings({
      mitmSudoEncrypted: "enc:sudo",
      mitmInternalVerifier: "d".repeat(64),
      samlPrivateKey: "-----BEGIN PRIVATE KEY-----",
      oidcIssuerUrl: "https://idp.example",
      oidcClientId: "client",
      oidcClientSecret: "shh",
    });
    const { GET, PATCH } = await import("@/app/api/settings/route.js");
    const { SECRET_SETTING_KEYS } = await import("@/lib/settingsConfigDoc");
    const got = await (await GET()).json();
    const patched = await (
      await PATCH(
        req("/api/settings", { method: "PATCH", body: JSON.stringify({ requireLogin: true }) }),
      )
    ).json();
    for (const body of [got, patched]) {
      for (const key of SECRET_SETTING_KEYS) expect(body).not.toHaveProperty(key);
      expect(body.oidcConfigured).toBe(true);
    }
    const snapshot = await db.exportDb();
    expect(snapshot.settings).not.toHaveProperty("mitmInternalVerifier");
    await db.updateSettings({ mitmInternalVerifier: null });
  });

  it("strips an untrusted mitmInternalVerifier PATCH and keeps the lifecycle's stored value", async () => {
    const verifier = "f".repeat(64);
    await db.updateSettings({ mitmInternalVerifier: verifier });
    const { GET, PATCH } = await import("@/app/api/settings/route.js");
    const patched = await (
      await PATCH(
        req("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ requireLogin: true, mitmInternalVerifier: "0".repeat(64) }),
        }),
      )
    ).json();
    expect(patched).not.toHaveProperty("mitmInternalVerifier");
    const stored = await db.getSettings();
    expect(stored.mitmInternalVerifier).toBe(verifier);
    const got = await (await GET()).json();
    expect(got).not.toHaveProperty("mitmInternalVerifier");
    await db.updateSettings({ mitmInternalVerifier: null });
  });
});

// YAN-365: encrypted five-secret settings. Fixture stands in for B3 activation
// (marker + Default DEK) so the settings seams are validated independently.
describe("encrypted settings secrets (YAN-365)", () => {
  const SECRETS = {
    oidcClientSecret: "oidc-sentinel",
    samlPrivateKey: "saml-priv-sentinel",
    samlDecryptionKey: "saml-dec-sentinel",
    samlSigningKey: "saml-sign-sentinel",
    mitmSudoEncrypted: "sudo-sentinel",
  };
  let adapter;
  let defaultWs;

  const rawBlob = () => JSON.parse(adapter.get(`SELECT data FROM settings WHERE id = 1`).data);
  const rawText = () => adapter.get(`SELECT data FROM settings WHERE id = 1`).data;

  beforeAll(async () => {
    const masterKey = await import("@/lib/security/masterKey.js");
    const env = await import("@/lib/security/envelope.js");
    const storage = await import("@/lib/db/helpers/credentialStorage.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    // Default workspace may not exist on a fresh isolated install; the YAN-365
    // fixture needs a real row, so create a shared Default on demand.
    defaultWs =
      adapter.get(
        `SELECT w.id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = 'defaultWorkspaceId'`,
      )?.id ?? null;
    if (!defaultWs) {
      defaultWs = `ws-yan365-${Date.now()}`;
      adapter.run(
        `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES(?, 'Default', 'shared', ?, ?)`,
        [defaultWs, new Date().toISOString(), new Date().toISOString()],
      );
      adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [
        defaultWs,
      ]);
    }
    const root = await masterKey.loadMasterKey({ create: true });
    const set = (k, v) =>
      adapter.run(
        `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [k, v],
      );
    set("credentialsEncryptedVersion", "1");
    set("credentialsKekKid", root.kid);
    set(
      "apiKeyHashKeyWrapped",
      JSON.stringify(
        env.encryptBytes(
          root.key,
          root.kid,
          masterKey.deriveApiKeyHashKey(root.key),
          env.buildHashKeyWrapAad(defaultWs, "0123456789abcdef"),
        ),
      ),
    );
    const mctx = storage.createMigrationContext(adapter, root);
    storage.ensureWorkspaceDekSync(adapter, defaultWs, mctx);
    storage.clearCredentialCache(adapter);
    await db.updateSettings({ ...SECRETS, requireLogin: true });
  });

  afterAll(async () => {
    adapter.run(`DELETE FROM workspaceKeys`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped')`,
    );
    const storage = await import("@/lib/db/helpers/credentialStorage.js");
    storage.clearCredentialCache(adapter);
    adapter.run(`UPDATE settings SET data = '{}' WHERE id = 1`);
  });

  it("stores only envelopes, never plaintext", () => {
    const text = rawText();
    for (const [key, plain] of Object.entries(SECRETS)) {
      expect(text).not.toContain(plain);
      expect(rawBlob()[key]).toMatchObject({ v: 1 });
    }
  });

  it("metadata mode has no secrets and needs no root; runtime decrypts all five", async () => {
    const meta = await db.getSettings({ secretMode: "metadata" });
    for (const key of Object.keys(SECRETS)) {
      expect(meta).not.toHaveProperty(key);
      expect(meta.secretsConfigured[key]).toBe(true);
    }
    expect(JSON.stringify(meta)).not.toContain("sentinel");
    const runtime = await db.getSettings();
    for (const [key, plain] of Object.entries(SECRETS)) expect(runtime[key]).toBe(plain);
  });

  it("settings routes stay redacted while OIDC reads configured", async () => {
    await db.updateSettings({ oidcIssuerUrl: "https://idp.example", oidcClientId: "client" });
    const { GET } = await import("@/app/api/settings/route.js");
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toContain("sentinel");
    expect(body).not.toHaveProperty("secretsConfigured");
    expect(body.oidcConfigured).toBe(true);
  });

  it("raw writers keep envelope bytes (settings merge, combo transform, combo rename, savings, config apply, ws settings)", async () => {
    const snapshot = () =>
      Object.fromEntries(Object.keys(SECRETS).map((k) => [k, JSON.stringify(rawBlob()[k])]));
    const before = snapshot();

    await db.updateSettings({ requireLogin: true }); // settings merge
    expect(snapshot()).toEqual(before);

    await db.updateComboStrategies((s) => ({ ...s, x: "fallback" })); // combo transform
    expect(snapshot()).toEqual(before);

    const combo = await db.createComboUnscoped({ name: "enc-a", kind: "fallback", models: [] });
    await db.updateComboUnscoped(combo.id, { name: "enc-b" }); // rename cascade
    expect(snapshot()).toEqual(before);
    await db.deleteComboUnscoped(combo.id);
    expect(snapshot()).toEqual(before);

    const { claimSavingsMilestone } = await import("@/lib/savingsMilestones.js");
    const { SAVINGS_MILESTONES } = await import("@/shared/constants/savingsMilestones.js");
    adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)`, [
      (await import("@/lib/db/repos/usageRepo.js")).SAVINGS_LIFETIME_KEY,
      String(SAVINGS_MILESTONES.at(-1) * 2),
    ]);
    await claimSavingsMilestone(SAVINGS_MILESTONES[0]); // savings acknowledgement
    expect(snapshot()).toEqual(before);

    const { applyConfig } = await import("@/lib/db/configExport.js");
    await applyConfig({ settings: { requireLogin: true }, combos: [], pricingOverrides: {} });
    expect(snapshot()).toEqual(before);

    const { removeLegacyPasswordUnscoped } = await import(
      "@/lib/db/repos/workspaceSettingsRepo.js"
    );
    adapter.run(`UPDATE settings SET data = json_set(data, '$.password', 'hash') WHERE id = 1`);
    expect(removeLegacyPasswordUnscoped(adapter)).toBe(true); // blob removal path
    expect(snapshot()).toEqual(before);
  });

  it("rejects a caller-supplied envelope instead of storing it", async () => {
    await expect(
      db.updateSettings({ oidcClientSecret: { v: 1, kid: "k", iv: "i", ct: "c", tag: "t" } }),
    ).rejects.toMatchObject({ code: "ENVELOPE_REJECTED" });
  });

  it("update returns plaintext while the stored blob stays ciphertext", async () => {
    await db.updateSettings({ requireLogin: true });
    const before = JSON.stringify(rawBlob().oidcClientSecret);
    const returned = await db.updateSettings({ oidcClientSecret: "update-return-sentinel" });
    expect(returned.oidcClientSecret).toBe("update-return-sentinel");
    const stored = JSON.stringify(rawBlob().oidcClientSecret);
    expect(stored).not.toContain("update-return-sentinel");
    expect(JSON.parse(stored)).toMatchObject({ v: 1 });
    expect(stored).not.toBe(before);
    const reread = await db.getSettings();
    expect(reread.oidcClientSecret).toBe("update-return-sentinel");
  });
});
