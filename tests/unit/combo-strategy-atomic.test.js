// updateComboStrategies: serialized transforms merge without losing stale writes;
// rename migrates the latest stored weights entry, not a snapshot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let sqliteDb;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-combo-atomic-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("comboStrategies atomic transforms", () => {
  it("weight deltas from the same base merge without loss", async () => {
    await sqliteDb.updateSettings({
      comboStrategies: { code: { fallbackStrategy: "weighted", weights: { a: 1 } } },
    });

    // Simulate two rapid UI saves built from the same stale representation.
    const apply = (model, value) =>
      sqliteDb.updateComboStrategies((strategies) => {
        const next = { ...(strategies.code || {}), weights: { ...strategies.code?.weights } };
        next.weights[model] = value;
        return { ...strategies, code: next };
      });
    await apply("a", 3);
    await apply("b", 2);

    const settings = await sqliteDb.getSettings();
    expect(settings.comboStrategies.code.weights).toEqual({ a: 3, b: 2 });
  });

  it("rename moves the latest weight for the entry", async () => {
    await sqliteDb.updateSettings({
      comboStrategies: { oldCombo: { fallbackStrategy: "weighted", weights: { a: 5 } } },
    });
    const move = (fromName, toName) =>
      sqliteDb.updateComboStrategies((strategies) => {
        if (!Object.hasOwn(strategies, fromName)) return strategies;
        const updated = { ...strategies };
        if (toName) updated[toName] = updated[fromName];
        delete updated[fromName];
        return updated;
      });
    await move("oldCombo", "newCombo");

    const settings = await sqliteDb.getSettings();
    expect(settings.comboStrategies.newCombo.weights).toEqual({ a: 5 });
    expect(settings.comboStrategies.oldCombo).toBeUndefined();
  });

  it("rename with no entry skips the SQL write", async () => {
    const before = await sqliteDb.getSettings();
    const after = await sqliteDb.updateComboStrategies((strategies) => strategies);
    expect(after.comboStrategies).toEqual(before.comboStrategies);
  });

  it("stale requireComboName throws COMBO_NOT_FOUND with no write", async () => {
    await sqliteDb.updateSettings({ comboStrategies: {} });
    await sqliteDb.createCombo({ name: "staleCombo", models: [] });
    await expect(
      sqliteDb.updateComboStrategies(
        (strategies) => ({ ...strategies, staleCombo: { fallbackStrategy: "weighted" } }),
        "renamedCombo",
      ),
    ).rejects.toMatchObject({ code: "COMBO_NOT_FOUND" });
    expect((await sqliteDb.getSettings()).comboStrategies).toEqual({});
    await sqliteDb.deleteCombo((await sqliteDb.getComboByName("staleCombo")).id);
  });
});

