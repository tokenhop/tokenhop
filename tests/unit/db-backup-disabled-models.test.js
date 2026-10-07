// YAN-700 (backport): database export/import must round-trip the
// disabledModels kv scope, and a legacy payload without the section imports
// as an empty scope.
import { beforeAll, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";

let one;

beforeAll(async () => {
  await dbApi.initDb();
  const db = await getAdapter();
  one = (sql, params = []) => db.get(sql, params);
});

const rows = () => one(`SELECT COUNT(*) AS n FROM kv WHERE scope = 'disabledModels'`).n;
const map = async () => (await dbApi.exportDb()).disabledModels;

describe("exportDb/importDb disabledModels (YAN-700)", () => {
  it("round-trips disabled models, wiping stale rows", async () => {
    await dbApi.disableModels("openai", ["gpt-4o", "gpt-4o-mini"]);
    await dbApi.disableModels("anthropic", ["claude-x"]);
    const dump = await dbApi.exportDb();
    expect(dump.disabledModels).toEqual({
      openai: ["gpt-4o", "gpt-4o-mini"],
      anthropic: ["claude-x"],
    });

    await dbApi.enableModels("openai", ["gpt-4o", "gpt-4o-mini"]);
    await dbApi.enableModels("anthropic", ["claude-x"]);
    expect(rows()).toBe(0);

    await dbApi.importDb(dump);
    expect(await map()).toEqual({ openai: ["gpt-4o", "gpt-4o-mini"], anthropic: ["claude-x"] });
    expect(await dbApi.getDisabledByProvider("openai")).toEqual(["gpt-4o", "gpt-4o-mini"]);

    await dbApi.disableModels("gemini", ["g"]);
    await dbApi.importDb(dump);
    expect(await map()).toEqual({ openai: ["gpt-4o", "gpt-4o-mini"], anthropic: ["claude-x"] });
  });

  it("legacy payload without the section leaves the scope empty", async () => {
    await dbApi.disableModels("openai", ["gpt-4o"]);
    const dump = await dbApi.exportDb();
    delete dump.disabledModels;
    await dbApi.importDb(dump);
    expect(rows()).toBe(0);
    expect(await map()).toEqual({});
  });

  it("rejects malformed sections before any wipe", async () => {
    await dbApi.disableModels("openai", ["keep-me"]);
    const dump = await dbApi.exportDb();
    for (const bad of [null, [], "nope", { openai: "gpt-4o" }, { openai: [1] }]) {
      await expect(dbApi.importDb({ ...dump, disabledModels: bad })).rejects.toThrow(
        "disabledModels",
      );
      expect(await map()).toEqual(dump.disabledModels);
      expect(rows()).toBe(1);
    }
    await dbApi.importDb({ ...dump, disabledModels: {} });
    expect(await map()).toEqual({});
  });
});
