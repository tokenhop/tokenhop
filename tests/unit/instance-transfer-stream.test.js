// Streaming export writer parity (YAN-1013): the file produced by
// exportDbToFile must JSON.parse to exactly what the in-memory exportDb()
// returns (values AND key order), for v2/v3/legacy shapes with the multi-user
// switch on and off, portable included. Real adapter + isolated DATA_DIR.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { STAGING_DIR } from "@/lib/db/paths.js";
import { exportDb, exportDbToFile } from "@/lib/db/snapshot/exportSnapshot.js";
import { deriveApiKeyHashKey, masterKeyId } from "@/lib/security/masterKey.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  MASTER,
  NOW,
  OTHER_MASTER,
  WS,
  encryptedSeed,
  seedHashedInstanceFull,
  setFixtureDb,
  stagingEntries,
} from "../helpers/instanceTransferStreamFixtures.js";

let multiUser = true;
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: vi.fn(async () => multiUser),
}));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));
// Portable exports load the instance root; hand out a fresh copy of the test root.
vi.mock("@/lib/security/masterKey.js", async (importOriginal) => {
  const actual = await importOriginal();
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
  return {
    ...actual,
    loadMasterKey: vi.fn(async () => ({ kid: actual.masterKeyId(key), key: Buffer.from(key) })),
  };
});

let db;

async function expectParity(opts) {
  const expected = await dbApi.exportDb(opts);
  const handle = await exportDbToFile(opts);
  try {
    expect(handle.size).toBe(fs.statSync(handle.file).size);
    const actual = JSON.parse(fs.readFileSync(handle.file, "utf8"));
    expect(actual).toEqual(expected);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    // Nested key order too (row objects), not just top-level.
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    return actual;
  } finally {
    handle.cleanup();
  }
}

beforeEach(async () => {
  db = await getAdapter();
  setFixtureDb(db);
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  multiUser = true;
  vi.clearAllMocks();
});

afterEach(() => {
  assertIsolatedHome();
  fs.rmSync(path.join(process.env.DATA_DIR, "keys"), { recursive: true, force: true });
});

// Runs first, while the DB still has the pristine (plain, non-hashed) apiKeys table.
describe("legacy storage shape", () => {
  it("matches the in-memory export (switch off, plain keys)", async () => {
    multiUser = false;
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'a1', '"openai/gpt-4o"'), ('pricing', 'p1', '{"x":1}')`,
    );
    const snap = await expectParity();
    expect(snap.formatVersion).toBeUndefined();
    expect(snap.modelAliases).toEqual({ a1: "openai/gpt-4o" });
  });
});

describe("hashed v2 shape", () => {
  beforeEach(seedHashedInstanceFull);

  it("matches the in-memory export with the switch on (all sections streamed)", async () => {
    const snap = await expectParity();
    expect(snap.formatVersion).toBe(2);
    for (const name of [
      "usageHistory",
      "requestDetails",
      "usageRollup",
      "budgets",
      "auditEvents",
    ]) {
      expect(snap[name].length).toBeGreaterThan(0);
    }
  });

  it("matches the in-memory export with the switch off", async () => {
    multiUser = false;
    const snap = await expectParity();
    expect(snap.formatVersion).toBe(2);
    expect(Object.hasOwn(snap, "usageHistory")).toBe(false);
  });

  it("pages sections larger than one page and reports progress", async () => {
    db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 450)
      INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
      SELECT 'bulk-' || x, '${NOW}', 'openai', 'gpt-4o', 'conn-1', 'ok', '{}', '${WS}', 'owner', 'hk-1', 'grant-1' FROM cnt`);
    const events = [];
    const handle = await exportDbToFile({ __onProgress: (e) => events.push(e) });
    try {
      const snap = JSON.parse(fs.readFileSync(handle.file, "utf8"));
      expect(snap.requestDetails).toHaveLength(451);
      const rd = events.filter((e) => e.section === "requestDetails");
      expect(rd.length).toBeGreaterThan(1);
      expect(rd.at(-1)).toMatchObject({ phase: "export", rows: 451 });
    } finally {
      handle.cleanup();
    }
    expect(JSON.stringify(await exportDb())).toBe(JSON.stringify(await dbApi.exportDb()));
  });
});

