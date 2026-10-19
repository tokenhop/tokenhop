// Streamed import (YAN-1013): importDbStream over chunked request bodies —
// parity with the in-memory importDb, rejection atomicity, absent/empty
// sections and review-fix regressions. Real adapter + isolated DATA_DIR.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { exportDb } from "@/lib/db/snapshot/exportSnapshot.js";
import { __setFreeBytesProbeForTests } from "@/lib/db/stagingFiles.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  MASTER,
  NOW,
  WS,
  attachedNames,
  bodyOf,
  clearSections,
  docBytes,
  encryptedSeed,
  fullDump,
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

describe("streamed import: legacy shape", () => {
  it("imports an old pretty-printed file without schemaVersion and strips request-control keys", async () => {
    multiUser = false;
    // Previously seeded by the export file's "legacy storage shape" test running first.
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'a1', '"openai/gpt-4o"'), ('pricing', 'p1', '{"x":1}')`,
    );
    const doc = await exportDb();
    delete doc.schemaVersion;
    doc.password = "from-file";
    doc.ssoProof = "proof";
    doc.passphrase = "pp";
    doc.force = true;
    db.run("DELETE FROM kv WHERE scope = 'modelAliases'");
    let seenKeys = null;
    await dbApi.importDbStream(bodyOf(doc, { pretty: true, chunk: 7 }), {
      transformHead: (head) => {
        seenKeys = Object.keys(head);
        head.pricing = { ...head.pricing, fromHook: { x: 1 } };
        return head;
      },
    });
    for (const key of ["password", "ssoProof", "passphrase", "force"]) {
      expect(seenKeys).not.toContain(key);
    }
    expect(db.get("SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'a1'")).toBeTruthy();
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'pricing' AND key = 'fromHook'"),
    ).toBeTruthy();
    expect(stagingEntries()).toEqual([]);
    expect(attachedNames()).not.toContain("xstage");
  });
});

const SHAPES = [
  ["v2", seedHashedInstanceFull, 2],
  ["v3", encryptedSeed, 3],
];

describe.each(SHAPES)("streamed import parity (%s)", (_name, seed, formatVersion) => {
  beforeEach(seed);

  it.each([
    ["compact", false, 4096],
    ["pretty", true, 4096],
    ["compact", false, 1024 * 1024],
    ["pretty", true, 1024 * 1024],
    ["compact", false, 1],
    ["pretty", true, 1],
  ])("%s export, %s pretty, chunk %i reproduces every table", async (_label, pretty, chunk) => {
    const doc = await exportDb();
    expect(doc.formatVersion).toBe(formatVersion);
    const before = fullDump();
    clearSections();
    db.run("UPDATE workspaces SET name = 'changed'");
    expect(fullDump()).not.toBe(before);
    const events = [];
    const result = await dbApi.importDbStream(bodyOf(doc, { pretty, chunk }), {
      masterKey: MASTER,
      __onProgress: (e) => events.push(e),
    });
    expect(result).toBeUndefined();
    expect(fullDump()).toBe(before);
    expect(events.some((e) => e.phase === "import" && e.section === "usageHistory")).toBe(true);
    expect(stagingEntries()).toEqual([]);
    expect(attachedNames()).not.toContain("xstage");
  });

  it("stages sections larger than one batch", async () => {
    db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 1300)
      INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
      SELECT 'bulk-' || x, '${NOW}', 'openai', 'gpt-4o', 'conn-1', 'ok', '{"n":' || x || '}', '${WS}', 'owner', 'hk-1', 'grant-1' FROM cnt`);
    const doc = await exportDb();
    const before = fullDump();
    clearSections();
    await dbApi.importDbStream(bodyOf(doc, { chunk: 65536 }), { masterKey: MASTER });
    expect(fullDump()).toBe(before);
    expect(db.get("SELECT COUNT(*) AS n FROM requestDetails").n).toBe(1301);
  });

  it("matches the in-memory importDb result", async () => {
    const doc = await exportDb();
    clearSections();
    await dbApi.importDb(structuredClone(doc), { masterKey: MASTER });
    const viaMemory = fullDump();
    clearSections();
    await dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER });
    expect(fullDump()).toBe(viaMemory);
  });
});

