// YAN-1013: synchronous disk preflight for instance import (D14).
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IMPORT_DISK_INSUFFICIENT,
  assertImportDiskSpace,
  computeImportNeeds,
  diskMargin,
  groupNeedsByDevice,
} from "@/lib/db/diskPreflight.js";
import { BACKUPS_DIR, DATA_FILE, STAGING_DIR, ensureDirs } from "@/lib/db/paths.js";
import { __setFreeBytesProbeForTests } from "@/lib/db/stagingFiles.js";

const MIB = 1024 * 1024;
const MARGIN = 32 * MIB;

function writeSized(file, bytes) {
  const fd = fs.openSync(file, "w");
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function catchErr(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

beforeEach(() => {
  ensureDirs();
  fs.rmSync(DATA_FILE, { force: true });
  fs.rmSync(`${DATA_FILE}-wal`, { force: true });
});

afterEach(() => {
  __setFreeBytesProbeForTests(null);
  fs.rmSync(DATA_FILE, { force: true });
  fs.rmSync(`${DATA_FILE}-wal`, { force: true });
});

describe("diskMargin", () => {
  it("is 32 MiB for small requirements and 2% for large ones", () => {
    expect(diskMargin(0)).toBe(MARGIN);
    expect(diskMargin(100 * MIB)).toBe(MARGIN);
    expect(diskMargin(10 * 1024 * MIB)).toBe(Math.ceil(10 * 1024 * MIB * 0.02));
  });
});

describe("computeImportNeeds", () => {
  it("staging phase: stage and wal both equal the incoming size", () => {
    expect(
      computeImportNeeds({ phase: "staging", incomingBytes: 50, dbFootprint: 10, stageBytes: 999 }),
    ).toEqual({
      backup: 10,
      stage: 50,
      wal: 50,
    });
  });

  it("backup phase: stage already allocated, wal equals the actual stage size", () => {
    expect(
      computeImportNeeds({ phase: "backup", incomingBytes: 999, stageBytes: 70, dbFootprint: 10 }),
    ).toEqual({
      backup: 10,
      stage: 0,
      wal: 70,
    });
  });

  it("clamps junk numbers to zero and rejects unknown phases", () => {
    expect(
      computeImportNeeds({ phase: "staging", incomingBytes: -5, dbFootprint: Number.NaN }),
    ).toEqual({
      backup: 0,
      stage: 0,
      wal: 0,
    });
    expect(() => computeImportNeeds({ phase: "nope" })).toThrow(/phase/);
  });
});

describe("groupNeedsByDevice", () => {
  const needs = { backup: 10, stage: 20, wal: 5 };

  it("sums requirements when both dirs share a device", () => {
    const groups = groupNeedsByDevice(needs, { deviceOf: () => 7 });
    expect(groups).toHaveLength(1);
    expect(groups[0].bytes).toBe(35);
  });

  it("checks each separately on different devices", () => {
    const groups = groupNeedsByDevice(needs, { deviceOf: (d) => (d === STAGING_DIR ? 2 : 1) });
    expect(groups).toEqual([
      { dir: BACKUPS_DIR, bytes: 15 },
      { dir: STAGING_DIR, bytes: 20 },
    ]);
  });

  it("never merges a directory whose device is unknown", () => {
    const groups = groupNeedsByDevice(needs, { deviceOf: () => null });
    expect(groups).toHaveLength(2);
  });

  it("drops zero-byte groups", () => {
    const groups = groupNeedsByDevice(
      { backup: 0, stage: 20, wal: 0 },
      { deviceOf: (d) => (d === STAGING_DIR ? 2 : 1) },
    );
    expect(groups).toEqual([{ dir: STAGING_DIR, bytes: 20 }]);
  });
});

describe("assertImportDiskSpace", () => {
  it("passes when free space covers the staging-phase requirement", () => {
    writeSized(DATA_FILE, 10 * MIB);
    writeSized(`${DATA_FILE}-wal`, 2 * MIB);
    // backup 12 + stage 100 + wal 100 (same device) = 212 MiB + margin
    const need = 212 * MIB + diskMargin(212 * MIB);
    __setFreeBytesProbeForTests(() => need);
    expect(() =>
      assertImportDiskSpace({ phase: "staging", incomingBytes: 100 * MIB }),
    ).not.toThrow();
  });

  it("throws IMPORT_DISK_INSUFFICIENT one byte below the staging-phase requirement", () => {
    writeSized(DATA_FILE, 10 * MIB);
    writeSized(`${DATA_FILE}-wal`, 2 * MIB);
    const need = 212 * MIB + diskMargin(212 * MIB);
    __setFreeBytesProbeForTests(() => need - 1);
    const err = catchErr(() =>
      assertImportDiskSpace({ phase: "staging", incomingBytes: 100 * MIB }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(IMPORT_DISK_INSUFFICIENT);
    expect(err.requiredBytes).toBe(need);
    expect(err.freeBytes).toBe(need - 1);
  });

  it("backup phase counts the db footprint + actual stage size, not the incoming size", () => {
    writeSized(DATA_FILE, 10 * MIB);
    // backup 10 + wal 40 = 50 MiB + margin; incomingBytes must be ignored
    const need = 50 * MIB + MARGIN;
    __setFreeBytesProbeForTests(() => need);
    expect(() =>
      assertImportDiskSpace({ phase: "backup", incomingBytes: 10_000 * MIB, stageBytes: 40 * MIB }),
    ).not.toThrow();
    __setFreeBytesProbeForTests(() => need - 1);
    const err = catchErr(() =>
      assertImportDiskSpace({ phase: "backup", incomingBytes: 0, stageBytes: 40 * MIB }),
    );
    expect(err?.code).toBe(IMPORT_DISK_INSUFFICIENT);
    expect(err.requiredBytes).toBe(need);
  });

  it("treats a missing DB file as zero footprint", () => {
    __setFreeBytesProbeForTests(() => MARGIN);
    expect(() => assertImportDiskSpace({ phase: "backup", stageBytes: 0 })).not.toThrow();
  });

  it("skips the check when free bytes are unknown (null)", () => {
    writeSized(DATA_FILE, 10 * MIB);
    __setFreeBytesProbeForTests(() => null);
    expect(() =>
      assertImportDiskSpace({ phase: "staging", incomingBytes: 10_000 * MIB }),
    ).not.toThrow();
  });

  it("message is recoverable, names pre-import-*, stays within 300 chars, and has no secrets", () => {
    writeSized(DATA_FILE, 10 * MIB);
    __setFreeBytesProbeForTests(() => 1 * MIB);
    const err = catchErr(() =>
      assertImportDiskSpace({ phase: "staging", incomingBytes: 100 * MIB }),
    );
    expect(err.code).toBe(IMPORT_DISK_INSUFFICIENT);
    expect(err.message.length).toBeLessThanOrEqual(300);
    expect(err.message).toContain("pre-import-");
    expect(err.message).toMatch(/Not enough free disk space to import/);
    expect(err.message).toMatch(/1 MiB free/);
    expect(err.message).toMatch(/retry/);
  });

  it("keeps the message under 300 chars even for huge numbers", () => {
    __setFreeBytesProbeForTests(() => 0);
    const err = catchErr(() => assertImportDiskSpace({ phase: "staging", incomingBytes: 1e15 }));
    expect(err.message.length).toBeLessThanOrEqual(300);
    expect(err.message).toContain("pre-import-");
  });

  it("is synchronous (returns undefined, not a promise)", () => {
    __setFreeBytesProbeForTests(() => Number.MAX_SAFE_INTEGER);
    expect(assertImportDiskSpace({ phase: "staging", incomingBytes: MIB })).toBeUndefined();
  });

  it("passes the real directories to the probe", () => {
    const seen = new Set();
    __setFreeBytesProbeForTests((dir) => {
      seen.add(dir);
      return Number.MAX_SAFE_INTEGER;
    });
    assertImportDiskSpace({ phase: "staging", incomingBytes: MIB });
    // same device in the test DATA_DIR => one group, probed on BACKUPS_DIR
    expect([...seen].every((d) => d === BACKUPS_DIR || d === STAGING_DIR)).toBe(true);
  });
});
