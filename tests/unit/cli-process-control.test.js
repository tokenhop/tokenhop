import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

const require = createRequire(import.meta.url);
const PC = require.resolve("../../cli/src/cli/utils/processControl.js");
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
// processControl prefers the copy the CLI build packs into cli/src/shared/ when it exists.
const PACKED_BRAND_CJS = path.join(path.dirname(PC), "..", "..", "shared", "brand", "index.cjs");
const pc = require(PC);
const { ACTIVE, BRAND, LEGACY } = require(BRAND_CJS);

describe("parseListeningPidsWindows", () => {
  it("matches only LISTENING rows on the exact local port", () => {
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       111",
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       222",
      "  TCP    [::]:80                [::]:0                 LISTENING       111",
      "  TCP    127.0.0.1:80           127.0.0.1:50000        ESTABLISHED     333",
      "  TCP    127.0.0.1:50000        127.0.0.1:80           ESTABLISHED     444",
      "  UDP    0.0.0.0:80             *:*                                    555",
    ].join("\r\n");
    expect(pc.parseListeningPidsWindows(netstat, 80)).toEqual([111]);
    expect(pc.parseListeningPidsWindows(netstat, 8080)).toEqual([222]);
    expect(pc.parseListeningPidsWindows(netstat, 8)).toEqual([]);
  });
});

describe("isLauncherCommandLine", () => {
  it("accepts node running a launcher script of either brand only", () => {
    for (const cmd of [
      "node /usr/local/bin/9router",
      "/usr/bin/node --dns-result-order=ipv4first /home/u/.npm/lib/node_modules/9router/cli.js --tray -p 20128",
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\9router\\cli.js"',
      `node /usr/local/bin/${BRAND.slug}`,
      `/usr/bin/node /home/u/.npm/lib/node_modules/${BRAND.slug}/cli.js --tray`,
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\${BRAND.slug}\\cli.js"`,
    ]) {
      expect(pc.isLauncherCommandLine(cmd)).toBe(true);
    }
    for (const cmd of [
      "bash -lc cd /home/u/src/9router && python -m http.server 20128",
      "/bin/zsh -c cd /home/u/9router && npx vitest run",
      "node /home/u/9router/node_modules/vitest/vitest.mjs run",
      `node /home/u/${BRAND.slug}/node_modules/vitest/vitest.mjs run`,
      "next-server (v16.3.6)",
      "",
      null,
    ]) {
      expect(pc.isLauncherCommandLine(cmd)).toBe(false);
    }
  });
});

describe("launcher PID file", () => {
  it("round-trips under DATA_DIR and is only removed by its owner", () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pid-"));
    expect(pc.getPidFilePath()).toBe(path.join(process.env.DATA_DIR, ACTIVE.pidFile));
    expect(pc.readPidFile()).toBeNull();

    pc.writePidFile({ launcher: 100, server: 200 });
    expect(pc.readPidFile()).toEqual({ launcher: 100, server: 200 });
    expect(pc.removePidFileIfOwner(999)).toBe(false);
    expect(pc.removePidFileIfOwner(100)).toBe(true);
    expect(fs.existsSync(pc.getPidFilePath())).toBe(false);

    fs.writeFileSync(pc.getPidFilePath(), "not json");
    expect(pc.readPidFile()).toBeNull();
  });
});

// legacy(9router): remove in v2 — an old launcher may still record itself in the legacy file.
describe("launcher PID file under the tokenhop brand", () => {
  const savedBrand = process.env.NEXT_PUBLIC_BRAND;
  const DEAD_PID = 2147483646;
  let th;
  let dir;

  function reload(brand) {
    if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
    else process.env.NEXT_PUBLIC_BRAND = brand;
    for (const f of [BRAND_CJS, PACKED_BRAND_CJS, PC]) {
      if (fs.existsSync(f)) delete require.cache[f];
    }
    return require(PC);
  }

  beforeEach(() => {
    th = reload("tokenhop");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "th-pid-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(() => reload(savedBrand));

  const legacyFile = () => path.join(dir, LEGACY.pidFile);
  const writeLegacy = (rec) => fs.writeFileSync(legacyFile(), JSON.stringify(rec));

  it("writes the new file and reads a legacy-only file", () => {
    expect(th.getPidFilePath()).toBe(path.join(dir, BRAND.pidFile));
    writeLegacy({ launcher: 100, server: 200 });
    expect(th.readPidFile()).toEqual({ launcher: 100, server: 200 });
  });

  it("returns both records when both files exist, new first", () => {
    fs.writeFileSync(th.getPidFilePath(), JSON.stringify({ launcher: 300, server: 400 }));
    writeLegacy({ launcher: 100, server: 200 });
    expect(th.readPidFiles()).toEqual([
      { launcher: 300, server: 400 },
      { launcher: 100, server: 200 },
    ]);
  });

  it("removes the legacy file only once its launcher is gone", () => {
    writeLegacy({ launcher: process.pid, server: null });
    th.writePidFile({ launcher: 300, server: 400 });
    expect(fs.existsSync(legacyFile())).toBe(true);

    writeLegacy({ launcher: DEAD_PID, server: null });
    th.writePidFile({ launcher: 300, server: 400 });
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(th.readPidFiles()).toEqual([{ launcher: 300, server: 400 }]);
  });
});
