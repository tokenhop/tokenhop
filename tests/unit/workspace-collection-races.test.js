// YAN-376: a collection load from a previous workspace/provider must never
// overwrite the state of the newest scope. Behavioral races run against the
// real useConnections hook (mocked React runtime, no DOM — same driver as
// quota-data-hook.test.js); the JSX pages carry the same generation guard and
// are covered by source contracts below.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook runtime: state survives renders, effects run only when deps
// change (with cleanup), setters are stable.
const rt = vi.hoisted(() => {
  const state = { slots: [], index: 0, pending: [] };
  const same = (a, b) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (init) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = init();
    return [i, state.slots[i]];
  };
  const hooks = {
    useState(initial) {
      const [, s] = slot(() => {
        const s = { value: typeof initial === "function" ? initial() : initial };
        s.set = (v) => {
          s.value = typeof v === "function" ? v(s.value) : v;
        };
        return s;
      });
      return [s.value, s.set];
    },
    useRef(initial) {
      return slot(() => ({ current: initial }))[1];
    },
    useMemo(fn, deps) {
      const [, s] = slot(() => ({}));
      if (!same(s.deps, deps)) Object.assign(s, { value: fn(), deps });
      return s.value;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const [, s] = slot(() => ({}));
      if (same(s.deps, deps)) return;
      s.deps = deps;
      state.pending.push(() => {
        s.cleanup?.();
        s.cleanup = fn();
      });
    },
  };
  return { state, hooks };
});
vi.mock("react", () => rt.hooks);

const scopeMock = vi.hoisted(() => ({ value: { ready: true, scope: null } }));
vi.mock("@/shared/hooks/useSettingsScope", () => ({
  useSettingsScope: () => scopeMock.value,
}));

import { useConnections } from "@/app/(dashboard)/dashboard/providers/detail/useConnections.js";

const notifyError = vi.fn();
const connA = { id: "a1", provider: "codex", priority: 1 };
const connB = { id: "b1", provider: "codex", priority: 1 };
const poolA = { id: "pool-a" };
const poolB = { id: "pool-b" };

// Deferred requests per route family, settled explicitly by each test.
let pending;
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const respond = (slot, body, { i = 0, ok = true } = {}) =>
  pending[slot][i].resolve({ ok, json: async () => body });

const render = (providerId = "codex") => {
  rt.state.index = 0;
  rt.state.pending = [];
  const result = useConnections({ providerId, notifyError });
  for (const run of rt.state.pending) run();
  return result;
};
const unmount = () => {
  for (const s of rt.state.slots) s.cleanup?.();
};

beforeEach(() => {
  rt.state.slots = [];
  scopeMock.value = { ready: true, scope: null };
  pending = { providers: [], pools: [] };
  globalThis.fetch = vi.fn((url) => {
    const d = defer();
    pending[url.startsWith("/api/proxy-pools") ? "pools" : "providers"].push({ url, ...d });
    return d.promise;
  });
});

