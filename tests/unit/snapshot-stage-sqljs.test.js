// YAN-1013 independent oracle (review finding M6). The sql.js stage backend
// (importStageSqljs.js) is a separate in-memory SQL.Database whose rows are
// copied through JS, and it is the one path the default test run never takes
// (Node picks a native driver). Force the sql.js adapter by making both native
// adapters unavailable, then compare what the staged import stores against the
// ORIGINAL bind path `insertInstanceTableSections`, via typeof()/quote().
import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { insertInstanceTableSections } from "@/lib/db/helpers/instanceSnapshotTables.js";
import { STAGING_DIR } from "@/lib/db/paths.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import {
  MASTER,
  SECTION_TABLES,
  bodyOf,
  clearSections,
  dumpSections,
  insertViaOracle,
  seedHashedGraph,
  stateDump,
  trickySections,
} from "../helpers/snapshotOracle.js";

vi.mock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
  throw new Error("simulated unavailable");
});
vi.mock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
  throw new Error("simulated unavailable");
});
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

let db;
let tricky;
let doc;
let oracleDump;
let oracleExport;

const stagingEntries = () => (fs.existsSync(STAGING_DIR) ? fs.readdirSync(STAGING_DIR) : []);

beforeAll(async () => {
  db = await getAdapter();
});

beforeEach(async () => {
  expect(db.driver).toBe("sql.js");
  tricky = trickySections();
  seedHashedGraph(db);
  doc = { ...(await dbApi.exportDb()), ...structuredClone(tricky) };
  // The oracle: original bind path, then remember exactly what it stored.
  clearSections(db);
  insertViaOracle(db, insertInstanceTableSections, tricky);
  oracleDump = dumpSections(db);
  // Export of the oracle-written DB: the expected document for round trips.
  oracleExport = await dbApi.exportDb();
  clearSections(db);
});

afterEach(() => {
  assertIsolatedHome();
});