describe("streamed import: portable", () => {
  beforeEach(encryptedSeed);

  it("right passphrase restores; wrong passphrase / missing passphrase change nothing", async () => {
    const portable = await exportDb({ passphrase: "portable" });
    const before = fullDump();
    clearSections();
    const cleared = fullDump();

    await expect(
      dbApi.importDbStream(bodyOf(portable), { masterKey: MASTER, passphrase: "wrong" }),
    ).rejects.toMatchObject({ code: "INSTANCE_PORTABLE_INVALID" });
    expect(fullDump()).toBe(cleared);
    expect(stagingEntries()).toEqual([]);

    // A passphrase carried INSIDE the file is stripped, never trusted.
    await expect(
      dbApi.importDbStream(bodyOf({ ...portable, passphrase: "portable" }), { masterKey: MASTER }),
    ).rejects.toMatchObject({ code: "TRANSFER_PASSPHRASE_REQUIRED" });
    expect(fullDump()).toBe(cleared);

    await dbApi.importDbStream(bodyOf(portable, { chunk: 777 }), {
      masterKey: MASTER,
      passphrase: "portable",
    });
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
  });
});

describe("streamed import: rejection leaves no mutation", () => {
  beforeEach(encryptedSeed);

  async function expectRejected(body, opts, matcher) {
    const before = fullDump();
    await expect(dbApi.importDbStream(body, { masterKey: MASTER, ...opts })).rejects.toMatchObject(
      matcher,
    );
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
    expect(attachedNames()).not.toContain("xstage");
  }

  it("tampered providerConnections data envelope", async () => {
    const doc = await exportDb();
    const data = JSON.parse(doc.providerConnections[0].data);
    const env = data.accessToken;
    expect(typeof env?.ct).toBe("string");
    env.ct = (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1);
    doc.providerConnections[0].data = JSON.stringify(data);
    await expectRejected(
      bodyOf(doc, { chunk: 513 }),
      {},
      { code: expect.stringMatching(/^TRANSFER_/) },
    );
  });

  it("ghost grant reference (TRANSFER_REF_INVALID)", async () => {
    const doc = await exportDb();
    doc.connectionGrants[0].connectionId = "conn-ghost";
    await expectRejected(bodyOf(doc), {}, { code: "TRANSFER_REF_INVALID" });
  });

  it("failed foreign_key_check after apply rolls everything back", async () => {
    const doc = await exportDb();
    clearSections();
    const before = fullDump();
    const original = db.all.bind(db);
    const spy = vi
      .spyOn(db, "all")
      .mockImplementation((sql, ...rest) =>
        typeof sql === "string" && sql.includes("foreign_key_check")
          ? [{ table: "usageHistory", rowid: 1, parent: "workspaces", fkid: 0 }]
          : original(sql, ...rest),
      );
    try {
      await expect(dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER })).rejects.toMatchObject({
        code: "TRANSFER_APPLY_INVALID",
      });
    } finally {
      spy.mockRestore();
    }
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
    expect(attachedNames()).not.toContain("xstage");
    // The connection is healthy again: the same import now succeeds.
    await dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER });
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBeGreaterThan(0);
  });

  it("duplicate rows keep today's messages", async () => {
    const doc = await exportDb();
    const dupUsage = structuredClone(doc);
    dupUsage.usageHistory.push({ ...dupUsage.usageHistory[0] });
    await expectRejected(
      bodyOf(dupUsage),
      {},
      { code: "TRANSFER_STATE_INVALID", message: "duplicate usageHistory row" },
    );
    const dupToken = structuredClone(doc);
    dupToken.invitations.push({ ...dupToken.invitations[0], id: "invite-2" });
    await expectRejected(
      bodyOf(dupToken),
      {},
      { code: "TRANSFER_STATE_INVALID", message: "duplicate invitations tokenHash in snapshot" },
    );
    const dupId = structuredClone(doc);
    dupId.invitations.push({ ...dupId.invitations[0], tokenHash: "1".repeat(64) });
    await expectRejected(
      bodyOf(dupId),
      {},
      { code: "TRANSFER_STATE_INVALID", message: "duplicate invitations row" },
    );
  });

  it("invalid row values / unknown fields / non-array sections", async () => {
    const doc = await exportDb();
    const nested = structuredClone(doc);
    nested.budgets[0].limitUsd = { a: 1 };
    await expectRejected(
      bodyOf(nested),
      {},
      { code: "TRANSFER_STATE_INVALID", message: "budgets entry has an invalid value" },
    );
    const unknown = structuredClone(doc);
    unknown.budgets[0].mystery = "x";
    await expectRejected(bodyOf(unknown), {}, { code: "TRANSFER_STATE_INVALID" });
    const notArray = structuredClone(doc);
    notArray.usageHistory = { id: 1 };
    await expectRejected(
      bodyOf(notArray),
      {},
      { code: "TRANSFER_STATE_INVALID", message: "usageHistory must be an array" },
    );
  });

  it("truncated body", async () => {
    const bytes = docBytes(await exportDb());
    await expectRejected(
      bodyOf(bytes.subarray(0, bytes.length - 25)),
      {},
      { code: "IMPORT_JSON_INVALID" },
    );
    await expectRejected(
      bodyOf(Buffer.concat([bytes, Buffer.from(" trailing")])),
      {},
      { code: "IMPORT_JSON_INVALID" },
    );
  });

  it("a body stream that errors mid-upload", async () => {
    const bytes = docBytes(await exportDb());
    async function* broken() {
      yield bytes.subarray(0, Math.floor(bytes.length / 2));
      throw new Error("socket reset");
    }
    await expectRejected(broken(), {}, { message: "socket reset" });
  });

  it("body over maxBytes and declared length mismatches", async () => {
    const bytes = docBytes(await exportDb());
    await expectRejected(
      bodyOf(bytes, { chunk: 1000 }),
      { maxBytes: Math.floor(bytes.length / 2) },
      { code: "IMPORT_PAYLOAD_TOO_LARGE" },
    );
    await expectRejected(
      bodyOf(bytes),
      { declaredBytes: bytes.length + 10 },
      { code: "TRANSFER_FORMAT_INVALID", message: "Upload was incomplete" },
    );
    await expectRejected(
      bodyOf(bytes),
      { declaredBytes: bytes.length - 10 },
      { code: "TRANSFER_FORMAT_INVALID", message: "Upload was incomplete" },
    );
  });

  it("low disk at staging fails before reading any body byte", async () => {
    const bytes = docBytes(await exportDb());
    let pulled = false;
    async function* body() {
      pulled = true;
      yield bytes;
    }
    __setFreeBytesProbeForTests(() => 1024 * 1024);
    try {
      await expectRejected(
        body(),
        { declaredBytes: bytes.length },
        { code: "IMPORT_DISK_INSUFFICIENT" },
      );
    } finally {
      __setFreeBytesProbeForTests(null);
    }
    expect(pulled).toBe(false);
  });
});

