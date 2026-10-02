// YAN-677: sql.js persist must be atomic — a failed write leaves the original DB file intact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

let tempDir;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("sql.js adapter atomic persist", () => {
  it("keeps the original file intact and removes the temp file when a save fails", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-sqljs-"));
    const file = path.join(tempDir, "data.sqlite");

    const first = await createSqlJsAdapter(file);
    first.exec("CREATE TABLE t (v TEXT)");
    first.run("INSERT INTO t (v) VALUES (?)", ["kept"]);
    first.close();
    const original = fs.readFileSync(file);

    const second = await createSqlJsAdapter(file);
    second.run("INSERT INTO t (v) VALUES (?)", ["lost"]);
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("simulated crash during save");
    });
    expect(() => second.close()).toThrow("simulated crash");
    vi.restoreAllMocks();

    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    const third = await createSqlJsAdapter(file);
    expect(third.all("SELECT v FROM t")).toEqual([{ v: "kept" }]);
    third.close();
  });
});
