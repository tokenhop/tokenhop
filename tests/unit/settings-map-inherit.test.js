// YAN-770: workspace map keys inherit per entry (providerStrategies,
// quotaVisibility, providerThinking; auto-ping also per connection id), and
// loadOwnedMap reads the workspace's own `data` map (never merged effective)
// with opt-in seeding from `effective`. comboStrategies stays whole-replace.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeWorkspaceLayer } from "@/lib/settings/settingsScope.js";
import {
  clearOwnedEntry,
  hidesNothing,
  isAutoThinking,
  loadOwnedMap,
} from "@/shared/utils/settingsApi.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let db;
let repo;
let adapter;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/workspaceSettingsRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("mergeWorkspaceLayer (pure)", () => {
  it("providerStrategies: workspace entry overrides, other ids inherit instance", () => {
    const merged = {
      providerStrategies: { a: { fallbackStrategy: "x" }, b: { fallbackStrategy: "z" } },
    };
    const ws = { providerStrategies: { a: { fallbackStrategy: "y" } } };
    expect(mergeWorkspaceLayer(merged, ws).providerStrategies).toEqual({
      a: { fallbackStrategy: "y" },
      b: { fallbackStrategy: "z" },
    });
    expect(ws.providerStrategies).toEqual({ a: { fallbackStrategy: "y" } }); // input untouched
  });

  it("claudeAutoPing: enabled from instance, connections merged per id", () => {
    const out = mergeWorkspaceLayer(
      { claudeAutoPing: { enabled: true, connections: { c1: true } } },
      { claudeAutoPing: { connections: { c2: false } } },
    );
    expect(out.claudeAutoPing).toEqual({ enabled: true, connections: { c1: true, c2: false } });
  });

  it("non-map key and comboStrategies are replaced whole; unrelated merged keys survive", () => {
    const out = mergeWorkspaceLayer(
      { fallbackStrategy: "weighted", comboStrategies: { demo: { fallbackStrategy: "x" } } },
      { fallbackStrategy: "fusion", comboStrategies: { solo: { fallbackStrategy: "y" } } },
    );
    expect(out.fallbackStrategy).toBe("fusion");
    expect(out.comboStrategies).toEqual({ solo: { fallbackStrategy: "y" } });
  });
});

describe("map inheritance in the DB (switch on)", () => {
  let sharedCtx;
  beforeEach(async () => {
    await load("on");
    const t = await (await import("../setup/tenancyHarness.js")).seedTenancy();
    adapter.run(`DELETE FROM workspaceSettings`);
    await db.updateSettings({
      providerStrategies: { a: { fallbackStrategy: "weighted" }, b: { fallbackStrategy: "x" } },
    });
    await repo.updateWorkspaceSettings(t.a.ctx, t.shared.id, {
      providerStrategies: { a: { fallbackStrategy: "fusion" } },
    });
    sharedCtx = { ...t.a.ctx, activeWorkspaceId: t.shared.id };
  });

  it("workspace override wins per entry; inherited entry follows instance updates", async () => {
    const eff = await db.getEffectivePreferences(sharedCtx);
    expect(eff.providerStrategies).toEqual({
      a: { fallbackStrategy: "fusion" },
      b: { fallbackStrategy: "x" },
    });

    await db.updateSettings({
      providerStrategies: { a: { fallbackStrategy: "weighted" }, b: { fallbackStrategy: "y" } },
    });
    const eff2 = await db.getEffectivePreferences(sharedCtx);
    expect(eff2.providerStrategies).toEqual({
      a: { fallbackStrategy: "fusion" },
      b: { fallbackStrategy: "y" },
    });
  });

  it("listEffectivePreferencesUnscoped includes the merged entry", async () => {
    const views = await db.listEffectivePreferencesUnscoped();
    expect(
      views.some(
        (v) =>
          v.providerStrategies?.a?.fallbackStrategy === "fusion" &&
          v.providerStrategies?.b?.fallbackStrategy === "x",
      ),
    ).toBe(true);
  });

  it("comboStrategies of the instance is not inherited by a workspace without its own map", async () => {
    await db.createComboUnscoped({ name: "demo", models: [] });
    await db.updateComboStrategies(() => ({ demo: { fallbackStrategy: "weighted" } }));
    expect((await db.getEffectivePreferences(sharedCtx)).comboStrategies).toEqual({});
  });
});