describe("encrypted v3 shape + portable", () => {
  beforeEach(encryptedSeed);

  it("matches the in-memory export", async () => {
    const snap = await expectParity();
    expect(snap.formatVersion).toBe(3);
  });

  it("portable export round-trips under another KEK; wrong passphrase is rejected", async () => {
    const { encryptBytes, decryptBytes, buildDekWrapAad, buildHashKeyWrapAad } = await import(
      "@/lib/security/envelope.js"
    );
    const portable = await exportDb({ passphrase: "portable" });
    expect(portable.credentialEncryption.portable).toBeDefined();
    // Same document as the old head-clone path produced.
    const viaOld = await dbApi.exportDb({ passphrase: "portable" });
    expect(Object.keys(portable)).toEqual(Object.keys(viaOld));
    expect(portable.usageHistory).toEqual(viaOld.usageHistory);

    const source = await dbApi.exportDb();
    const targetKid = masterKeyId(OTHER_MASTER);
    const targetHash = deriveApiKeyHashKey(OTHER_MASTER);
    for (const row of source.workspaceKeys) {
      const dek = decryptBytes(
        MASTER,
        JSON.parse(row.wrappedDek),
        buildDekWrapAad(row.workspaceId, row.kid),
      );
      const wrapped = JSON.stringify(
        encryptBytes(OTHER_MASTER, targetKid, dek, buildDekWrapAad(row.workspaceId, row.kid)),
      );
      dek.fill(0);
      db.run("UPDATE workspaceKeys SET wrappedDek = ? WHERE workspaceId = ?", [
        wrapped,
        row.workspaceId,
      ]);
    }
    db.run("UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'", [targetKid]);
    db.run("UPDATE _meta SET value = ? WHERE key = 'apiKeysHashKid'", [targetKid]);
    db.run("UPDATE apiKeys SET hashKid = ?", [targetKid]);
    db.run("UPDATE _meta SET value = ? WHERE key = 'apiKeyHashKeyWrapped'", [
      JSON.stringify(
        encryptBytes(OTHER_MASTER, targetKid, targetHash, buildHashKeyWrapAad(WS, targetKid)),
      ),
    ]);
    targetHash.fill(0);

    await expect(
      dbApi.importDb(structuredClone(portable), { masterKey: OTHER_MASTER, passphrase: "wrong" }),
    ).rejects.toMatchObject({ code: "INSTANCE_PORTABLE_INVALID" });
    await dbApi.importDb(structuredClone(portable), {
      masterKey: OTHER_MASTER,
      passphrase: "portable",
    });
    expect(db.get("SELECT keyHash FROM apiKeys WHERE id = 'hk-1'").keyHash).toBeTruthy();
    expect(stagingEntries()).toEqual([]);
  });

  it("passphrase export without Users & teams is unsupported", async () => {
    multiUser = false;
    await expect(exportDbToFile({ passphrase: "p" })).rejects.toMatchObject({
      code: "TRANSFER_PORTABLE_UNSUPPORTED",
    });
    expect(stagingEntries()).toEqual([]);
  });
});

describe("staging hygiene", () => {
  beforeEach(seedHashedInstanceFull);

  it("creates private files/dirs and cleanup empties staging", async () => {
    const handle = await exportDbToFile();
    try {
      if (process.platform !== "win32") {
        expect(fs.statSync(handle.file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(handle.file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(STAGING_DIR).mode & 0o777).toBe(0o700);
      }
      expect(stagingEntries()).toHaveLength(1);
    } finally {
      handle.cleanup();
    }
    expect(stagingEntries()).toEqual([]);
  });

  it("openStream serves the bytes and leaves no staging behind", async () => {
    const handle = await exportDbToFile();
    const stream = handle.openStream();
    if (process.platform !== "win32") expect(stagingEntries()).toEqual([]);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(handle.size);
    expect(JSON.parse(body.toString("utf8")).formatVersion).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stagingEntries()).toEqual([]);
  });

  it("removes the staging dir when the export throws mid-write", async () => {
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.run(
        `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdByUserId, createdAt)
         VALUES('budget-bad', 'ghost-ws', 'workspace', 'ghost-ws', 'day', 1, 'owner', ?)`,
        [NOW],
      );
      await expect(exportDbToFile()).rejects.toMatchObject({ code: "TRANSFER_REF_INVALID" });
      expect(stagingEntries()).toEqual([]);
    } finally {
      db.run("DELETE FROM budgets WHERE id = 'budget-bad'");
      db.exec("PRAGMA foreign_keys = ON");
    }
  });
});
