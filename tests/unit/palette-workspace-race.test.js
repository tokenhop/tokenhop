import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedLoader } from "@/shared/utils/commandPalette.js";
import { withWorkspace } from "@/app/(dashboard)/dashboard/providers/connectTarget.js";

// CommandPaletteProvider.js holds JSX in a .js file, which vite cannot import
// under the test config. Slice the real fetchJson + createDataCache source (no
// JSX in that range) and evaluate it with the real helpers injected, so the
// test exercises production code rather than a copy.
const source = readFileSync(
  resolve(__dirname, "../../src/shared/components/CommandPaletteProvider.js"),
  "utf8",
);
const from = source.indexOf("async function fetchJson");
const to = source.indexOf("async function runPaletteVerb");
if (from < 0 || to < from) throw new Error("createDataCache source markers not found");
const body = source
  .slice(from, to)
  .replace("export function createDataCache", "function createDataCache");
const createDataCache = new Function(
  "createCachedLoader",
  "withWorkspace",
  `${body}\nreturn createDataCache;`,
)(createCachedLoader, withWorkspace);

// Regression: an old workspace-A refresh finishing after workspace-B must not
// overwrite B's snapshot (snapshot A + cachedWorkspaceId B).

let pending;
let calls;

// fetch stub: every call stays pending until the test settles it by URL.
function stubFetch() {
  pending = new Map();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      calls.push(url);
      return new Promise((resolve) => {
        const queue = pending.get(url) || [];
        queue.push(resolve);
        pending.set(url, queue);
      });
    }),
  );
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = () => ({ ok: false, status: 500, json: async () => ({}) });

function settle(url, response) {
  const resolve = pending.get(url)?.shift();
  if (!resolve) throw new Error(`no pending fetch for ${url}`);
  resolve(response);
}

const providersUrl = (id) => `/api/providers?workspaceId=${encodeURIComponent(id)}`;
const combosUrl = (id) => `/api/combos?workspaceId=${encodeURIComponent(id)}`;

function settleWorkspace(id, connections, combos) {
  settle(providersUrl(id), ok({ connections }));
  settle(combosUrl(id), ok({ combos }));
}

