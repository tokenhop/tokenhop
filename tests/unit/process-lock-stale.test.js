// Regression: a writer lock left by a killed container must not block the next
// one just because the recorded pid exists again (pid reuse across containers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExclusiveWriterLock, WRITER_LOCK_NAME } from "../../src/lib/db/processLock.js";

const dirs = [];
function dataDirWithLock(owner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-lock-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, WRITER_LOCK_NAME), JSON.stringify({ token: "old", ...owner }));
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("writer lock staleness", () => {
  it("replaces a lock whose pid is alive but belongs to a different process", () => {
    const dir = dataDirWithLock({ pid: process.ppid, start: "1" }); // live pid, wrong start time
    expect(acquireExclusiveWriterLock(dir).pid).toBe(process.pid);
  });

  it("replaces a lock naming this very pid that this process does not hold", () => {
    const dir = dataDirWithLock({ pid: process.pid, start: "1" });
    expect(acquireExclusiveWriterLock(dir).pid).toBe(process.pid);
  });

  it("still refuses a live owner with a matching start time", () => {
    if (!fs.existsSync(`/proc/${process.ppid}/stat`)) return; // Linux-only guard
    const stat = fs.readFileSync(`/proc/${process.ppid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const dir = dataDirWithLock({ pid: process.ppid, start });
    expect(() => acquireExclusiveWriterLock(dir)).toThrow(/DATA_DIR already owned/);
  });

  it("still refuses a self-pid lock whose start time matches this incarnation", () => {
    if (!fs.existsSync("/proc/self/stat")) return; // Linux-only guard
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const dir = dataDirWithLock({ pid: process.pid, start }); // start matches → not legacy
    expect(() => acquireExclusiveWriterLock(dir)).toThrow(/DATA_DIR already owned/);
    expect(fs.readFileSync(path.join(dir, WRITER_LOCK_NAME), "utf8")).toBe(
      JSON.stringify({ token: "old", pid: process.pid, start }),
    ); // bytes untouched
  });

  it("reentrant acquire of the held dir returns the same claim untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-lock-"));
    dirs.push(dir);
    const first = acquireExclusiveWriterLock(dir);
    expect(acquireExclusiveWriterLock(dir)).toBe(first);
  });
});
