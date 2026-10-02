// Migration #2: backfill legacy Cursor OAuth rows (refreshToken=null, import+24h expiresAt).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-cursor-mig-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const EXP = 2_000_000_000;
const LEGACY_ACCESS = fakeJwt({ sub: "u1", exp: EXP });

function insertConn(db, id, provider, authType, data) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, 'x', 'x')`,
    [id, provider, authType, typeof data === "string" ? data : JSON.stringify(data)],
  );
}

const readData = (db, id) => db.get(`SELECT data FROM providerConnections WHERE id = ?`, [id]).data;

describe("migration 002 cursor-refresh-backfill", () => {
  it("backfills legacy cursor rows on upgrade and leaves others untouched", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    insertConn(db, "legacy", "cursor", "oauth", {
      accessToken: LEGACY_ACCESS,
      refreshToken: null,
      expiresAt: "2020-01-02T00:00:00.000Z",
      providerSpecificData: { machineId: "m" },
    });
    const modern = {
      accessToken: fakeJwt({ sub: "u2", exp: EXP }),
      refreshToken: "rt-existing",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    insertConn(db, "modern", "cursor", "oauth", modern);
    insertConn(db, "broken", "cursor", "oauth", "{not json");
    const other = { accessToken: LEGACY_ACCESS, refreshToken: null };
    insertConn(db, "other", "claude", "oauth", other);
    db.run(`UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'`);
    db.close?.();

    // Restart → runner applies migration #2
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();

    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    expect(db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value).toBe(
      String(latestVersion()),
    );
    expect(JSON.parse(readData(db2, "legacy"))).toEqual({
      accessToken: LEGACY_ACCESS,
      refreshToken: LEGACY_ACCESS,
      expiresAt: new Date(EXP * 1000).toISOString(),
      providerSpecificData: { machineId: "m" },
    });
    expect(JSON.parse(readData(db2, "modern"))).toEqual(modern);
    expect(readData(db2, "broken")).toBe("{not json");
    expect(JSON.parse(readData(db2, "other"))).toEqual(other);
  });

  it("is idempotent and keeps expiresAt when the access token has no exp", async () => {
    const { default: m002 } = await import("@/lib/db/migrations/002-cursor-refresh-backfill.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const noExp = fakeJwt({ sub: "u3" });
    insertConn(db, "noexp", "cursor", "oauth", { accessToken: noExp, expiresAt: "keep" });
    insertConn(db, "empty", "cursor", "oauth", { refreshToken: "" });

    m002.up(db);
    const once = readData(db, "noexp");
    m002.up(db);

    expect(readData(db, "noexp")).toBe(once);
    expect(JSON.parse(once)).toEqual({
      accessToken: noExp,
      refreshToken: noExp,
      expiresAt: "keep",
    });
    expect(JSON.parse(readData(db, "empty"))).toEqual({ refreshToken: "" });
  });
});
