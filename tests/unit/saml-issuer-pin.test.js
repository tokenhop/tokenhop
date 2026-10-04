// YAN-327 migration #3: existing installs keep the SAML issuer their IdP trusts;
// only fresh installs get the active brand's default.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE, LEGACY } from "@/shared/brand";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function resetAdapter() {
  if (!tempDir) return;
  const adapters = globalThis[Symbol.for(`tokenhop.dbAdapters.${process.pid}`)];
  const dataFile = path.join(tempDir, "db", "data.sqlite");
  try {
    adapters?.get(dataFile)?.instance?.close?.();
  } finally {
    adapters?.delete(dataFile);
  }
}

beforeEach(() => {
  resetAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-saml-pin-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  resetAdapter();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const writeSettings = (db, data) =>
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify(data)],
  );
const readSettings = (db) => JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data);

// Seed a DB as the previous release left it (schemaVersion 2), then restart.
async function upgrade(seed) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  seed(db);
  db.run(`UPDATE _meta SET value = '2' WHERE key = 'schemaVersion'`);
  resetAdapter();
  vi.resetModules();
  const { getAdapter: reopen } = await import("@/lib/db/driver.js");
  return reopen();
}

describe("migration 003 pin-saml-issuer", () => {
  // legacy(9router): remove in v2
  it("pins the legacy issuer on an existing install that never stored one", async () => {
    const db = await upgrade((d) => writeSettings(d, { authMode: "sso", ssoType: "saml" }));
    expect(readSettings(db)).toEqual({
      authMode: "sso",
      ssoType: "saml",
      samlIssuer: LEGACY.samlIssuerDefault,
    });
  });

  it("keeps a stored issuer", async () => {
    const db = await upgrade((d) => writeSettings(d, { samlIssuer: "urn:custom:sp" }));
    expect(readSettings(db).samlIssuer).toBe("urn:custom:sp");
  });

  it("leaves a fresh install without a settings row, on the active default", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.get(`SELECT data FROM settings WHERE id = 1`)).toBeUndefined();
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    expect((await getSettings()).samlIssuer).toBe(ACTIVE.samlIssuerDefault);
  });

  it("is idempotent", async () => {
    const { default: m003 } = await import("@/lib/db/migrations/003-pin-saml-issuer.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    writeSettings(db, { requireLogin: true });
    m003.up(db);
    const once = readSettings(db);
    m003.up(db);
    expect(readSettings(db)).toEqual(once);
    expect(once.samlIssuer).toBe(LEGACY.samlIssuerDefault);
  });
});

describe("updateSettings", () => {
  it("pins the active default the first time SAML is configured, keeping a custom issuer", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");

    await updateSettings({ requireLogin: true });
    expect(readSettings(db).samlIssuer).toBeUndefined();

    await updateSettings({ samlEntryPoint: "https://idp.example/sso" });
    expect(readSettings(db).samlIssuer).toBe(ACTIVE.samlIssuerDefault);

    await updateSettings({ samlIssuer: "urn:custom:sp" });
    expect(readSettings(db).samlIssuer).toBe("urn:custom:sp");
  });
});
