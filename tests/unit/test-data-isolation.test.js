// Regression guard for YAN-14: the suite must never resolve the developer's
// real 9router data dir. tests/setup/isolateDataDir.js points DATA_DIR and HOME
// at a per-file temp root; if that setup stops running (or runs too late), the
// app modules below resolve ~/.9router at import time and these assertions fail.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, getDataDir } from "@/lib/dataDir.js";
import { DATA_FILE } from "@/lib/db/paths.js";

const require = createRequire(import.meta.url);
const mitmPaths = require("../../src/mitm/paths.js");

const root = process.env.TOKENHOP_TEST_ROOT;
const realHome = process.env.TOKENHOP_TEST_REAL_HOME;

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

describe("test data isolation", () => {
  const savedDataDir = process.env.DATA_DIR;
  afterEach(() => {
    process.env.DATA_DIR = savedDataDir;
  });

  it("setup ran and recorded a temp root distinct from the real home", () => {
    expect(root).toBeTruthy();
    expect(realHome).toBeTruthy();
    expect(path.resolve(root)).not.toBe(path.resolve(realHome));
    expect(isInside(root, path.join(realHome, ".9router"))).toBe(false);
  });

  it("app data paths resolved at import time live inside the temp root", () => {
    for (const p of [DATA_DIR, DATA_FILE, mitmPaths.DATA_DIR]) {
      expect(isInside(p, root), `${p} escaped ${root}`).toBe(true);
    }
  });

  it("home-based fallbacks stay inside the temp root when DATA_DIR is unset", () => {
    expect(isInside(os.homedir(), root)).toBe(true);
    delete process.env.DATA_DIR;
    expect(isInside(getDataDir(), root)).toBe(true);
  });
});
