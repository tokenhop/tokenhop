// Manual combo order: migration backfill, append-on-create, reorder semantics.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function resetAdapter() {
  if (!tempDir) return;
  const adapters = globalThis[Symbol.for(`tokenhop.dbAdapters.${process.pid}`)];
  const dataFile = path.join(tempDir, "db", "data.sqlite");
  try {
    adapters?.get(dataFile)?.instance?.close?.();
  } finally {
    adapters?.delete(dataFile);
  }
}

beforeEach(() => {
  resetAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-combo-order-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  resetAdapter();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const names = (combos) => combos.map((c) => c.name);

describe("combo manual order", () => {
  it("lists new combos in creation order, appended at the end", async () => {
    const { createComboUnscoped, getCombosUnscoped } = await import("@/lib/db/repos/combosRepo.js");
    await createComboUnscoped({ name: "a" });
    await createComboUnscoped({ name: "b" });
    await createComboUnscoped({ name: "c" });
    expect(names(await getCombosUnscoped())).toEqual(["a", "b", "c"]);
  });

  it("reorderCombosUnscoped persists the new order", async () => {
    const { createComboUnscoped, getCombosUnscoped, reorderCombosUnscoped } = await import(
      "@/lib/db/repos/combosRepo.js"
    );
    const a = await createComboUnscoped({ name: "a" });
    const b = await createComboUnscoped({ name: "b" });
    const c = await createComboUnscoped({ name: "c" });
    expect(await reorderCombosUnscoped([c.id, a.id, b.id])).toBe(true);
    expect(names(await getCombosUnscoped())).toEqual(["c", "a", "b"]);
    // A combo created afterwards still lands last.
    await createComboUnscoped({ name: "d" });
    expect(names(await getCombosUnscoped())).toEqual(["c", "a", "b", "d"]);
  });

  it("reordering a subset leaves combos outside it in their slots", async () => {
    const { createComboUnscoped, getCombosUnscoped, reorderCombosUnscoped } = await import(
      "@/lib/db/repos/combosRepo.js"
    );
    const a = await createComboUnscoped({ name: "a", kind: "llm" });
    await createComboUnscoped({ name: "web", kind: "webSearch" });
    const c = await createComboUnscoped({ name: "c", kind: "llm" });
    // The dashboard lists LLM combos only: [a, c] -> [c, a].
    await reorderCombosUnscoped([c.id, a.id]);
    expect(names(await getCombosUnscoped())).toEqual(["c", "web", "a"]);
  });

  it("ignores unknown and duplicate ids, and reports no change for a no-op", async () => {
    const { createComboUnscoped, getCombosUnscoped, reorderCombosUnscoped } = await import(
      "@/lib/db/repos/combosRepo.js"
    );
    const a = await createComboUnscoped({ name: "a" });
    const b = await createComboUnscoped({ name: "b" });
    expect(await reorderCombosUnscoped([a.id, b.id])).toBe(false);
    expect(await reorderCombosUnscoped(["nope", b.id, b.id, a.id])).toBe(true);
    expect(names(await getCombosUnscoped())).toEqual(["b", "a"]);
    expect(await reorderCombosUnscoped([a.id])).toBe(false);
  });

  it("migration 006 backfills sortOrder in creation order for existing combos", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM combos`);
    db.run(
      `INSERT INTO combos(id, name, models, createdAt, updatedAt, sortOrder) VALUES
         ('1', 'old', '[]', '2026-01-01', 'x', NULL),
         ('2', 'mid', '[]', '2026-02-01', 'x', NULL),
         ('3', 'new', '[]', '2026-03-01', 'x', NULL),
         ('4', 'new2', '[]', '2026-03-01', 'x', NULL)`,
    );
    const { default: m006 } = await import("@/lib/db/migrations/006-combo-sort-order.js");
    m006.up(db);
    const { getCombosUnscoped } = await import("@/lib/db/repos/combosRepo.js");
    expect(names(await getCombosUnscoped())).toEqual(["old", "mid", "new", "new2"]);
    expect(
      db.all(`SELECT sortOrder FROM combos ORDER BY sortOrder`).map((r) => r.sortOrder),
    ).toEqual([0, 1, 2, 3]);
    // Idempotent re-run.
    m006.up(db);
    expect(names(await getCombosUnscoped())).toEqual(["old", "mid", "new", "new2"]);
  });
});