describe("PATCH /api/settings comboStrategyPatch after rename", () => {
  const comboPost = async (name) =>
    (await import("@/app/api/combos/route.js")).POST(
      new Request("http://localhost/api/combos", {
        method: "POST",
        body: JSON.stringify({ name, models: [] }),
      }),
    );
  const comboPut = async (id, body) =>
    (await import("@/app/api/combos/[id]/route.js")).PUT(
      new Request(`http://localhost/api/combos/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  const settingsPatch = (body) =>
    import("@/app/api/settings/route.js").then(({ PATCH }) =>
      PATCH(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      ),
    );
  const stale = (name) =>
    settingsPatch({ comboStrategyPatch: { name, patch: { weights: { m: 1 } } } });

  it("stale weight patch after rename 409s with no strategy write", async () => {
    const created = await (await comboPost("staleRouteCombo")).json();
    const strat = await (
      await settingsPatch({
        comboStrategyPatch: {
          name: "staleRouteCombo",
          patch: { fallbackStrategy: "weighted", weights: { m: 1 } },
        },
      })
    ).json();
    expect(strat.comboStrategies.staleRouteCombo.weights).toEqual({ m: 1 });

    await comboPut(created.id, { name: "renamedRouteCombo" });

    const res = await stale("staleRouteCombo");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Combo not found" });
    const after = await sqliteDb.getSettings();
    expect(after.comboStrategies.staleRouteCombo).toBeUndefined();
    expect(after.comboStrategies.renamedRouteCombo.weights).toEqual({ m: 1 });
  });

  const comboDelete = async (id) =>
    (await import("@/app/api/combos/[id]/route.js")).DELETE(
      new Request(`http://localhost/api/combos/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id }) },
    );
  const weighted = (name, weights) =>
    settingsPatch({
      comboStrategyPatch: { name, patch: { fallbackStrategy: "weighted", weights } },
    });

  it("rename moves the current strategy entry exactly", async () => {
    const created = await (await comboPost("exactRenameCombo")).json();
    await weighted("exactRenameCombo", { m: 4, n: 1 });
    const before = (await sqliteDb.getSettings()).comboStrategies.exactRenameCombo;

    const res = await comboPut(created.id, { name: "exactRenamedCombo" });
    expect(res.status).toBe(200);
    const after = (await sqliteDb.getSettings()).comboStrategies;
    expect(after.exactRenamedCombo).toEqual(before);
    expect(Object.hasOwn(after, "exactRenameCombo")).toBe(false);
  });

  it("delete drops the strategy entry and stale patch 409s", async () => {
    const created = await (await comboPost("deleteRouteCombo")).json();
    await weighted("deleteRouteCombo", { m: 1 });

    expect((await comboDelete(created.id)).status).toBe(200);
    expect(Object.hasOwn((await sqliteDb.getSettings()).comboStrategies, "deleteRouteCombo")).toBe(
      false,
    );

    const res = await stale("deleteRouteCombo");
    expect(res.status).toBe(409);
    expect(Object.hasOwn((await sqliteDb.getSettings()).comboStrategies, "deleteRouteCombo")).toBe(
      false,
    );
  });

  it("concurrent rename and weight patch never orphan the old key", async () => {
    const created = await (await comboPost("raceCombo")).json();
    await weighted("raceCombo", { m: 1 });

    const [renameRes, patchRes] = await Promise.all([
      comboPut(created.id, { name: "raceRenamedCombo" }),
      weighted("raceCombo", { m: 7 }),
    ]);
    expect(renameRes.status).toBe(200);
    expect([200, 409]).toContain(patchRes.status);
    const after = (await sqliteDb.getSettings()).comboStrategies;
    expect(Object.hasOwn(after, "raceCombo")).toBe(false);
    expect(after.raceRenamedCombo.weights).toEqual(patchRes.status === 200 ? { m: 7 } : { m: 1 });
  });

  it("failed strategy migration rolls back the rename with 500", async () => {
    const created = await (await comboPost("rollbackCombo")).json();
    await weighted("rollbackCombo", { m: 3 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const run = db.run;
    const spy = vi.spyOn(db, "run").mockImplementation((sql, params) => {
      if (sql.startsWith("UPDATE settings")) throw new Error("boom");
      return run.call(db, sql, params);
    });
    try {
      const res = await comboPut(created.id, { name: "rollbackRenamedCombo" });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await sqliteDb.getComboById(created.id)).name).toBe("rollbackCombo");
    const after = (await sqliteDb.getSettings()).comboStrategies;
    expect(after.rollbackCombo.weights).toEqual({ m: 3 });
    expect(Object.hasOwn(after, "rollbackRenamedCombo")).toBe(false);
  });

  it("failed strategy delete rolls back with 500", async () => {
    const created = await (await comboPost("deleteRollbackCombo")).json();
    await weighted("deleteRollbackCombo", { m: 9 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const run = db.run;
    const spy = vi.spyOn(db, "run").mockImplementation((sql, params) => {
      if (sql.startsWith("UPDATE settings")) throw new Error("boom");
      return run.call(db, sql, params);
    });
    try {
      const res = await comboDelete(created.id);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await sqliteDb.getComboById(created.id)).name).toBe("deleteRollbackCombo");
    expect((await sqliteDb.getSettings()).comboStrategies.deleteRollbackCombo.weights).toEqual({
      m: 9,
    });
  });

  it("rename without entry and models-only update leave strategies untouched", async () => {
    const created = await (await comboPost("noStratCombo")).json();
    const before = (await sqliteDb.getSettings()).comboStrategies;

    const renamed = await comboPut(created.id, { name: "noStratRenamedCombo" });
    expect(renamed.status).toBe(200);
    expect((await sqliteDb.getSettings()).comboStrategies).toEqual(before);

    const modelsOnly = await comboPut(created.id, { models: ["m1"] });
    expect(modelsOnly.status).toBe(200);
    expect((await sqliteDb.getSettings()).comboStrategies).toEqual(before);

    expect((await comboDelete(created.id)).status).toBe(200);
    expect((await sqliteDb.getSettings()).comboStrategies).toEqual(before);
  });

  it("weight-only patch with no weighted entry and valid new weighted patch", async () => {
    await comboPost("plainRouteCombo");
    await comboPost("newWeightedRouteCombo");
    const noEntry = await stale("plainRouteCombo");
    expect(noEntry.status).toBe(409);

    const created = await settingsPatch({
      comboStrategyPatch: {
        name: "newWeightedRouteCombo",
        patch: { fallbackStrategy: "weighted", weights: { m: 2 } },
      },
    });
    expect(created.status).toBe(200);
    expect((await created.json()).comboStrategies.newWeightedRouteCombo.weights).toEqual({ m: 2 });

    const weightedOnly = await stale("newWeightedRouteCombo");
    expect(weightedOnly.status).toBe(200);
    expect((await weightedOnly.json()).comboStrategies.newWeightedRouteCombo.weights).toEqual({
      m: 1,
    });
  });

  it("keeps an explicit Fallback choice instead of inheriting the global strategy (YAN-679)", async () => {
    await comboPost("explicitFallbackCombo");
    const res = await settingsPatch({
      comboStrategyPatch: {
        name: "explicitFallbackCombo",
        patch: { fallbackStrategy: "fallback" },
      },
    });
    expect(res.status).toBe(200);
    const stored = (await sqliteDb.getSettings()).comboStrategies.explicitFallbackCombo;
    expect(stored?.fallbackStrategy).toBe("fallback");
    const { resolveComboStrategy } = await import("open-sse/services/comboStrategy.js");
    expect(
      resolveComboStrategy(
        { comboStrategy: "round-robin", comboStrategies: { explicitFallbackCombo: stored } },
        "explicitFallbackCombo",
      ).strategy,
    ).toBe("fallback");
  });
});
