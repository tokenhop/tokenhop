// YAN-749: pages outside Settings route workspace keys through the shared
// settings helpers. Pins each caller's keys to the owning endpoint, and the
// single-user regression: scope null keeps every call on /api/settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comboStrategyKeyFor,
  loadSettings,
  patchSettings,
  settingsEndpoint,
} from "@/shared/utils/settingsApi";

const WS = "/api/workspaces/ws-1/settings";
const INSTANCE = "/api/settings";
const scope = { workspaceId: "ws-1" };

// Keys each migrated caller reads or writes, and the endpoint that owns them.
const CALLERS = {
  "token-saver": {
    workspace: ["rtkEnabled", "cavemanEnabled", "cavemanLevel", "ponytailEnabled", "ponytailLevel"],
    instance: [
      "headroomEnabled",
      "headroomUrl",
      "headroomTimeoutMs",
      "headroomCompressUserMessages",
      "headroomCodeAware",
      "headroomKompress",
    ],
  },
  quota: { workspace: ["claudeAutoPing", "codexAutoPing", "quotaVisibility"], instance: [] },
  combos: { workspace: ["comboStrategies", "capacityAdapter"], instance: [] },
  providers: {
    workspace: [
      "providerStrategies",
      "fallbackStrategy",
      "stickyRoundRobinLimit",
      "providerThinking",
      "claudeAutoPing",
      "codexAutoPing",
    ],
    instance: [],
  },
  home: { workspace: ["comboStrategies"], instance: ["requireApiKey", "requireLogin"] },
  "cli-tools": { workspace: ["ccFilterNaming"], instance: ["cloudEnabled"] },
};

function stubFetch(responses) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      return { ok: true, json: async () => responses[url] ?? {} };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("caller key routing", () => {
  for (const [page, { workspace, instance }] of Object.entries(CALLERS)) {
    it(`${page}: workspace keys go to the workspace, instance keys stay`, () => {
      for (const key of workspace) expect(settingsEndpoint(key, scope)).toBe(WS);
      for (const key of instance) expect(settingsEndpoint(key, scope)).toBe(INSTANCE);
    });
  }

  it("combo strategies are keyed by id when scoped, by name otherwise", () => {
    const combo = { id: "c1", name: "fast" };
    expect(comboStrategyKeyFor(scope, combo)).toBe("c1");
    expect(comboStrategyKeyFor(null, combo)).toBe("fast");
  });
});

describe("single-user regression (multiUserActive false)", () => {
  it("every caller key resolves to /api/settings", () => {
    for (const { workspace, instance } of Object.values(CALLERS)) {
      for (const key of [...workspace, ...instance]) {
        expect(settingsEndpoint(key, null)).toBe(INSTANCE);
      }
    }
  });

  it("loads and saves hit only /api/settings with the legacy body", async () => {
    const calls = stubFetch({ [INSTANCE]: { rtkEnabled: true, headroomUrl: "x" } });
    expect(await loadSettings(null)).toEqual({ rtkEnabled: true, headroomUrl: "x" });
    await patchSettings({ rtkEnabled: false, headroomUrl: "y" }, null);
    expect(calls).toEqual([
      { url: INSTANCE, method: "GET", body: undefined },
      {
        url: INSTANCE,
        method: "PATCH",
        body: JSON.stringify({ rtkEnabled: false, headroomUrl: "y" }),
      },
    ]);
  });
});

describe("scoped loads", () => {
  it("a member reads workspace effective values and never the instance route", async () => {
    const calls = stubFetch({ [WS]: { data: {}, effective: { rtkEnabled: true } } });
    expect(await loadSettings(scope, { canManageInstance: false })).toEqual({ rtkEnabled: true });
    expect(calls.map((c) => c.url)).toEqual([WS]);
  });

  it("an admin merges instance values under the workspace's", async () => {
    stubFetch({
      [INSTANCE]: { headroomUrl: "h", rtkEnabled: false },
      [WS]: { effective: { rtkEnabled: true } },
    });
    expect(await loadSettings(scope, { canManageInstance: true })).toEqual({
      headroomUrl: "h",
      rtkEnabled: true,
    });
  });
});
