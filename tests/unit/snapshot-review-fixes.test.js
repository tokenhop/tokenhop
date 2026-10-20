// YAN-1013 PR review regressions: rowid ≤ 0 paging, body cancellation on every
// non-clean exit, empty/iterable bodies, and the retain-time disk re-check.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { exportDb, exportDbToFile } from "@/lib/db/snapshot/exportSnapshot.js";
import { forEachBoundedPage } from "@/lib/db/snapshot/pagedRows.js";
import { __setFreeBytesProbeForTests } from "@/lib/db/stagingFiles.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  MASTER,
  NOW,
  bodyOf,
  clearSections,
  docBytes,
  fullDump,
  seedHashedInstanceFull,
  setFixtureDb,
  stagingEntries,
} from "../helpers/instanceTransferStreamFixtures.js";

vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));

let db;

beforeEach(async () => {
  db = await getAdapter();
  setFixtureDb(db);
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  seedHashedInstanceFull();
});

afterEach(() => {
  assertIsolatedHome();
  __setFreeBytesProbeForTests(null);
  fs.rmSync(path.join(process.env.DATA_DIR, "keys"), { recursive: true, force: true });
});

const usageIds = () => db.all("SELECT id FROM usageHistory ORDER BY id").map((r) => r.id);

describe("M1: rowids at or below zero are paged, not skipped", () => {
  it("forEachBoundedPage visits negative, zero and positive keys across small pages", () => {
    db.exec("DROP TABLE IF EXISTS pg_probe");
    db.exec("CREATE TABLE pg_probe(id INTEGER PRIMARY KEY, v TEXT)");
    const ids = [-9007199254740991, -3, 0, 5, 9, 12, 13];
    for (const id of ids) db.run("INSERT INTO pg_probe(id, v) VALUES(?, 'x')", [id]);
    for (const pageSize of [1, 2, 3, 100]) {
      const seen = [];
      forEachBoundedPage(
        (sql, params) => db.all(sql, params),
        { table: '"pg_probe"', key: "rowid", columns: ["v"], pageSize },
        (rows) => seen.push(...rows.map((r) => r.id)),
      );
      expect(seen, `pageSize ${pageSize}`).toEqual(ids);
    }
    db.exec("DROP TABLE pg_probe");
  });

  it("usageHistory ids -3, 0 and 5 survive export -> streamed import", async () => {
    db.run("DELETE FROM usageHistory");
    for (const id of [-3, 0, 5]) {
      db.run(
        `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId)
         VALUES(?, ?, 'openai', 'gpt-4o', 'conn-1', NULL, '/v1/chat', 1, 2, 0.5, 'ok', '{}', '{}', NULL, NULL, NULL, NULL)`,
        [id, NOW],
      );
    }
    expect(usageIds()).toEqual([-3, 0, 5]);

    const handle = await exportDbToFile();
    let bytes;
    try {
      const doc = JSON.parse(fs.readFileSync(handle.file, "utf8"));
      expect(doc.usageHistory.map((r) => r.id)).toEqual([-3, 0, 5]);
      bytes = fs.readFileSync(handle.file);
    } finally {
      handle.cleanup();
    }
    db.run("DELETE FROM usageHistory");
    await dbApi.importDbStream(bodyOf(bytes), { masterKey: MASTER });
    expect(usageIds()).toEqual([-3, 0, 5]);
  });

  it("an absent usageHistory section retains rows with ids <= 0", async () => {
    db.run("DELETE FROM usageHistory");
    for (const id of [-1, 0, 2]) {
      db.run(
        `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, 'openai', 'gpt-4o', 'conn-1', '/v1/chat', 1, 2, 0.5, 'ok', '{}', '{}')`,
        [id, NOW],
      );
    }
    const slim = structuredClone(await exportDb());
    delete slim.usageHistory;
    await dbApi.importDbStream(bodyOf(slim), { masterKey: MASTER });
    expect(usageIds()).toEqual([-1, 0, 2]);
  });
});

