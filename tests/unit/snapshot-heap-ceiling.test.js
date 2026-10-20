// Heap-ceiling regression for full-instance snapshot transfer (YAN-1013, AC1).
//
// A full-instance export (exportDbToFile) and import (importDbStream) of a large
// synthetic telemetry DB must stay under a FIXED V8 heap ceiling (`heapUsed`)
// that does not grow with the telemetry row count. We run the same
// export -> import round trip at N and 4N telemetry rows and assert:
//
//   1. growth(4N) - growth(N) < 16 MiB   (no per-row heap growth)
//   2. growth(4N)             < 64 MiB   (absolute ceiling)
//   3. row-count / content parity after the import
//
// Why a materializing implementation cannot pass: at 4N the snapshot file is
// > 64 MiB (asserted below), so holding just the document text (1 byte/char
// for ASCII) already exceeds the 64 MiB ceiling, and `JSON.parse` / the
// per-row objects add several times that on top. Growth between N and 4N would
// also be ~3x the N-size document (>> 16 MiB).
//
// Sampling: export and import are synchronous-heavy, so timers cannot fire
// mid-run. We sample `heapUsed` from the `__onProgress` hooks (per page /
// batch), after a forced GC so only RETAINED heap is measured (deferred
// old-generation garbage would otherwise add run-length-dependent noise), and
// assert a minimum sample count so the test cannot pass vacuously.
//
// Documented exception: sql.js keeps its staging DB in the JS heap, so it has
// no heap ceiling and this suite is skipped there. Native drivers
// (better-sqlite3, node:sqlite, bun:sqlite) are covered.
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { STAGING_DIR } from "@/lib/db/paths.js";
import { exportDbToFile } from "@/lib/db/snapshot/exportSnapshot.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

const MIB = 1024 * 1024;
const N = 4000; // base telemetry row count (per table); 4N is the large run
const DETAIL_BYTES = 4000; // chars of `data` per requestDetails row (~4 KB)
const GROWTH_DELTA_MAX = 16 * MIB;
const GROWTH_ABS_MAX = 64 * MIB;

const NOW = "2026-10-09T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const WS = "ws-default";
const WS2 = "ws-other";
const RAW = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";

let db;
let skip = false;

// Force a full GC without needing `node --expose-gc` on the vitest worker:
// enable the flag at runtime and fetch `gc` from a fresh context.
v8.setFlagsFromString("--expose-gc");
const gc = globalThis.gc ?? vm.runInNewContext("gc");
const fullGc = () => {
  gc();
  gc();
};
// Retained heap at a progress point: collect first, so un-swept garbage (which
// V8 may legitimately defer in the old generation) does not masquerade as growth.
// A leak or a materialized document survives the collection and is measured.
const retainedHeap = () => {
  gc();
  return process.memoryUsage().heapUsed;
};

function seedBaseInstance() {
  db.exec(`DELETE FROM usageRollup; DELETE FROM requestDetails; DELETE FROM usageHistory;
    DELETE FROM auditEvents; DELETE FROM invitations; DELETE FROM budgets;
    DELETE FROM connectionGrants; DELETE FROM userPreferences; DELETE FROM workspaceSettings;
    DELETE FROM providerNodes; DELETE FROM providerConnections`);
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
     DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  for (const id of ["owner", "member1"]) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, NULL)`,
      [id, `${id}@x.test`, id, id, id === "owner" ? "owner" : "user", "hashedsecret", NOW, NOW],
    );
  }
  for (const id of [WS, WS2]) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      [id, id, "shared", "owner", NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
      [id, "owner", "owner", "manual", NOW],
    );
    db.run(`INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)`, [
      id,
      JSON.stringify({ themeOverride: id }),
      NOW,
    ]);
  }
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'member1', 'member', 'manual', ?)`,
    [WS, NOW],
  );
  for (const user of ["owner", "member1"]) {
    db.run(`INSERT INTO userPreferences(userId, data, updatedAt) VALUES(?, ?, ?)`, [
      user,
      JSON.stringify({ theme: "dark" }),
      NOW,
    ]);
  }
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-1', 'openai', 'api_key', 'Main', NULL, 1, 1, ?, ?, ?, ?, 'owner')`,
    [JSON.stringify({ accessToken: "sk-upstream-cred" }), NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, budgetId, createdByUserId, tosAcknowledgedAt, createdAt, revokedAt)
     VALUES('grant-1', 'conn-1', ?, NULL, ?, 60, 1000, NULL, 'owner', NULL, ?, NULL)`,
    [WS2, JSON.stringify(["gpt-4o"]), Date.parse(NOW)],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, machineId, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'member1', 'owner', ?, ?, ?, 'Runner', NULL, 0, 1, ?, ?)`,
    [WS, hashApiKey(RAW, HASH_KEY), KID, apiKeyPrefix(RAW), JSON.stringify(["gpt-4o"]), NOW],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

