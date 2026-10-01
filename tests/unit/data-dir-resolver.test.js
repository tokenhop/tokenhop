// One data-dir resolver for the app, the MITM server and the CLI (YAN-324).
// The directory name comes from the brand module; no legacy literals here.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getDataDir, defaultDataDir } = require("../../src/shared/dataDir/index.cjs");
const { LEGACY } = require("../../src/shared/brand/index.cjs");

const NAME = LEGACY.dataDirName;

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-dir-resolver-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("defaultDataDir", () => {
  it("resolves ~/.<name> on linux", () => {
    expect(defaultDataDir({ platform: "linux", env: {}, homedir: "/home/u" })).toBe(
      path.posix.join("/home/u", `.${NAME}`),
    );
  });

  it("joins APPDATA on win32", () => {
    const appdata = "C:\\Users\\u\\AppData\\Roaming";
    expect(
      defaultDataDir({ platform: "win32", env: { APPDATA: appdata }, homedir: "C:\\Users\\u" }),
    ).toBe(path.win32.join(appdata, NAME));
  });

  it("falls back to <home>\\AppData\\Roaming on win32 without APPDATA", () => {
    expect(defaultDataDir({ platform: "win32", env: {}, homedir: "C:\\Users\\u" })).toBe(
      path.win32.join("C:\\Users\\u", "AppData", "Roaming", NAME),
    );
  });
});

describe("getDataDir", () => {
  it("returns the default when DATA_DIR is unset", () => {
    expect(getDataDir({ platform: "linux", env: {}, homedir: "/home/u" })).toBe(
      path.posix.join("/home/u", `.${NAME}`),
    );
  });

  it("returns the default when DATA_DIR is empty", () => {
    expect(getDataDir({ platform: "linux", env: { DATA_DIR: "" }, homedir: "/home/u" })).toBe(
      path.posix.join("/home/u", `.${NAME}`),
    );
  });

  // Warnings are deduplicated per message for the whole process, so every
  // warning test uses its own DATA_DIR value.
  it("warns once and falls back for a Unix path on win32", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opts = { platform: "win32", env: { DATA_DIR: "/var/lib/x" }, homedir: "C:\\Users\\u" };
      const expected = path.win32.join("C:\\Users\\u", "AppData", "Roaming", NAME);
      expect(getDataDir(opts)).toBe(expected);
      expect(getDataDir(opts)).toBe(expected);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("creates and returns a writable DATA_DIR", () => {
    const target = path.join(makeTempDir(), "writable");
    expect(getDataDir({ env: { DATA_DIR: target } })).toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back with a warning when DATA_DIR is not writable",
    () => {
      const parent = makeTempDir();
      const target = path.join(parent, "blocked");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fs.chmodSync(parent, 0o555);
      try {
        expect(getDataDir({ env: { DATA_DIR: target } })).toBe(defaultDataDir());
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        fs.chmodSync(parent, 0o755);
        warn.mockRestore();
      }
    },
  );

  it("rethrows mkdir errors other than EACCES/EPERM", () => {
    const blocker = path.join(makeTempDir(), "file");
    fs.writeFileSync(blocker, "x");
    expect(() => getDataDir({ env: { DATA_DIR: path.join(blocker, "child") } })).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("sqliteRuntime delegates to the shared resolver", () => {
    // Behavioural, not identity: after a CLI build sqliteRuntime loads the packed copy.
    const sqliteRuntime = require("../../cli/hooks/sqliteRuntime.js");
    const opts = { platform: "win32", env: { DATA_DIR: "/var/lib/y" }, homedir: "C:\\Users\\u" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(sqliteRuntime.getDataDir(opts)).toBe(getDataDir(opts));
    } finally {
      warn.mockRestore();
    }
  });
});
