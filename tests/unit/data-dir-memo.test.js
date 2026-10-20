// YAN-1106 round 2: getDataDirMemo() resolves once per input set. It must
// re-resolve whenever DATA_DIR/HOME change, never serve a stale directory, and
// leave getDataDir() itself untouched.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = process.env.TOKENHOP_TEST_ROOT;
let dirs;
let mod;

beforeEach(async () => {
  dirs = [fs.mkdtempSync(path.join(root, "dd-a-")), fs.mkdtempSync(path.join(root, "dd-b-"))];
  vi.resetModules();
  mod = await import("@/lib/dataDir.js");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getDataDirMemo", () => {
  it("returns the same directory as getDataDir()", () => {
    vi.stubEnv("DATA_DIR", dirs[0]);
    expect(mod.getDataDirMemo()).toBe(mod.getDataDir());
    expect(mod.getDataDirMemo()).toBe(dirs[0]);
  });

  it("does not touch the filesystem again for repeat calls", () => {
    vi.stubEnv("DATA_DIR", dirs[0]);
    mod.getDataDirMemo();
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const exists = vi.spyOn(fs, "existsSync");
    for (let i = 0; i < 50; i++) mod.getDataDirMemo();
    expect(mkdir).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it("follows a changed DATA_DIR immediately", () => {
    vi.stubEnv("DATA_DIR", dirs[0]);
    expect(mod.getDataDirMemo()).toBe(dirs[0]);
    vi.stubEnv("DATA_DIR", dirs[1]);
    expect(mod.getDataDirMemo()).toBe(dirs[1]);
    vi.stubEnv("DATA_DIR", dirs[0]);
    expect(mod.getDataDirMemo()).toBe(dirs[0]);
  });

  it("follows a changed HOME when DATA_DIR is unset", () => {
    vi.stubEnv("DATA_DIR", undefined);
    vi.stubEnv("HOME", dirs[0]);
    const first = mod.getDataDirMemo();
    vi.stubEnv("HOME", dirs[1]);
    const second = mod.getDataDirMemo();
    expect(first.startsWith(dirs[0])).toBe(true);
    expect(second.startsWith(dirs[1])).toBe(true);
  });

  it("a failed resolution is never memoized", () => {
    vi.stubEnv("DATA_DIR", path.join(dirs[0], "blocker", "x"));
    fs.writeFileSync(path.join(dirs[0], "blocker"), "file");
    expect(() => mod.getDataDirMemo()).toThrow();
    fs.rmSync(path.join(dirs[0], "blocker"));
    expect(mod.getDataDirMemo()).toBe(path.join(dirs[0], "blocker", "x"));
  });
});