/** Replace both telemetry tables with `rows` rows each, via recursive-CTE INSERT…SELECT. */
function seedTelemetry(rows) {
  db.exec(`DELETE FROM requestDetails; DELETE FROM usageHistory`);
  db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ${rows})
    INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
    SELECT 'rd-' || x, '${NOW}', 'openai', 'gpt-4o', 'conn-1', 'ok',
           '{"b":"' || substr(hex(randomblob(${DETAIL_BYTES / 2})), 1, ${DETAIL_BYTES}) || '"}',
           '${WS}', 'owner', 'hk-1', 'grant-1' FROM cnt`);
  db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ${rows})
    INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId)
    SELECT '${NOW}', 'openai', 'gpt-4o', 'conn-1', NULL, '/v1/chat', x % 100, x % 50, 0.01, 'ok',
           '{}', '{}', '${WS}', 'owner', 'hk-1', 'grant-1' FROM cnt`);
}

const telemetryStats = () => ({
  requestDetails: db.get("SELECT COUNT(*) AS n, SUM(LENGTH(data)) AS bytes FROM requestDetails"),
  usageHistory: db.get("SELECT COUNT(*) AS n FROM usageHistory"),
});

/**
 * One export -> clear telemetry -> streamed import round trip. Returns the peak
 * heap growth (peak heapUsed - post-GC baseline) of each phase and sample counts.
 */
async function roundTrip(rows) {
  seedTelemetry(rows);
  const before = telemetryStats();
  expect(before.requestDetails.n).toBe(rows);
  expect(before.usageHistory.n).toBe(rows);

  // ---- export ----
  fullGc();
  const exportBase = process.memoryUsage().heapUsed;
  let exportPeak = exportBase;
  let exportSamples = 0;
  const handle = await exportDbToFile({
    __onProgress: (e) => {
      if (e.phase !== "export") return;
      exportSamples++;
      exportPeak = Math.max(exportPeak, retainedHeap());
    },
  });
  let importBase;
  let importPeak;
  let importSamples = 0;
  let size;
  try {
    size = handle.size;
    expect(fs.statSync(handle.file).size).toBe(size);

    // Telemetry is replaced by the import, so a no-op import could not pass parity.
    db.exec(`DELETE FROM requestDetails; DELETE FROM usageHistory`);
    expect(telemetryStats().requestDetails.n).toBe(0);

    // ---- import ----
    fullGc();
    importBase = process.memoryUsage().heapUsed;
    importPeak = importBase;
    await dbApi.importDbStream(fs.createReadStream(handle.file, { highWaterMark: 64 * 1024 }), {
      masterKey: MASTER,
      __onProgress: (e) => {
        if (e.phase !== "import") return;
        importSamples++;
        importPeak = Math.max(importPeak, retainedHeap());
      },
    });
  } finally {
    handle.cleanup();
  }

  expect(telemetryStats()).toEqual(before);
  const result = {
    size,
    exportGrowth: exportPeak - exportBase,
    importGrowth: importPeak - importBase,
    exportSamples,
    importSamples,
  };
  result.growth = Math.max(result.exportGrowth, result.importGrowth);
  return result;
}

describe("snapshot transfer heap ceiling (native drivers)", () => {
  beforeAll(async () => {
    db = await getAdapter();
    skip = db.driver === "sql.js"; // documented exception: heap-resident staging DB
    if (skip) return;
    seedBaseInstance();
  });

  afterAll(() => {
    assertIsolatedHome();
    if (fs.existsSync(STAGING_DIR)) expect(fs.readdirSync(STAGING_DIR)).toEqual([]);
  });

  it("export + streamed import heap growth is flat from N to 4N telemetry rows", async (ctx) => {
    if (skip) return ctx.skip();
    // Warm up code paths / JIT / statement caches so one-time allocation does
    // not distort the N-vs-4N comparison.
    await roundTrip(200);

    const small = await roundTrip(N);
    const large = await roundTrip(4 * N);
    const mib = (n) => `${(n / MIB).toFixed(1)} MiB`;
    console.log(
      `[heap-ceiling] N=${N}: file ${mib(small.size)}, export +${mib(small.exportGrowth)}, import +${mib(small.importGrowth)}; ` +
        `4N: file ${mib(large.size)}, export +${mib(large.exportGrowth)}, import +${mib(large.importGrowth)}; ` +
        `samples (export/import) N=${small.exportSamples}/${small.importSamples} 4N=${large.exportSamples}/${large.importSamples}`,
    );

    // The 4N snapshot alone is bigger than the ceiling, so any implementation that
    // materializes the document (string, Buffer-to-string, JSON.parse) fails below.
    expect(large.size).toBeGreaterThan(GROWTH_ABS_MAX);
    expect(large.size).toBeGreaterThan(3 * small.size);

    // Not vacuous: requestDetails pages are 200 rows, stage batches 500 rows.
    expect(large.exportSamples).toBeGreaterThanOrEqual((4 * N) / 200);
    expect(large.importSamples).toBeGreaterThanOrEqual((4 * N) / 500);
    expect(small.exportSamples).toBeGreaterThanOrEqual(N / 200);
    expect(small.importSamples).toBeGreaterThanOrEqual(N / 500);

    expect(large.growth - small.growth).toBeLessThan(GROWTH_DELTA_MAX);
    expect(large.growth).toBeLessThan(GROWTH_ABS_MAX);
    expect(fs.existsSync(STAGING_DIR) ? fs.readdirSync(STAGING_DIR) : []).toEqual([]);
    expect(path.basename(STAGING_DIR)).toBe("staging");
  }, 60_000);
});
