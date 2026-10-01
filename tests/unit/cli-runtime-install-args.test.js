// YAN-94: better-sqlite3 and systray2 share <data dir>/runtime. npm prunes --no-save
// packages on the next install, so each must be saved or they remove each other.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const SQLITE = require.resolve("../../cli/hooks/sqliteRuntime.js");
const TRAY = require.resolve("../../cli/hooks/trayRuntime.js");

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[SQLITE];
  delete require.cache[TRAY];
});

it("installs the optional runtime deps as saved packages, never --no-save", () => {
  const calls = [];
  vi.spyOn(childProcess, "spawnSync").mockImplementation((_cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete require.cache[SQLITE];
  delete require.cache[TRAY];

  require(SQLITE).ensureSqliteRuntime({ silent: true });
  // Windows skips the tray install entirely; assert the npm path.
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  require(TRAY).ensureTrayRuntime({ silent: true });

  for (const pkg of ["better-sqlite3@", "systray2@"]) {
    const args = calls.find((a) => a.some((x) => x.startsWith(pkg)));
    expect(args, pkg).toBeDefined();
    expect(args).toContain("--save-optional");
    expect(args).toContain("--save-exact");
    expect(args).not.toContain("--no-save");
  }
});