describe("palette data cache workspace race", () => {
  beforeEach(stubFetch);
  afterEach(() => vi.unstubAllGlobals());

  it("late success from workspace A does not overwrite workspace B", async () => {
    const cache = createDataCache();
    const refreshA = cache.refresh({ includeModels: false, workspaceId: "A" });
    const refreshB = cache.refresh({ includeModels: false, workspaceId: "B" });

    settleWorkspace("B", [{ id: "pB" }], [{ id: "cB" }]);
    const snapshotB = await refreshB;
    expect(snapshotB.providers).toEqual([{ id: "pB" }]);

    settleWorkspace("A", [{ id: "pA" }], [{ id: "cA" }]);
    const staleResult = await refreshA;
    expect(staleResult.providers).toEqual([{ id: "pB" }]);
    expect(staleResult.combos).toEqual([{ id: "cB" }]);

    // Same-workspace follow-up is served from cache: B data, no new fetches.
    const before = calls.length;
    const next = await cache.refresh({ includeModels: false, workspaceId: "B" });
    expect(calls.length).toBe(before);
    expect(next.providers).toEqual([{ id: "pB" }]);
    expect(next.combos).toEqual([{ id: "cB" }]);
  });

  it("late failure from workspace A does not clear workspace B", async () => {
    const cache = createDataCache();
    const refreshA = cache.refresh({ includeModels: false, workspaceId: "A" });
    const refreshB = cache.refresh({ includeModels: false, workspaceId: "B" });

    settleWorkspace("B", [{ id: "pB" }], [{ id: "cB" }]);
    await refreshB;

    // fetchJson errors are swallowed to [] inside refresh; stale A must not
    // persist that empty result over B.
    settle(providersUrl("A"), fail());
    settle(combosUrl("A"), fail());
    await refreshA;

    const before = calls.length;
    const next = await cache.refresh({ includeModels: false, workspaceId: "B" });
    expect(calls.length).toBe(before);
    expect(next.providers).toEqual([{ id: "pB" }]);
    expect(next.combos).toEqual([{ id: "cB" }]);
  });

  it("stale A finishing before B resolves does not poison B", async () => {
    const cache = createDataCache();
    const refreshA = cache.refresh({ includeModels: false, workspaceId: "A" });
    const refreshB = cache.refresh({ includeModels: false, workspaceId: "B" });

    settleWorkspace("A", [{ id: "pA" }], [{ id: "cA" }]);
    await refreshA;
    settleWorkspace("B", [{ id: "pB" }], [{ id: "cB" }]);
    const snapshotB = await refreshB;

    expect(snapshotB.providers).toEqual([{ id: "pB" }]);
    expect(snapshotB.combos).toEqual([{ id: "cB" }]);
  });

  it("same workspace reuses cache; forceProviders refetches providers only", async () => {
    const cache = createDataCache();
    const first = cache.refresh({ includeModels: false, workspaceId: "A" });
    settleWorkspace("A", [{ id: "pA" }], [{ id: "cA" }]);
    await first;
    expect(calls).toEqual([providersUrl("A"), combosUrl("A")]);

    await cache.refresh({ includeModels: false, workspaceId: "A" });
    expect(calls).toHaveLength(2);

    const forced = cache.refresh({ includeModels: false, workspaceId: "A", forceProviders: true });
    settle(providersUrl("A"), ok({ connections: [{ id: "pA2" }] }));
    const snapshot = await forced;
    expect(calls).toEqual([providersUrl("A"), combosUrl("A"), providersUrl("A")]);
    expect(snapshot.providers).toEqual([{ id: "pA2" }]);
    expect(snapshot.combos).toEqual([{ id: "cA" }]);
  });

  it("encodes workspaceId into providers and combos URLs", async () => {
    const cache = createDataCache();
    const id = "team a/1&x=y";
    const refresh = cache.refresh({ includeModels: false, workspaceId: id });
    expect(calls).toEqual([
      `/api/providers?workspaceId=${encodeURIComponent(id)}`,
      `/api/combos?workspaceId=${encodeURIComponent(id)}`,
    ]);
    expect(calls[0]).toContain("team%20a%2F1%26x%3Dy");
    settleWorkspace(id, [], []);
    await refresh;
  });

  it("drops scoped models and their cached loader on workspace switch", async () => {
    const cache = createDataCache();
    const a = cache.refresh({ includeModels: true, workspaceId: "A" });
    settleWorkspace("A", [], []);
    await vi.waitFor(() => expect(calls).toContain("/api/models?workspaceId=A"));
    settle("/api/models?workspaceId=A", ok({ models: [{ id: "model-A" }] }));
    expect((await a).models).toEqual([{ id: "model-A" }]);

    const b = cache.refresh({ includeModels: true, workspaceId: "B" });
    settleWorkspace("B", [], []);
    await vi.waitFor(() => expect(calls).toContain("/api/models?workspaceId=B"));
    settle("/api/models?workspaceId=B", ok({ models: [{ id: "model-B" }] }));
    expect((await b).models).toEqual([{ id: "model-B" }]);
    expect((await cache.refresh({ includeModels: true, workspaceId: "B" })).models).toEqual([
      { id: "model-B" },
    ]);
  });

  it("null workspace keeps the exact legacy URLs", async () => {
    const cache = createDataCache();
    const refresh = cache.refresh({ includeModels: false });
    expect(calls).toEqual(["/api/providers", "/api/combos"]);
    settle("/api/providers", ok({ connections: [{ id: "p" }] }));
    settle("/api/combos", ok({ combos: [{ id: "c" }] }));
    const snapshot = await refresh;
    expect(snapshot.providers).toEqual([{ id: "p" }]);
    expect(snapshot.combos).toEqual([{ id: "c" }]);
  });
});