/** A web ReadableStream that records cancel() and never closes by itself. */
function webBody(chunks, { stallAfter = false } = {}) {
  const state = { cancelled: false };
  let i = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          return undefined;
        }
        if (stallAfter) return new Promise(() => {});
        controller.close();
        return undefined;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("M2: the request body is cancelled on every non-clean exit", () => {
  it("oversized body cancels a web ReadableStream", async () => {
    const bytes = docBytes(await exportDb());
    const { stream, state } = webBody([bytes.subarray(0, 4000), bytes.subarray(4000)]);
    await expect(
      dbApi.importDbStream(stream, { masterKey: MASTER, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "IMPORT_PAYLOAD_TOO_LARGE" });
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
    expect(stagingEntries()).toEqual([]);
  });

  it("a stalled web ReadableStream is cancelled and reported as incomplete", async () => {
    const bytes = docBytes(await exportDb());
    const { stream, state } = webBody([bytes.subarray(0, 100)], { stallAfter: true });
    await expect(
      dbApi.importDbStream(stream, { masterKey: MASTER, idleTimeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "TRANSFER_FORMAT_INVALID", message: "Upload was incomplete" });
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
  });

  it("invalid JSON and a rejected schema gate cancel the body", async () => {
    const garbage = webBody([new TextEncoder().encode("not json at all")]);
    await expect(dbApi.importDbStream(garbage.stream, { masterKey: MASTER })).rejects.toMatchObject(
      { code: "IMPORT_JSON_INVALID" },
    );
    await vi.waitFor(() => expect(garbage.state.cancelled).toBe(true));

    const newer = webBody([new TextEncoder().encode('{"schemaVersion":99999,"x":[1,2,3]}')]);
    await expect(dbApi.importDbStream(newer.stream, { masterKey: MASTER })).rejects.toThrow(
      /newer version/,
    );
    await vi.waitFor(() => expect(newer.state.cancelled).toBe(true));
  });

  it("a clean import does not cancel the body", async () => {
    const bytes = docBytes(await exportDb());
    const { stream, state } = webBody([bytes]);
    clearSections();
    await dbApi.importDbStream(stream, { masterKey: MASTER });
    expect(state.cancelled).toBe(false);
  });

  it("a failing iterator.return() never masks the original error", async () => {
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: Buffer.from("{".repeat(10)) }),
          return() {
            throw new Error("return exploded");
          },
        };
      },
    };
    await expect(dbApi.importDbStream(source, { masterKey: MASTER })).rejects.toMatchObject({
      code: "IMPORT_JSON_INVALID",
    });
  });
});

describe("L1: null and iterable bodies", () => {
  it("an empty body array yields IMPORT_JSON_INVALID (route passes request.body ?? [])", async () => {
    const before = fullDump();
    await expect(dbApi.importDbStream([], { masterKey: MASTER })).rejects.toMatchObject({
      code: "IMPORT_JSON_INVALID",
    });
    await expect(dbApi.importDbStream(null, { masterKey: MASTER })).rejects.toMatchObject({
      code: "IMPORT_JSON_INVALID",
    });
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
  });

  it("a sync iterable (array) of chunks is accepted", async () => {
    const bytes = docBytes(await exportDb());
    const before = fullDump();
    await dbApi.importDbStream([bytes.subarray(0, 500), bytes.subarray(500)], {
      masterKey: MASTER,
    });
    expect(fullDump()).toBe(before);
  });
});

describe("L3: retaining absent live sections re-checks the disk", () => {
  it("fails IMPORT_DISK_INSUFFICIENT when space ran out after the upload", async () => {
    const slim = structuredClone(await exportDb());
    delete slim.usageHistory;
    const bytes = docBytes(slim);
    const before = fullDump();
    // Plenty of space for the upload-time check, none by the time retain runs.
    let calls = 0;
    __setFreeBytesProbeForTests(() => (++calls <= 2 ? 1e15 : 1024));
    await expect(
      dbApi.importDbStream(bodyOf(bytes), { masterKey: MASTER, declaredBytes: bytes.length }),
    ).rejects.toMatchObject({ code: "IMPORT_DISK_INSUFFICIENT" });
    __setFreeBytesProbeForTests(null);
    expect(fullDump()).toBe(before);
    expect(stagingEntries()).toEqual([]);
  });
});
