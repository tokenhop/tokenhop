import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import { join } from "path";

// The route loads better-sqlite3 via a runtime `require("better-sqlite3")`,
// which vi.mock cannot intercept (it only handles ESM imports). Tests patch
// Node's Module._load instead — see installBetterSqlite below.
//
// child_process IS imported by the route, so vi.mock works. But the route
// promisifies execFile, and util.promisify only produces { stdout, stderr }
// via the custom promisify symbol — attach one to the mock so execFileAsync
// behaves like the real one.
const execState = vi.hoisted(() => ({ calls: [], handler: null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

vi.mock("child_process", () => {
  const execFile = vi.fn();
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (cmd, args) => {
    execState.calls.push({ cmd, args: args ?? [] });
    // Default: every command fails, like a host without sqlite3/cursor.
    return execState.handler
      ? execState.handler(cmd, args ?? [])
      : Promise.reject(new Error(`${cmd}: command not found`));
  };
  return { execFile };
});

const nodeModule = require("module");

const SQL = "SELECT value FROM itemTable WHERE key=? LIMIT 1";

const DARWIN_CANDIDATES = [
  join("/mock/home", "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
  join(
    "/mock/home",
    "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
  ),
];

const LINUX_CANDIDATES = [
  join("/mock/home", ".config/Cursor/User/globalStorage/state.vscdb"),
  join("/mock/home", ".config/cursor/User/globalStorage/state.vscdb"),
];

const sqliteRestores = [];

/**
 * Patch Module._load so the route's `require("better-sqlite3")` returns a
 * controllable fake Database. `rows` maps itemTable key → { value } row;
 * a key missing from `rows` is a lookup miss (get → undefined).
 */
function installBetterSqlite({ rows = {}, ctorError = null } = {}) {
  const instances = [];
  class FakeDatabase {
    constructor(dbPath, options) {
      this.dbPath = dbPath;
      this.options = options;
      this.queries = [];
      this.getKeys = [];
      this.closed = false;
      instances.push(this);
      if (ctorError) throw ctorError;
    }
    prepare(sql) {
      this.queries.push(sql);
      const db = this;
      return {
        get(key) {
          db.getKeys.push(key);
          return rows[key];
        },
      };
    }
    close() {
      this.closed = true;
    }
  }
  const originalLoad = nodeModule._load;
  nodeModule._load = function interceptedLoad(request, ...rest) {
    if (request === "better-sqlite3") return FakeDatabase;
    return originalLoad.apply(this, [request, ...rest]);
  };
  const restore = () => {
    nodeModule._load = originalLoad;
  };
  sqliteRestores.push(restore);
  return { instances, restore };
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;
  let GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    execState.calls.length = 0;
    execState.handler = null;
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    for (const restore of sqliteRestores.splice(0)) restore();
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── Not-found ─────────────────────────────────────────────────────────

  it("returns not-found error listing every checked darwin location", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      found: false,
      error: `Cursor database not found. Checked locations:\n${DARWIN_CANDIDATES.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`,
    });
    expect(fsPromises.access).toHaveBeenCalledTimes(2);
  });

  // ── Token extraction via better-sqlite3 ───────────────────────────────

  it("extracts tokens via better-sqlite3 using exact keys in priority order", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const { instances } = installBetterSqlite({
      rows: {
        "cursorAuth/accessToken": { value: "test-access-token" },
        "cursorAuth/refreshToken": { value: "test-refresh-token" },
        "storage.serviceMachineId": { value: "test-machine-id" },
      },
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: true,
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      machineId: "test-machine-id",
    });

    const db = instances[0];
    expect(db.dbPath).toBe(DARWIN_CANDIDATES[0]);
    expect(db.options.readonly).toBe(true);
    expect(db.queries).toHaveLength(3);
    expect(db.queries.every((sql) => sql.includes("itemTable"))).toBe(true);
    expect(db.getKeys).toContain("cursorAuth/accessToken");
    expect(db.getKeys).toContain("cursorAuth/refreshToken");
    expect(db.getKeys).toContain("storage.serviceMachineId");
    expect(db.closed).toBe(true);
  });

  it("unwraps JSON-encoded string values but keeps non-string JSON verbatim", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    installBetterSqlite({
      rows: {
        "cursorAuth/accessToken": { value: '"json-access-token"' },
        "cursorAuth/refreshToken": { value: '"json-refresh-token"' },
        "storage.serviceMachineId": { value: '{"machineId":"opaque"}' },
      },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-access-token");
    expect(response.body.refreshToken).toBe("json-refresh-token");
    // JSON.parse succeeds but result is not a string → original value kept
    expect(response.body.machineId).toBe('{"machineId":"opaque"}');
  });

  it("falls through to lower-priority keys when primary keys miss", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const { instances } = installBetterSqlite({
      rows: {
        "cursorAuth/token": { value: "alt-access-token" },
        "cursorAuth/refreshToken": { value: "alt-refresh-token" },
        "storage.machineId": { value: "alt-machine-id" },
      },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alt-access-token");
    expect(response.body.machineId).toBe("alt-machine-id");
    expect(instances[0].getKeys).toContain("cursorAuth/token");
    expect(instances[0].getKeys).toContain("storage.machineId");
  });

  // ── Extraction failures → manual fallback ─────────────────────────────

  it("db-open failure falls back to sqlite3 CLI, then windowsManual", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const { instances } = installBetterSqlite({
      ctorError: new Error("SqliteError: unable to open database file"),
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: false,
      windowsManual: true,
      dbPath: DARWIN_CANDIDATES[0],
    });
    expect(instances[0].closed).toBe(false); // ctor threw before close()
    // CLI fallback was attempted against the same dbPath
    const cliCalls = execState.calls.filter((c) => c.cmd === "sqlite3");
    expect(cliCalls.length).toBeGreaterThan(0);
    expect(cliCalls[0].args[0]).toBe(DARWIN_CANDIDATES[0]);
  });

  it("opened db with no token rows ends at windowsManual", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const { instances } = installBetterSqlite({ rows: {} });

    const response = await GET();

    expect(response.body).toEqual({
      found: false,
      windowsManual: true,
      dbPath: DARWIN_CANDIDATES[0],
    });
    expect(instances[0].closed).toBe(true);
  });

  // ── Linux install check ───────────────────────────────────────────────

  it("linux: leftover config without cursor binary or desktop file skips auto-import", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockImplementation(async (p) => {
      if (p === LINUX_CANDIDATES[0]) return;
      throw new Error("ENOENT");
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: false,
      error:
        "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import.",
    });
    const which = execState.calls.find((c) => c.cmd === "which");
    expect(which?.args).toEqual(["cursor"]);
  });

  it("linux: `which cursor` success continues to extraction", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockImplementation(async (p) => {
      if (p === LINUX_CANDIDATES[0]) return;
      throw new Error("ENOENT");
    });
    execState.handler = (cmd) =>
      cmd === "which"
        ? Promise.resolve({ stdout: "/usr/bin/cursor\n" })
        : Promise.reject(new Error("not found"));
    installBetterSqlite({
      rows: {
        "cursorAuth/accessToken": { value: "linux-token" },
        "storage.serviceMachineId": { value: "linux-machine" },
      },
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("linux-token");
    expect(response.body.machineId).toBe("linux-machine");
  });

  // ── Windows candidate probing ─────────────────────────────────────────

  it("win32: probes APPDATA/LOCALAPPDATA candidates in order", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const savedEnv = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    };
    process.env.APPDATA = "/mock/appdata";
    process.env.LOCALAPPDATA = "/mock/localappdata";
    const candidates = [
      join("/mock/appdata", "Cursor", "User", "globalStorage", "state.vscdb"),
      join("/mock/appdata", "Cursor - Insiders", "User", "globalStorage", "state.vscdb"),
      join("/mock/localappdata", "Cursor", "User", "globalStorage", "state.vscdb"),
      join("/mock/localappdata", "Programs", "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
    vi.mocked(fsPromises.access).mockImplementation(async (p) => {
      if (p === candidates[3]) return;
      throw new Error("ENOENT");
    });
    const { instances } = installBetterSqlite({
      rows: {
        "cursorAuth/accessToken": { value: "win-token" },
        "storage.serviceMachineId": { value: "win-machine" },
      },
    });

    try {
      const response = await GET();

      expect(response.body.found).toBe(true);
      expect(instances[0].dbPath).toBe(candidates[3]);
      expect(fsPromises.access).toHaveBeenCalledTimes(4);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
