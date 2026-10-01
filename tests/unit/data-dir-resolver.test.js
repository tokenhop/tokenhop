// One data-dir resolver for the app, the MITM server and the CLI (YAN-324).
// The directory name comes from the brand module; no legacy literals here.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getDataDir, defaultDataDir } = require("../../src/shared/dataDir/index.cjs");
const { ACTIVE } = require("../../src/shared/brand/index.cjs");

// CI runs this file under both brands; with no dirs on disk the active one wins.
const NAME = ACTIVE.dataDirName;

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

// YAN-325: the active brand's dir, with the legacy dir as a fallback.
describe("brand resolution order", () => {
  const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
  const DATA_DIR_CJS = require.resolve("../../src/shared/dataDir/index.cjs");
  let savedBrand;

  // Fresh modules so the active brand and the warn-once memory reset.
  function load(brand) {
    if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
    else process.env.NEXT_PUBLIC_BRAND = brand;
    delete require.cache[BRAND_CJS];
    delete require.cache[DATA_DIR_CJS];
    return { ...require(DATA_DIR_CJS), ...require(BRAND_CJS) };
  }

  beforeEach(() => {
    savedBrand = process.env.NEXT_PUBLIC_BRAND;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
    else process.env.NEXT_PUBLIC_BRAND = savedBrand;
    delete require.cache[BRAND_CJS];
    delete require.cache[DATA_DIR_CJS];
    vi.mocked(console.warn).mockRestore();
  });

  const PLATFORMS = {
    linux: {
      opts: { platform: "linux", env: {}, homedir: "/home/u" },
      dir: (name) => path.posix.join("/home/u", `.${name}`),
    },
    win32: {
      opts: {
        platform: "win32",
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
        homedir: "C:\\Users\\u",
      },
      dir: (name) => path.win32.join("C:\\Users\\u\\AppData\\Roaming", name),
    },
  };

  describe.each(Object.keys(PLATFORMS))("tokenhop brand on %s", (platform) => {
    const { opts, dir } = PLATFORMS[platform];
    const resolve = (present) => {
      const mod = load("tokenhop");
      const legacy = dir(mod.LEGACY.dataDirName);
      const current = dir(mod.BRAND.dataDirName);
      const onDisk = new Set(present.map((p) => (p === "legacy" ? legacy : current)));
      const o = { ...opts, exists: (p) => onDisk.has(p) };
      return { mod, legacy, current, o, warn: vi.mocked(console.warn) };
    };

    it("uses the legacy dir when only it exists, warning once", () => {
      const { mod, legacy, o, warn } = resolve(["legacy"]);
      expect(mod.getDataDir(o)).toBe(legacy);
      expect(mod.getDataDir(o)).toBe(legacy);
      expect(mod.isLegacyDataDir(o)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`${mod.BRAND.npmPackage} data migrate`);
    });

    it("uses the new dir when only it exists, without a warning", () => {
      const { mod, current, o, warn } = resolve(["new"]);
      expect(mod.getDataDir(o)).toBe(current);
      expect(mod.isLegacyDataDir(o)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it("uses the new dir when both exist, warning once that the legacy dir is ignored", () => {
      const { mod, current, legacy, o, warn } = resolve(["new", "legacy"]);
      expect(mod.getDataDir(o)).toBe(current);
      expect(mod.getDataDir(o)).toBe(current);
      expect(mod.isLegacyDataDir(o)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(legacy);
    });

    it("uses the new dir when neither exists", () => {
      const { mod, current, o, warn } = resolve([]);
      expect(mod.getDataDir(o)).toBe(current);
      expect(mod.isLegacyDataDir(o)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("DATA_DIR wins without checking the defaults", () => {
    const mod = load("tokenhop");
    const target = path.join(makeTempDir(), "configured");
    const exists = vi.fn(() => true);
    const o = { env: { DATA_DIR: target }, exists };
    expect(mod.getDataDir(o)).toBe(target);
    expect(mod.isLegacyDataDir(o)).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });

  it("keeps the legacy dir with no warning under the default brand", () => {
    const mod = load(undefined);
    const o = { ...PLATFORMS.linux.opts, exists: () => true };
    expect(mod.getDataDir(o)).toBe(PLATFORMS.linux.dir(mod.LEGACY.dataDirName));
    expect(mod.isLegacyDataDir(o)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