describe("useConnections workspace races", () => {
  it("applies only the newest load after a workspace switch", async () => {
    scopeMock.value = { ready: true, scope: { workspaceId: "ws-a" } };
    const loadA = render().fetchConnections();
    expect(pending.providers[0].url).toBe("/api/providers?workspaceId=ws-a");

    scopeMock.value = { ready: true, scope: { workspaceId: "ws-b" } };
    const hookB = render();
    const loadB = hookB.fetchConnections();
    // The previous workspace's visible list is cleared on the switch.
    expect(render().connections).toEqual([]);
    expect(pending.providers[1].url).toBe("/api/providers?workspaceId=ws-b");

    // B settles first and applies.
    respond("pools", { proxyPools: [poolB] }, { i: 1 });
    respond("providers", { connections: [connB] }, { i: 1 });
    await loadB;
    expect(render().connections).toEqual([connB]);
    expect(render().proxyPools).toEqual([poolB]);

    // A settles last: neither the list nor the proxy pools may regress.
    respond("pools", { proxyPools: [poolA] });
    respond("providers", { connections: [connA] });
    await loadA;
    const final = render();
    expect(final.connections).toEqual([connB]);
    expect(final.proxyPools).toEqual([poolB]);
  });

  it("keeps the latest lists when the stale request fails", async () => {
    scopeMock.value = { ready: true, scope: { workspaceId: "ws-a" } };
    const loadA = render().fetchConnections();
    scopeMock.value = { ready: true, scope: { workspaceId: "ws-b" } };
    const loadB = render().fetchConnections();

    respond("pools", { proxyPools: [poolB] }, { i: 1 });
    respond("providers", { connections: [connB] }, { i: 1 });
    await loadB;

    pending.providers[0].reject(new Error("stale network"));
    await expect(loadA).rejects.toThrow("stale network");
    const latest = render();
    expect(latest.connections).toEqual([connB]);
    expect(latest.proxyPools).toEqual([poolB]);
  });

  it("drops in-flight responses after unmount", async () => {
    scopeMock.value = { ready: true, scope: { workspaceId: "ws-a" } };
    const load = render().fetchConnections();
    unmount();
    respond("providers", { connections: [connA] });
    respond("pools", { proxyPools: [poolA] });
    await load;
    const after = render();
    expect(after.connections).toEqual([]);
    expect(after.proxyPools).toEqual([]);
  });

  it("clears the visible list when the provider changes", async () => {
    const load = render().fetchConnections();
    respond("providers", { connections: [connA] });
    respond("pools", { proxyPools: [poolA] });
    await load;
    expect(render().connections).toEqual([connA]);
    render("gemini-cli"); // effect runs after the render snapshot
    expect(render("gemini-cli").connections).toEqual([]);
  });

  it("keeps legacy unscoped reloads and mutations working", async () => {
    const hook = render();
    const load = hook.fetchConnections();
    expect(pending.providers[0].url).toBe("/api/providers");
    respond("providers", { connections: [connA] });
    respond("pools", { proxyPools: [poolA] });
    await load;
    const loaded = render();
    expect(loaded.connections).toEqual([connA]);
    expect(loaded.proxyPools).toEqual([poolA]);

    const toggle = loaded.toggleActive("a1", false);
    expect(pending.providers[1].url).toBe("/api/providers/a1");
    pending.providers[1].resolve({ ok: true, json: async () => ({}) });
    await toggle;
    expect(render().connections).toEqual([{ ...connA, isActive: false }]);
  });
});

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const guardBefore = (text, call) => {
  const at = text.indexOf(call);
  return at > -1 && text.lastIndexOf("if (!isCurrent()) return;", at) > -1;
};

describe("workspace race source contracts", () => {
  it("CombosPageClient gates every list write behind the latest load", () => {
    const text = source("src/app/(dashboard)/dashboard/combos/CombosPageClient.js");
    expect(text).toContain("const loadGenerationRef = useRef(0)");
    expect(text).toContain("const generation = ++loadGenerationRef.current");
    expect(guardBefore(text, "setCombos(list)")).toBe(true);
    expect(text).toContain("if (isCurrent()) setLoadError(");
    expect(text).toContain("if (isCurrent()) setLoading(false)");
    // Scope change clears the visible lists and invalidates in-flight loads.
    expect(text).toMatch(
      /setCombos\(\[\]\);\s*setActiveProviders\(\[\]\);\s*setModelAliases\(\{\}\);\s*setUsageToday\(\{\}\);\s*if \(ready\) fetchData\(\);\s*return \(\) => \{\s*loadGenerationRef\.current\+\+;/,
    );
  });

  it("MediaKindSection gates every list write behind the latest load", () => {
    const text = source(
      "src/app/(dashboard)/dashboard/media-providers/components/MediaKindSection.js",
    );
    expect(text).toContain("const loadGenerationRef = useRef(0)");
    expect(guardBefore(text, "setConnections(connsData.connections")).toBe(true);
    expect(guardBefore(text, "setCustomNodes(")).toBe(true);
    expect(guardBefore(text, "setCombos(combosData.combos")).toBe(true);
    expect(text).toContain("if (isCurrent()) setError(");
    expect(text).toContain("if (isCurrent()) setLoading(false)");
    expect(text).toMatch(
      /setConnections\(\[\]\);\s*setCustomNodes\(\[\]\);\s*setCombos\(\[\]\);\s*if \(ready\) load\(\);\s*return \(\) => \{\s*loadGenerationRef\.current\+\+;/,
    );
  });

  it("useConnections guards list writes and invalidates on scope or provider change", () => {
    const text = source("src/app/(dashboard)/dashboard/providers/detail/useConnections.js");
    expect(text).toContain("const loadGenerationRef = useRef(0)");
    const guard = "if (loadGenerationRef.current !== generation) return;";
    expect(text.indexOf(guard)).toBeGreaterThan(-1);
    expect(text.indexOf(guard)).toBeLessThan(text.indexOf("if (connectionsRes.ok)"));
    expect(text).toMatch(
      /useEffect\(\(\) => \{\s*setConnections\(\[\]\);\s*return \(\) => \{\s*loadGenerationRef\.current\+\+;\s*\};\s*\}, \[providerId, scope\?\.workspaceId\]\);/,
    );
  });
});
