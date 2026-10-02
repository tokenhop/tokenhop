// `data migrate` (YAN-325): moves the legacy data dir under the tokenhop brand.
// Temp HOME only; dir names come from the brand module.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const DATA_DIR_CJS = require.resolve("../../src/shared/dataDir/index.cjs");
const COMMAND = require.resolve("../../cli/src/cli/commands/dataMigrate.js");
const PACKED = ["brand", "dataDir"].map((n) =>
  path.resolve(__dirname, "../../cli/src/shared", n, "index.cjs"),
);

let savedBrand;
let home;

function load(brand) {
  if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = brand;
  for (const f of [BRAND_CJS, DATA_DIR_CJS, COMMAND, ...PACKED]) delete require.cache[f];
  return { cmd: require(COMMAND), brand: require(BRAND_CJS) };
}

beforeEach(() => {
  savedBrand = process.env.NEXT_PUBLIC_BRAND;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "data-migrate-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function setup(overrides = {}) {
  const { cmd, brand } = load("tokenhop");
  const legacy = path.join(home, `.${brand.LEGACY.dataDirName}`);
  const target = path.join(home, `.${brand.BRAND.dataDirName}`);
  const logs = [];
  const deps = {
    env: {},
    platform: "linux",
    homedir: home,
    findListeningPids: () => [],
    isAlive: () => false,
    integrityCheck: () => "ok",
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { cmd, brand, legacy, target, logs, deps };
}

function seedLegacy(legacy) {
  fs.mkdirSync(path.join(legacy, "db"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "db", "data.sqlite"), "db-bytes");
  fs.writeFileSync(path.join(legacy, "machine-id"), "abc");
}

const exdev = () => {
  throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
};

describe("data migrate", () => {
  it("is not offered under the legacy brand", async () => {
    const { cmd } = load("9router"); // legacy(9router): remove in v2
    expect(cmd.AVAILABLE).toBe(false);
    expect(await cmd.run(["migrate"], { homedir: home, log: () => {} })).toBe(2);
  });

  it("renames on the same filesystem and then reports already migrated", async () => {
    const { cmd, legacy, target, logs, deps } = setup();
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, "machine-id"), "utf8")).toBe("abc");
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(logs.at(-1)).toMatch(/already migrated/);
  });

  it("copies across devices, verifies, and keeps the legacy dir renamed", async () => {
    const integrityCheck = vi.fn(() => "ok");
    const realRename = fs.renameSync;
    let first = true;
    const rename = (a, b) => {
      if (first) {
        first = false;
        exdev();
      }
      realRename(a, b);
    };
    const { cmd, legacy, target, deps } = setup({ rename, integrityCheck });
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(fs.readFileSync(path.join(target, "db", "data.sqlite"), "utf8")).toBe("db-bytes");
    expect(integrityCheck).toHaveBeenCalledWith(path.join(target, "db", "data.sqlite"));
    expect(fs.existsSync(legacy)).toBe(false);
    const kept = fs
      .readdirSync(home)
      .find((n) => n.startsWith(`${path.basename(legacy)}.migrated-`));
    expect(kept).toBeTruthy();
    expect(fs.readFileSync(path.join(home, kept, "machine-id"), "utf8")).toBe("abc");
  });

  it("moves a failed cross-device copy aside and leaves the legacy dir untouched", async () => {
    const { cmd, legacy, target, deps } = setup({ rename: exdev, integrityCheck: () => "corrupt" });
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(path.join(legacy, "db", "data.sqlite"))).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses while the server is running", async () => {
    const { cmd, brand, legacy, deps } = setup({ isAlive: () => true });
    seedLegacy(legacy);
    fs.writeFileSync(path.join(legacy, brand.LEGACY.pidFile), JSON.stringify({ launcher: 4242 }));
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("refuses while something listens on the port", async () => {
    const { cmd, legacy, deps } = setup({ findListeningPids: () => [77] });
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("refuses when the new dir is not empty", async () => {
    const { cmd, legacy, target, deps } = setup();
    seedLegacy(legacy);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "x"), "1");
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("refuses when DATA_DIR is set", async () => {
    const { cmd, legacy, deps } = setup({ env: { DATA_DIR: path.join(home, "custom") } });
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("--dry-run changes nothing", async () => {
    const { cmd, legacy, target, logs, deps } = setup();
    seedLegacy(legacy);
    expect(await cmd.run(["migrate", "--dry-run"], deps)).toBe(0);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(logs.join("\n")).toContain(target);
  });

  // Same rewrite as Windows `setx`; darwin keeps POSIX paths so it runs on any CI host.
  it("points NODE_EXTRA_CA_CERTS at the moved cert", async () => {
    const exec = vi.fn();
    const { cmd, legacy, target, deps } = setup({ exec, platform: "darwin" });
    seedLegacy(legacy);
    exec.mockReturnValueOnce(`${path.join(legacy, "mitm", "rootCA.crt")}\n`);
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(exec).toHaveBeenLastCalledWith("launchctl", [
      "setenv",
      "NODE_EXTRA_CA_CERTS",
      path.join(target, "mitm", "rootCA.crt"),
    ]);
  });

  it("verifies a real WAL-mode database left behind by a killed server", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const realRename = fs.renameSync;
    let first = true;
    const rename = (a, b) => {
      if (first) {
        first = false;
        exdev();
      }
      realRename(a, b);
    };
    const { cmd, legacy, target, logs, deps } = setup({ rename });
    delete deps.integrityCheck; // use the real check
    // Snapshot a live WAL database (as a SIGKILL leaves it: data.sqlite + -wal + -shm).
    const live = path.join(home, "live");
    fs.mkdirSync(live);
    const db = new DatabaseSync(path.join(live, "data.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    fs.cpSync(live, path.join(legacy, "db"), { recursive: true });
    db.close();
    expect(fs.existsSync(path.join(legacy, "db", "data.sqlite-wal"))).toBe(true);
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(logs.join("\n")).toContain("database integrity ok");
    const copy = new DatabaseSync(path.join(target, "db", "data.sqlite"));
    expect(copy.prepare("SELECT x FROM t").get().x).toBe(1);
    copy.close();
  });

  it("moves a failed copy out of the way so the resolver keeps the legacy dir", async () => {
    const cp = (_from, to) => {
      fs.mkdirSync(to);
      fs.writeFileSync(path.join(to, "partial"), "x");
      throw new Error("disk full");
    };
    const { cmd, legacy, target, deps } = setup({ rename: exdev, cp });
    seedLegacy(legacy);
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(legacy, "machine-id"))).toBe(true);
  });

  it("refuses when a live MITM pid (plain number) is recorded", async () => {
    const { cmd, legacy, deps } = setup({ isAlive: (pid) => pid === 5150 });
    seedLegacy(legacy);
    fs.mkdirSync(path.join(legacy, "mitm"));
    fs.writeFileSync(path.join(legacy, "mitm", ".mitm.pid"), "5150");
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("checks pid files in the new dir too", async () => {
    const { cmd, brand, legacy, target, deps } = setup({ isAlive: () => true });
    seedLegacy(legacy);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, brand.LEGACY.pidFile), JSON.stringify({ server: 99 }));
    expect(await cmd.run(["migrate"], deps)).toBe(1);
    expect(vi.mocked(console.error).mock.calls.at(-1)[0]).toMatch(/may be running/);
  });

  it("replaces an empty new dir", async () => {
    const { cmd, legacy, target, deps } = setup();
    seedLegacy(legacy);
    fs.mkdirSync(target);
    expect(await cmd.run(["migrate"], deps)).toBe(0);
    expect(fs.existsSync(path.join(target, "machine-id"))).toBe(true);
  });

  it("rewrites NODE_EXTRA_CA_CERTS with setx on Windows, only when it points into the legacy dir", () => {
    const { cmd } = setup();
    const legacy = "C:\\Users\\u\\AppData\\Roaming\\old";
    const target = "C:\\Users\\u\\AppData\\Roaming\\new";
    const env = (v) => ({ env: { NODE_EXTRA_CA_CERTS: v } });
    expect(cmd.caEnvCommands(legacy, target, "win32", env(`${legacy}\\mitm\\rootCA.crt`))).toEqual([
      ["setx", ["NODE_EXTRA_CA_CERTS", `${target}\\mitm\\rootCA.crt`]],
    ]);
    expect(
      cmd.caEnvCommands(legacy, target, "win32", env(`${legacy.toLowerCase()}\\mitm\\rootCA.crt`)),
    ).toEqual([["setx", ["NODE_EXTRA_CA_CERTS", `${target}\\mitm\\rootCA.crt`]]]);
    expect(cmd.caEnvCommands(legacy, target, "win32", env("D:\\certs\\corp.crt"))).toEqual([]);
    expect(cmd.caEnvCommands(legacy, target, "win32", env(`${legacy}-other\\x.crt`))).toEqual([]);
  });

  it("refuses when the legacy path or the new path is a file", async () => {
    const a = setup();
    fs.writeFileSync(a.legacy, "stray");
    expect(await a.cmd.run(["migrate"], a.deps)).toBe(1);
    expect(fs.readFileSync(a.legacy, "utf8")).toBe("stray");
    fs.rmSync(a.legacy);

    const b = setup();
    seedLegacy(b.legacy);
    fs.writeFileSync(b.target, "stray");
    expect(await b.cmd.run(["migrate"], b.deps)).toBe(1);
    expect(fs.existsSync(path.join(b.legacy, "machine-id"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { cmd, deps } = setup();
    expect(await cmd.run(["migrate", "--force"], deps)).toBe(2);
  });
});
