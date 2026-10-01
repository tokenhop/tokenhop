// Autostart entries (YAN-329): tokenhop builds replace a legacy 9router entry
// with the same port/host; entries of both names count as enabled; disable
// removes both. Temp HOME/APPDATA (tests/setup/isolateDataDir.js); launchctl is
// faked.
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const AUTOSTART = require.resolve("../../cli/src/cli/tray/autostart.js");
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const PACKED_BRAND_CJS = path.resolve(__dirname, "../../cli/src/shared/brand/index.cjs");
const { BRAND, LEGACY } = require(BRAND_CJS);

const ORIGINAL_PLATFORM = process.platform;
const saved = {};
let loaded; // launchctl registry fake: labels currently loaded

const dirs = {
  linux: () => path.join(process.env.HOME, ".config", "autostart"),
  win32: () =>
    path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
  darwin: () => path.join(process.env.HOME, "Library", "LaunchAgents"),
};
const file = {
  linux: (names) => names.autostartDesktopFile,
  win32: (names) => names.autostartVbsFile,
  darwin: (names) => `${names.autostartLabel}.plist`,
};
const entryPath = (platform, names) => path.join(dirs[platform](), file[platform](names));

// Entries as the 9router CLI wrote them, with port 21000 and host 127.0.0.1.
const legacyEntry = {
  linux: `[Desktop Entry]\nType=Application\nName=9Router\nExec=/usr/bin/node /old/9router/cli.js --tray -p 21000 -H 127.0.0.1\n`,
  win32: `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """C:\\node.exe"" ""C:\\npm\\9router\\cli.js"" --tray -p 21000 -H 127.0.0.1", 0, False\n`,
  darwin: `<plist><dict><key>Label</key><string>${LEGACY.autostartLabel}</string><array>\n<string>/usr/bin/node</string>\n<string>/old/9router/cli.js</string>\n<string>--tray</string>\n<string>-p</string>\n<string>21000</string>\n<string>-H</string>\n<string>127.0.0.1</string>\n</array></dict></plist>`,
};

function load(brand, platform) {
  process.env.NEXT_PUBLIC_BRAND = brand;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const f of [BRAND_CJS, PACKED_BRAND_CJS, AUTOSTART]) delete require.cache[f];
  return require(AUTOSTART);
}

function seedLegacy(platform) {
  fs.mkdirSync(dirs[platform](), { recursive: true });
  fs.writeFileSync(entryPath(platform, LEGACY), legacyEntry[platform]);
  if (platform === "darwin") loaded.add(LEGACY.autostartLabel);
}

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_BRAND", "DISPLAY", "HOME", "APPDATA"]) saved[k] = process.env[k];
  const root = fs.mkdtempSync(path.join(process.env.TOKENHOP_TEST_ROOT, "autostart-"));
  process.env.HOME = path.join(root, "home");
  process.env.APPDATA = path.join(root, "appdata");
  process.env.DISPLAY = ":0";
  fs.mkdirSync(dirs.win32(), { recursive: true });
  loaded = new Set();
  vi.spyOn(childProcess, "execSync").mockImplementation((cmd) => {
    const [, verb, arg] = cmd.match(/^launchctl (list|unload|load -w) "?([^"]+)"?$/) || [];
    const label = arg && path.basename(arg, ".plist");
    if (verb === "list") {
      if (!loaded.has(label)) throw new Error("not loaded");
      return `{ "Label" = "${label}"; };`;
    }
    if (verb === "unload") loaded.delete(label);
    if (verb === "load -w") loaded.add(label);
    return "";
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  for (const f of [BRAND_CJS, PACKED_BRAND_CJS, AUTOSTART]) delete require.cache[f];
  vi.restoreAllMocks();
});

describe.each(["linux", "win32", "darwin"])("autostart on %s", (platform) => {
  it("tokenhop: a legacy entry counts as enabled and is migrated with its port and host", () => {
    seedLegacy(platform);
    const autostart = load("tokenhop", platform);

    expect(autostart.isAutoStartEnabled()).toBe(true);
    expect(fs.existsSync(entryPath(platform, LEGACY))).toBe(false);
    const migrated = fs.readFileSync(entryPath(platform, BRAND), "utf8");
    expect(migrated).toMatch(/-p(<\/string>\s*<string>|\s+)21000/);
    expect(migrated).toMatch(/-H(<\/string>\s*<string>|\s+)127\.0\.0\.1/);
    expect(migrated).toContain(path.resolve(__dirname, "../../cli/cli.js"));
    // The running legacy agent is left alone: no second launcher, no self-kill.
    if (platform === "darwin") expect([...loaded]).toEqual([LEGACY.autostartLabel]);
    // Idempotent.
    expect(autostart.isAutoStartEnabled()).toBe(true);
    expect(fs.readFileSync(entryPath(platform, BRAND), "utf8")).toBe(migrated);
  });

  it("tokenhop: enable writes the new entry and removes the legacy one; disable removes both", () => {
    seedLegacy(platform);
    const autostart = load("tokenhop", platform);

    expect(autostart.enableAutoStart(undefined, { port: 20130 })).toBe(true);
    expect(fs.existsSync(entryPath(platform, LEGACY))).toBe(false);
    expect(fs.readFileSync(entryPath(platform, BRAND), "utf8")).toMatch(/20130/);
    if (platform === "darwin") expect([...loaded]).toEqual([BRAND.autostartLabel]);

    seedLegacy(platform);
    expect(autostart.disableAutoStart()).toBe(true);
    expect(fs.existsSync(entryPath(platform, LEGACY))).toBe(false);
    expect(fs.existsSync(entryPath(platform, BRAND))).toBe(false);
    expect(autostart.isAutoStartEnabled()).toBe(false);
  });

  it("default brand: keeps writing the 9router entry and never migrates it", () => {
    seedLegacy(platform);
    const autostart = load("9router", platform);

    expect(autostart.isAutoStartEnabled()).toBe(true);
    expect(fs.readFileSync(entryPath(platform, LEGACY), "utf8")).toBe(legacyEntry[platform]);
    expect(fs.existsSync(entryPath(platform, BRAND))).toBe(false);

    expect(autostart.enableAutoStart(undefined, { port: 20130 })).toBe(true);
    expect(fs.readFileSync(entryPath(platform, LEGACY), "utf8")).toMatch(/20130/);
    expect(fs.existsSync(entryPath(platform, BRAND))).toBe(false);
  });
});