describe("loadOwnedMap", () => {
  const WS = "/api/workspaces/w1/settings";

  function stubFetch(responses) {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        calls.push({ url, method: init.method || "GET" });
        const hit = responses[url];
        return {
          ok: Boolean(hit),
          json: async () => hit ?? { error: "boom" },
        };
      }),
    );
    return calls;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("workspace scope: own data entries plus seeded inherited ids, never unseeded ones", async () => {
    stubFetch({
      [WS]: {
        data: { providerStrategies: { a: { fallbackStrategy: "fusion" } } },
        effective: {
          providerStrategies: {
            a: { fallbackStrategy: "fusion" },
            b: { fallbackStrategy: "weighted" },
            c: { fallbackStrategy: "x" },
          },
        },
      },
    });
    const map = await loadOwnedMap("providerStrategies", { workspaceId: "w1" }, ["b"]);
    expect(map).toEqual({ a: { fallbackStrategy: "fusion" }, b: { fallbackStrategy: "weighted" } });
    expect(map).not.toHaveProperty("c");
  });

  it("workspace scope: empty data + seed id seeds from effective", async () => {
    stubFetch({
      [WS]: {
        data: {},
        effective: { providerStrategies: { b: { fallbackStrategy: "weighted" } } },
      },
    });
    expect(await loadOwnedMap("providerStrategies", { workspaceId: "w1" }, ["b"])).toEqual({
      b: { fallbackStrategy: "weighted" },
    });
  });

  it("scope null hits /api/settings and returns the stored map", async () => {
    const calls = stubFetch({ "/api/settings": { providerStrategies: { a: 1 } } });
    expect(await loadOwnedMap("providerStrategies", null)).toEqual({ a: 1 });
    expect(calls).toEqual([{ url: "/api/settings", method: "GET" }]);
  });

  it("non-ok response throws the server's message", async () => {
    stubFetch({});
    await expect(loadOwnedMap("providerStrategies", null)).rejects.toThrow("boom");
  });
});

// CodeRabbit on #824: clearing a workspace entry must not re-inherit a
// non-neutral instance entry (Auto thinking, unhiding the last quota key).
describe("clearOwnedEntry", () => {
  it("masks a non-neutral inherited entry, else deletes", () => {
    const owned = { claude: { mode: "high" }, codex: { mode: "low" } };
    expect(
      clearOwnedEntry(
        owned,
        "claude",
        { claude: { mode: "max" } },
        { mode: "auto" },
        isAutoThinking,
      ),
    ).toEqual({ claude: { mode: "auto" }, codex: { mode: "low" } });
    expect(
      clearOwnedEntry(
        owned,
        "claude",
        { claude: { mode: "auto" } },
        { mode: "auto" },
        isAutoThinking,
      ),
    ).toEqual({ codex: { mode: "low" } });
    expect(clearOwnedEntry(owned, "claude", {}, { mode: "auto" }, isAutoThinking)).toEqual({
      codex: { mode: "low" },
    });
    expect(
      clearOwnedEntry(
        { a: { hidden: ["x"] } },
        "a",
        { a: { hidden: ["y"] } },
        { hidden: [] },
        hidesNothing,
      ),
    ).toEqual({ a: { hidden: [] } });
    expect(
      clearOwnedEntry({ a: { hidden: ["x"] } }, "a", {}, { hidden: [] }, hidesNothing),
    ).toEqual({});
  });
});
