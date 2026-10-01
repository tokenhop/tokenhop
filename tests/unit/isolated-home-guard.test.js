// The home-dir guard (tests/helpers/isolatedHome.js) must refuse to touch any
// home outside this file's temp root, above all the developer's real one: a
// bare `npx vitest run` from the repo root once skipped tests/setup and deleted
// the real ~/.config and ~/.openclaw.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_ISOLATED, assertIsolatedHome, removeUnderHome } from "../helpers/isolatedHome.js";

const realHome = process.env.TOKENHOP_TEST_REAL_HOME;
const savedRoot = process.env.TOKENHOP_TEST_ROOT;
// Never exists, so even a broken guard would delete nothing real.
const PROBE = `.tokenhop-guard-probe-${process.pid}-${Date.now()}`;

afterEach(() => {
  process.env.TOKENHOP_TEST_ROOT = savedRoot;
});

describe("isolated home guard", () => {
  it("accepts the per-file temp home set up by tests/setup", () => {
    expect(assertIsolatedHome()).toBe(os.homedir());
  });

  it("throws when HOME is the real home", () => {
    expect(realHome).toBeTruthy();
    expect(() => assertIsolatedHome(realHome)).toThrow(NOT_ISOLATED);
  });

  it("refuses to remove anything under the real home", async () => {
    await expect(removeUnderHome([PROBE], realHome)).rejects.toThrow(NOT_ISOLATED);
  });

  it("throws when the setup marker is missing, even for the current home", () => {
    delete process.env.TOKENHOP_TEST_ROOT;
    expect(() => assertIsolatedHome()).toThrow(NOT_ISOLATED);
  });

  it("throws for a home outside the temp root", () => {
    expect(() => assertIsolatedHome(os.tmpdir())).toThrow(NOT_ISOLATED);
    expect(() => assertIsolatedHome(savedRoot)).toThrow(NOT_ISOLATED);
  });

  it("refuses paths that escape the home", async () => {
    await expect(removeUnderHome([`../${PROBE}`])).rejects.toThrow(/not under/);
    await expect(removeUnderHome([""])).rejects.toThrow(/not under/);
  });

  it("removes paths inside an isolated home", async () => {
    const dir = path.join(os.homedir(), ".config", "probe");
    fs.mkdirSync(dir, { recursive: true });
    await removeUnderHome([".config"]);
    expect(fs.existsSync(path.join(os.homedir(), ".config"))).toBe(false);
  });
});
