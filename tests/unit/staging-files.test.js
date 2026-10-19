// YAN-1013: private staging + durable publish helpers. Real fs under the
// isolated per-file DATA_DIR (tests/vitest.config.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_FILE, DB_DIR, STAGING_DIR, ensureDirs } from "@/lib/db/paths.js";
import {
  __setFreeBytesProbeForTests,
  deviceOf,
  freeBytes,
  makeStagingDir,
  openPrivateFileSync,
  publishDurableSync,
  removeStagingDir,
  sweepStagingDir,
} from "@/lib/db/stagingFiles.js";

const POSIX = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  ensureDirs();
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  __setFreeBytesProbeForTests(null);
});

describe("makeStagingDir / openPrivateFileSync", () => {
  it.skipIf(!POSIX)("creates 0700 root and dir, and 0600 files", () => {
    const dir = makeStagingDir("import-");
    expect(path.dirname(dir)).toBe(STAGING_DIR);
    expect(path.basename(dir).startsWith("import-")).toBe(true);
    expect(mode(STAGING_DIR)).toBe(0o700);
    expect(mode(dir)).toBe(0o700);

    const file = path.join(dir, "stage.sqlite");
    const fd = openPrivateFileSync(file);
    fs.closeSync(fd);
    expect(mode(file)).toBe(0o600);
  });

  it.skipIf(!POSIX)("restores the process umask", () => {
    const before = process.umask();
    makeStagingDir("export-");
    expect(process.umask()).toBe(before);
  });

  it("returns distinct directories", () => {
    expect(makeStagingDir("a-")).not.toBe(makeStagingDir("a-"));
  });

  it("refuses to open an existing file (wx)", () => {
    const dir = makeStagingDir("x-");
    const file = path.join(dir, "f");
    fs.closeSync(openPrivateFileSync(file));
    expect(() => openPrivateFileSync(file)).toThrow();
  });

  it.skipIf(!POSIX)("rejects a symlinked staging root", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "staging-target-"));
    try {
      fs.symlinkSync(target, STAGING_DIR);
      expect(() => makeStagingDir("import-")).toThrow(/not a directory/);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      fs.rmSync(STAGING_DIR, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("publishDurableSync", () => {
  it("publishes bytes atomically with no temp left behind", () => {
    const dest = path.join(DB_DIR, "published.bin");
    publishDurableSync(dest, Buffer.from("hello"));
    expect(fs.readFileSync(dest, "utf8")).toBe("hello");
    if (POSIX) expect(mode(dest)).toBe(0o600);
    expect(fs.readdirSync(DB_DIR).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces an existing destination", () => {
    const dest = path.join(DB_DIR, "published.bin");
    fs.writeFileSync(dest, "old");
    publishDurableSync(dest, new Uint8Array([1, 2, 3]));
    expect([...fs.readFileSync(dest)]).toEqual([1, 2, 3]);
  });

  it("leaves no temp file and keeps the old dest when rename fails", () => {
    const dest = path.join(DB_DIR, "published.bin");
    fs.writeFileSync(dest, "old");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename boom");
    });
    expect(() => publishDurableSync(dest, Buffer.from("new"))).toThrow("rename boom");
    expect(fs.readFileSync(dest, "utf8")).toBe("old");
    expect(fs.readdirSync(DB_DIR).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("removeStagingDir", () => {
  it("removes a staging child", () => {
    const dir = makeStagingDir("export-");
    fs.writeFileSync(path.join(dir, "snapshot.json"), "{}");
    expect(removeStagingDir(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(STAGING_DIR)).toBe(true);
  });

  it("refuses paths outside STAGING_DIR, the root itself and traversal", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "staging-outside-"));
    try {
      makeStagingDir("keep-");
      expect(removeStagingDir(outside)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
      expect(removeStagingDir(STAGING_DIR)).toBe(false);
      expect(removeStagingDir(path.join(STAGING_DIR, "..", "backups"))).toBe(false);
      expect(removeStagingDir(DB_DIR)).toBe(false);
      expect(removeStagingDir("")).toBe(false);
      expect(fs.readdirSync(STAGING_DIR).length).toBe(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sweepStagingDir", () => {
  it("removes every child but keeps the root", () => {
    const a = makeStagingDir("import-");
    fs.writeFileSync(path.join(a, "stage.sqlite"), "x");
    const b = makeStagingDir("export-");
    fs.mkdirSync(path.join(b, "nested"));
    fs.writeFileSync(path.join(STAGING_DIR, "stray"), "x");

    expect(sweepStagingDir()).toBe(3);
    expect(fs.existsSync(STAGING_DIR)).toBe(true);
    expect(fs.readdirSync(STAGING_DIR)).toEqual([]);
  });

  it("is a no-op when the staging root does not exist", () => {
    expect(sweepStagingDir()).toBe(0);
  });

  it("removes foreign-pid data.sqlite tmp files in DB_DIR only", () => {
    const foreignPid = process.pid + 100000;
    const foreign = `${DATA_FILE}.${foreignPid}.abc123.tmp`;
    const self = `${DATA_FILE}.${process.pid}.abc123.tmp`;
    const unrelated = path.join(DB_DIR, "other.sqlite.999.abc.tmp");
    const data = DATA_FILE;
    for (const f of [foreign, self, unrelated, data]) fs.writeFileSync(f, "x");

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "staging-else-"));
    const elseTmp = path.join(elsewhere, `data.sqlite.${foreignPid}.abc123.tmp`);
    fs.writeFileSync(elseTmp, "x");

    try {
      expect(sweepStagingDir()).toBe(1);
      expect(fs.existsSync(foreign)).toBe(false);
      expect(fs.existsSync(self)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
      expect(fs.existsSync(data)).toBe(true);
      expect(fs.existsSync(elseTmp)).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
      for (const f of [self, unrelated, data]) fs.rmSync(f, { force: true });
    }
  });

  it("removes same-pid tmp files older than this process, keeps newer ones", () => {
    const stale = `${DATA_FILE}.${process.pid}.stale1.tmp`;
    const live = `${DATA_FILE}.${process.pid}.live01.tmp`;
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(live, "x");
    const longAgo = new Date(Date.now() - process.uptime() * 1000 - 3_600_000);
    fs.utimesSync(stale, longAgo, longAgo);
    try {
      expect(sweepStagingDir()).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
    } finally {
      for (const f of [stale, live]) fs.rmSync(f, { force: true });
    }
  });

  it.skipIf(!POSIX)("unlinks a symlink child without deleting its target", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "staging-solo-"));
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "keep");
    try {
      fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
      fs.symlinkSync(victim, path.join(STAGING_DIR, "only-link"));
      expect(sweepStagingDir()).toBe(1);
      expect(fs.readdirSync(STAGING_DIR)).toEqual([]);
      expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX)("never follows symlinks out of the staging root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "staging-link-"));
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "keep");
    try {
      fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, path.join(STAGING_DIR, "link-dir"));
      fs.symlinkSync(victim, path.join(STAGING_DIR, "link-file"));

      expect(sweepStagingDir()).toBe(2);
      expect(fs.readdirSync(STAGING_DIR)).toEqual([]);
      expect(fs.readFileSync(victim, "utf8")).toBe("keep");
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("freeBytes / deviceOf", () => {
  it("honors the injected probe", () => {
    const probe = vi.fn(() => 1234);
    __setFreeBytesProbeForTests(probe);
    expect(freeBytes(DB_DIR)).toBe(1234);
    expect(probe).toHaveBeenCalledWith(DB_DIR);
    __setFreeBytesProbeForTests(null);
    expect(freeBytes(DB_DIR)).not.toBe(1234);
  });

  it("returns a real non-negative number via statfs, even for a missing dir", () => {
    const v = freeBytes(path.join(DB_DIR, "does", "not", "exist"));
    if (typeof fs.statfsSync === "function") {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
    } else {
      expect(v).toBeNull();
    }
  });

  it("returns null once and warns once when statfsSync is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "statfsSync", "get").mockReturnValue(undefined);
    expect(freeBytes(DB_DIR)).toBeNull();
    expect(freeBytes(DB_DIR)).toBeNull();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("deviceOf matches for dirs on the same filesystem", () => {
    expect(deviceOf(DB_DIR)).toBe(deviceOf(path.join(DB_DIR, "backups")));
    expect(deviceOf(STAGING_DIR)).not.toBeNull();
  });
});
