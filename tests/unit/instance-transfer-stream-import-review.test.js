// Streamed import (YAN-1013), review-fix regressions: large rows, stalls, schema gate,
// lock (split from instance-transfer-stream-import.test.js). Real adapter + isolated
// DATA_DIR.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { exportDb, exportDbToFile } from "@/lib/db/snapshot/exportSnapshot.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  MASTER,
  NOW,
  WS,
  attachedNames,
  bodyOf,
  chunksOf,
  clearSections,
  docBytes,
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

describe("review fixes: large rows, stalls, schema gate, lock", () => {
  beforeEach(seedHashedInstanceFull);

  it("round-trips a requestDetails row above the splitter's default 8 MiB element cap", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    db.run("UPDATE requestDetails SET data = ? WHERE id = 'rd-1'", [big]);
    const doc = await exportDb();
    expect(doc.requestDetails[0].data.length).toBe(big.length);
    clearSections();
    await dbApi.importDbStream(bodyOf(doc, { chunk: 1024 * 1024 }), { masterKey: MASTER });
    expect(db.get("SELECT length(data) AS n FROM requestDetails WHERE id = 'rd-1'").n).toBe(
      big.length,
    );
    expect(stagingEntries()).toEqual([]);
  });

  it("export refuses a row the importer would reject and cleans staging", async () => {
    db.run("UPDATE requestDetails SET data = ? WHERE id = 'rd-1'", ["y".repeat(5000)]);
    await expect(exportDbToFile({ __maxRowBytes: 4000 })).rejects.toMatchObject({
      code: "EXPORT_ROW_TOO_LARGE",
    });
    expect(stagingEntries()).toEqual([]);
    // Within the cap it still works.
    const handle = await exportDbToFile({ __maxRowBytes: 10_000 });
    handle.cleanup();
  });

  it("export pages are byte-bounded: rows split across pages keep order and content", async () => {
    const pad = "p".repeat(100_000);
    db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 120)
      INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
      SELECT 'pg-' || printf('%04d', x), '${NOW}', 'openai', 'gpt-4o', 'conn-1', 'ok', '${pad}', '${WS}', 'owner', 'hk-1', 'grant-1' FROM cnt`);
    const events = [];
    const handle = await exportDbToFile({ __onProgress: (e) => events.push(e) });
    try {
      const doc = JSON.parse(fs.readFileSync(handle.file, "utf8"));
      const ids = doc.requestDetails.map((r) => r.id);
      expect(ids).toHaveLength(121);
      expect(ids.slice(1)).toEqual([...ids.slice(1)].sort());
      // 200-row pages of ~100 KB rows would be 20 MB: the byte budget forces >1 page.
      expect(events.filter((e) => e.section === "requestDetails").length).toBeGreaterThan(1);
    } finally {
      handle.cleanup();
    }
  });

  it("aborts a stalled upload with 'Upload was incomplete' and cleans up", async () => {
    const bytes = docBytes(await exportDb());
    let returned = false;
    const stalled = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (!sent) {
              sent = true;
              return Promise.resolve({ done: false, value: bytes.subarray(0, 100) });
            }
            return new Promise(() => {}); // never resolves
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true });
          },
        };
      },
    };
    const before = fullDump();
    await expect(
      dbApi.importDbStream(stalled, { masterKey: MASTER, idleTimeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "TRANSFER_FORMAT_INVALID", message: "Upload was incomplete" });
    expect(returned).toBe(true);
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
    expect(attachedNames()).not.toContain("xstage");
  });

  it("rejects schemaVersion above the latest as soon as it is seen", async () => {
    const doc = await exportDb();
    const { schemaVersion: _drop, ...rest } = doc;
    const text = JSON.stringify({ schemaVersion: 9999, ...rest });
    let pulled = 0;
    async function* body() {
      const bytes = Buffer.from(text);
      for (const chunk of chunksOf(bytes, 512)) {
        pulled++;
        yield chunk;
      }
    }
    await expect(dbApi.importDbStream(body(), { masterKey: MASTER })).rejects.toThrow(
      /newer version \(schema 9999/,
    );
    // Rejected within the first chunk, not after streaming the whole upload.
    expect(pulled).toBe(1);
    expect(stagingEntries()).toEqual([]);
  });

  it("keeps a __proto__ top-level key as data, not a prototype", async () => {
    const doc = await exportDb();
    const text = JSON.stringify(doc).replace(/^\{/, '{"__proto__":{"polluted":true},');
    await dbApi.importDbStream(Readable.from([Buffer.from(text)]), { masterKey: MASTER });
    expect({}.polluted).toBeUndefined();
  });

  it("keeps the import lock tail on globalThis (HMR double instantiation)", async () => {
    const key = Symbol.for("tokenhop.instanceImportLock");
    expect(globalThis[key]).toBeInstanceOf(Promise);
    const { withInstanceImportLock } = await import("@/lib/db/snapshot/transferLock.js?dup");
    const order = [];
    let release;
    const first = dbApi.importDbStream(
      (async function* () {
        await new Promise((r) => {
          release = r;
        });
        yield Buffer.from("{");
      })(),
      { masterKey: MASTER },
    );
    first.catch(() => {});
    const second = withInstanceImportLock(async () => order.push("second"));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // a second module instance still waits for the first import
    release();
    await first.catch(() => {});
    await second;
    expect(order).toEqual(["second"]);
  });
});