describe("streamed import: absent vs empty sections", () => {
  beforeEach(seedHashedInstanceFull);

  it("absent section retains live rows with SET-NULL attribution; [] clears", async () => {
    const doc = await exportDb();
    // Live-only workspace (not in the snapshot) with attributed telemetry.
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-live-only','L','shared','owner',?,?)`,
      [NOW, NOW],
    );
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId)
       VALUES(?, 'openai', 'gpt-4o', 'conn-1', NULL, '/v1/chat', 1, 2, 0.5, 'ok', '{}', '{}', 'ws-live-only', 'owner', 'hk-1', NULL)`,
      [NOW],
    );
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
       VALUES('rd-live', ?, 'openai', 'gpt-4o', 'conn-1', 'ok', '{}', 'ws-live-only', 'owner', 'hk-1', NULL)`,
      [NOW],
    );
    const liveUsage = db.all("SELECT * FROM usageHistory ORDER BY id");
    expect(liveUsage).toHaveLength(2);
    const slim = structuredClone(doc);
    delete slim.usageHistory;
    delete slim.requestDetails;
    slim.auditEvents = [];
    await dbApi.importDbStream(bodyOf(slim, { pretty: true, chunk: 333 }), { masterKey: MASTER });

    const usage = db.all("SELECT * FROM usageHistory ORDER BY id");
    expect(usage.map((r) => r.id)).toEqual(liveUsage.map((r) => r.id));
    expect(usage[0].workspaceId).toBe(WS);
    expect(usage[1].workspaceId).toBeNull(); // workspace replaced by the snapshot
    expect(usage[1].userId).toBe("owner");
    const rd = db.all("SELECT id, workspaceId, userId FROM requestDetails ORDER BY id");
    expect(rd.map((r) => r.id)).toEqual(["rd-1", "rd-live"]);
    expect(rd.find((r) => r.id === "rd-live").workspaceId).toBeNull();
    expect(db.get("SELECT COUNT(*) AS n FROM auditEvents").n).toBe(0);
    expect(db.get("SELECT id FROM workspaces WHERE id = 'ws-live-only'")).toBeUndefined();
    expect(stagingEntries()).toEqual([]);
  });
});