describe("sql.js stage backend vs the original bind path", () => {
  it("runs on the sql.js adapter and the oracle dump covers the tricky classes", () => {
    expect(db.driver).toBe("sql.js");
    expect(oracleDump.budgets[0].limitUsd).toBe("real:5.0");
    expect(oracleDump.budgets[1].limitUsd).toBe("real:0.1");
    expect(oracleDump.budgets[1].limitTokens).toBe("integer:9007199254740991");
    expect(oracleDump.workspaceSettings[0].updatedAt).toBe("text:''");
    expect(oracleDump.workspaceSettings[1].updatedAt).toBe("null:NULL");
    expect(oracleDump.userPreferences[1].updatedAt).toBe("text:'007'");
    expect(oracleDump.usageRollup[1].latencyHistogram).toBe("text:'[0,0,0,0,0,0,0,0,0,0,0,0]'");
    expect(oracleDump.usageRollup[1].latencySumMs).toBe("real:0.0");
    for (const table of SECTION_TABLES) expect(oracleDump[table].length).toBeGreaterThan(0);
  });

  it("importDb (in-memory payload) stores exactly what the oracle stores", async () => {
    await dbApi.importDb(structuredClone(doc), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
    expect(stagingEntries()).toEqual([]);
  });

  it("importDbStream (byte stream, small chunks) stores exactly what the oracle stores", async () => {
    await dbApi.importDbStream(bodyOf(doc, 509), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
    expect(stagingEntries()).toEqual([]);
  });

  it("round-trips: restored instance exports the same sections", async () => {
    await dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER });
    const restored = await dbApi.exportDb();
    for (const table of SECTION_TABLES) {
      expect(JSON.stringify(restored[table]), table).toBe(JSON.stringify(oracleExport[table]));
    }
  });

  it("an absent section retains the live rows exactly (retain path)", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const slim = structuredClone(doc);
    for (const table of SECTION_TABLES) delete slim[table];
    await dbApi.importDbStream(bodyOf(slim, 997), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
  });

  it("retain nulls attribution to a replaced workspace/user; explicit [] clears", async () => {
    // Live-only workspace with attributed telemetry and a live-only audit row.
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-live-only', 'L', 'shared', 'owner', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, workspaceId, userId, cost) VALUES('t', 'openai', 'ws-live-only', 'owner', 0.25)`,
    );
    db.run(
      `INSERT INTO requestDetails(id, timestamp, data, workspaceId, userId) VALUES('rd-live', 't', '{}', 'ws-live-only', 'member1')`,
    );
    db.run(`INSERT INTO auditEvents(id, ts, action) VALUES('audit-live', 't', 'x.poke')`);
    const slim = structuredClone(doc);
    delete slim.usageHistory;
    delete slim.requestDetails;
    slim.auditEvents = [];
    await dbApi.importDbStream(bodyOf(slim), { masterKey: MASTER });
    expect(db.all("SELECT cost, workspaceId, userId FROM usageHistory")).toEqual([
      { cost: 0.25, workspaceId: null, userId: "owner" },
    ]);
    expect(db.all("SELECT id, workspaceId, userId FROM requestDetails")).toEqual([
      { id: "rd-live", workspaceId: null, userId: "member1" },
    ]);
    expect(db.get("SELECT COUNT(*) AS n FROM auditEvents").n).toBe(0);
    // The sections the snapshot did carry were written through the stage.
    expect(dumpSections(db).budgets).toEqual(oracleDump.budgets);
  });

  it("a ref-invalid row is rejected before mutation; staging leaves nothing behind", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const before = stateDump(db);
    const bad = structuredClone(doc);
    bad.connectionGrants[0].connectionId = "conn-ghost";
    await expect(dbApi.importDbStream(bodyOf(bad), { masterKey: MASTER })).rejects.toMatchObject({
      code: "TRANSFER_REF_INVALID",
    });
    expect(stateDump(db)).toBe(before);
    expect(stagingEntries()).toEqual([]);
    // The adapter is healthy afterwards: the same document without the defect imports.
    await dbApi.importDbStream(bodyOf(doc), { masterKey: MASTER });
    expect(dumpSections(db)).toEqual(oracleDump);
  });

  it("a duplicate row keeps today's message and changes nothing", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const before = stateDump(db);
    const dup = structuredClone(doc);
    dup.usageHistory.push({ ...dup.usageHistory[0] });
    await expect(dbApi.importDbStream(bodyOf(dup), { masterKey: MASTER })).rejects.toMatchObject({
      code: "TRANSFER_STATE_INVALID",
      message: "duplicate usageHistory row",
    });
    const dupToken = structuredClone(doc);
    dupToken.invitations.push({ ...dupToken.invitations[0], id: "inv-9" });
    await expect(
      dbApi.importDbStream(bodyOf(dupToken), { masterKey: MASTER }),
    ).rejects.toMatchObject({
      code: "TRANSFER_STATE_INVALID",
      message: "duplicate invitations tokenHash in snapshot",
    });
    expect(stateDump(db)).toBe(before);
    expect(stagingEntries()).toEqual([]);
  });

  it("an invalid value type is rejected before mutation", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const before = stateDump(db);
    const bad = structuredClone(doc);
    bad.budgets[0].limitUsd = { nested: 1 };
    await expect(dbApi.importDbStream(bodyOf(bad), { masterKey: MASTER })).rejects.toMatchObject({
      code: "TRANSFER_STATE_INVALID",
      message: "budgets entry has an invalid value",
    });
    expect(stateDump(db)).toBe(before);
  });

  it("a failed foreign_key_check after apply rolls the sql.js transaction back", async () => {
    insertViaOracle(db, insertInstanceTableSections, tricky);
    const before = stateDump(db);
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
    expect(stateDump(db)).toBe(before);
    expect(stagingEntries()).toEqual([]);
  });
});
