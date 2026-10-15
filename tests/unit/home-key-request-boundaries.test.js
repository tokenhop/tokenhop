import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same minimal hook driver as endpoint-instance-gate: exercise real effects,
// with explicit renders at identity transitions (no DOM or new dependencies).
const rt = vi.hoisted(() => {
  const state = { slots: [], index: 0, pending: [] };
  const same = (a, b) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (init) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = init();
    return state.slots[i];
  };
  const hooks = {
    useState(initial) {
      const s = slot(() => {
        const s = { value: typeof initial === "function" ? initial() : initial };
        s.set = (v) => {
          s.value = typeof v === "function" ? v(s.value) : v;
        };
        return s;
      });
      return [s.value, s.set];
    },
    useRef(initial) {
      return slot(() => ({ current: initial }));
    },
    useMemo(fn, deps) {
      const s = slot(() => ({}));
      if (!same(s.deps, deps)) Object.assign(s, { value: fn(), deps });
      return s.value;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const s = slot(() => ({}));
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
const auth = vi.hoisted(() => ({ value: {} }));
const scope = vi.hoisted(() => ({ value: {} }));
vi.mock("@/shared/hooks/useAuthStatus", () => ({ useAuthStatusState: () => auth.value }));
vi.mock("@/shared/hooks/useSettingsScope", () => ({ useSettingsScope: () => scope.value }));
vi.mock("@/store/notificationStore", () => ({ useNotificationStore: () => vi.fn() }));
import { useApiKeys } from "../../src/app/(dashboard)/dashboard/endpoint/hooks/useApiKeys";
import {
  useHomeCombos,
  useHomeKeys,
  useHomeProviders,
  useHomeWaysIn,
} from "../../src/app/(dashboard)/dashboard/home/useHomeData";
import { resetHomeResourceStore } from "../../src/app/(dashboard)/dashboard/home/homeResourceStore";
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const statusFor = (id = "a", workspaceId = "w1") => ({
  authenticated: true,
  userSecurityEnforced: true,
  multiUserActive: true,
  principal: {
    user: { id },
    role: "user",
    activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, role: "member" }],
  },
});
const hashed = (workspaceId = "w1", extra = {}) => ({
  storage: "hashed",
  workspaceId,
  canCreate: true,
  canManage: false,
  ...extra,
});
const ADMIN = {
  ready: true,
  scope: { workspaceId: "w1" },
  canManageInstance: true,
  canHostOps: true,
  canReadConnections: true,
  canUseConnections: true,
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let fetchMock;
const urls = () => fetchMock.mock.calls.map(([url]) => url);
function render(hook, ...args) {
  rt.state.index = 0;
  rt.state.pending = [];
  const result = hook(...args);
  for (const run of rt.state.pending) run();
  return result;
}
beforeEach(() => {
  rt.state.slots = [];
  auth.value = { loaded: true, status: statusFor() };
  scope.value = ADMIN;
  fetchMock = vi.fn(async (url) =>
    json(
      url.includes("/context")
        ? hashed()
        : { keys: [{ id: "mine", prefix: "th_m…e" }], storage: "hashed" },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  for (const s of rt.state.slots) s.cleanup?.();
  resetHomeResourceStore();
  vi.unstubAllGlobals();
});

describe("Home request boundaries", () => {
  it("refreshes a stale identity-scoped key list on tab visibility, then removes the listener", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    render(useHomeKeys);
    await flush();
    const onVisible = document.addEventListener.mock.calls[0][1];
    expect(urls()).toHaveLength(2);
    now.mockReturnValue(110_000);
    onVisible();
    await flush();
    expect(urls()).toHaveLength(2);
    now.mockReturnValue(140_000);
    onVisible();
    await flush();
    expect(urls()).toHaveLength(4);
    for (const s of rt.state.slots) s.cleanup?.();
    expect(document.removeEventListener).toHaveBeenCalledWith("visibilitychange", onVisible);
    now.mockRestore();
  });
  it("keys and ways-in make no calls before identity is ready", async () => {
    auth.value = { loaded: false, status: {} };
    scope.value = { ...ADMIN, ready: false };
    const both = () => ({ keys: useHomeKeys(), ways: useHomeWaysIn() });
    render(both);
    await flush();
    expect(urls()).toEqual([]);
  });
  it("members see their scoped own-key list with a single context/list sequence", async () => {
    render(useHomeKeys);
    await flush();
    const r = render(useHomeKeys);
    expect(urls()).toEqual(["/api/keys/context?workspaceId=w1", "/api/keys?workspaceId=w1"]);
    expect(r.keys).toEqual([{ id: "mine", prefix: "th_m…e" }]);
    expect(r.context.canManage).toBe(false);
  });
  it("viewers skip listing, and pristine off keeps the bare legacy list", async () => {
    fetchMock.mockResolvedValue(json(hashed("w1", { canCreate: false })));
    render(useHomeKeys);
    await flush();
    expect(urls()).toEqual(["/api/keys/context?workspaceId=w1"]);
    for (const s of rt.state.slots) s.cleanup?.();
    rt.state.slots = [];
    auth.value = {
      loaded: true,
      status: { authenticated: false, requireLogin: false, hasPassword: false },
    };
    fetchMock.mockClear().mockResolvedValue(json({ keys: [{ id: "legacy", key: "sk-old" }] }));
    render(useHomeKeys);
    await flush();
    expect(urls()).toEqual(["/api/keys"]);
    expect(render(useHomeKeys).keys[0].key).toBe("sk-old");
  });
  it.each([
    [false, false, []],
    [true, false, ["/api/settings"]],
    [false, true, ["/api/tunnel/status"]],
    [true, true, ["/api/settings", "/api/tunnel/status"]],
  ])("settings=%s and host=%s gate independently", async (settings, host, expected) => {
    scope.value = { ...ADMIN, canManageInstance: settings, canHostOps: host };
    fetchMock.mockResolvedValue(json({ requireApiKey: false, tunnel: { enabled: true } }));
    render(useHomeWaysIn);
    await flush();
    const r = render(useHomeWaysIn);
    expect(urls().sort()).toEqual(expected);
    expect(r.tunnel.requireApiKey).toBe(settings ? false : null);
    expect(r.tunnel.canHostOps).toBe(host);
    expect(r.tunnel.tunnel).toEqual(host ? { enabled: true } : null);
  });
  it("unavailable settings never implies API key not required; local UI stays usable", async () => {
    fetchMock.mockResolvedValue(json({ error: "Forbidden" }, 403));
    render(useHomeWaysIn);
    await flush();
    const r = render(useHomeWaysIn);
    expect(r.tunnel.requireApiKey).toBeNull();
    expect(r.tunnel.canHostOps).toBe(false);
    expect(r.tunnel.tunnel).toBeNull();
    expect(r.loading).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it("drops stale context before listing on a workspace or identity change", async () => {
    let resolve;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(useHomeKeys);
    auth.value = { loaded: true, status: statusFor("b", "w2") };
    fetchMock.mockImplementation(async (url) =>
      json(url.includes("context") ? hashed("w2") : { keys: [{ id: "b" }], storage: "hashed" }),
    );
    expect(render(useHomeKeys).keys).toEqual([]);
    resolve(json(hashed("w1")));
    await flush();
    expect(render(useHomeKeys).keys).toEqual([{ id: "b" }]);
    expect(urls()).not.toContain("/api/keys?workspaceId=w1");
  });
  it("kill switch off on an established install still scopes hashed keys", async () => {
    auth.value.status = { ...statusFor(), multiUserActive: false };
    render(useHomeKeys);
    await flush();
    expect(urls()).toEqual(["/api/keys/context?workspaceId=w1", "/api/keys?workspaceId=w1"]);
  });
  it("providers and combos make no requests before scope is ready", async () => {
    scope.value = { ...ADMIN, ready: false };
    const both = () => ({ providers: useHomeProviders(), combos: useHomeCombos() });
    const r = render(both);
    await flush();
    expect(urls()).toEqual([]);
    expect(r.providers).toEqual({ connections: [], loading: true, error: null });
    expect(r.combos).toEqual({
      combos: [],
      strategies: {},
      globalStrategy: "fallback",
      loading: true,
      error: null,
    });
  });
  it("member (canReadConnections false, canUseConnections true) skips providers, combos and settings", async () => {
    scope.value = {
      ...ADMIN,
      canManageInstance: false,
      canHostOps: false,
      canReadConnections: false,
      canUseConnections: true,
    };
    const both = () => ({ providers: useHomeProviders(), combos: useHomeCombos() });
    render(both);
    await flush();
    const r = render(both);
    expect(urls()).toEqual([]);
    expect(r.providers).toEqual({ connections: [], loading: false, error: null });
    expect(r.combos).toEqual({
      combos: [],
      strategies: {},
      globalStrategy: "fallback",
      loading: false,
      error: null,
    });
  });
  it("viewer (both connection capabilities false) makes no providers, combos or settings requests", async () => {
    scope.value = {
      ...ADMIN,
      canManageInstance: false,
      canHostOps: false,
      canReadConnections: false,
      canUseConnections: false,
    };
    const both = () => ({ providers: useHomeProviders(), combos: useHomeCombos() });
    render(both);
    await flush();
    const r = render(both);
    expect(urls()).toEqual([]);
    expect(r.providers).toEqual({ connections: [], loading: false, error: null });
    expect(r.combos).toEqual({
      combos: [],
      strategies: {},
      globalStrategy: "fallback",
      loading: false,
      error: null,
    });
  });
  it("manager/owner (both capabilities true) fetches workspace-scoped providers, combos and settings", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith("/api/providers")) return json({ connections: [{ id: "p1" }] });
      if (url.startsWith("/api/combos")) return json({ combos: [{ id: "c1", name: "fast" }] });
      return json({
        effective: {
          comboStrategies: { c1: { strategy: "round-robin" } },
          comboStrategy: "least-used",
        },
      });
    });
    const both = () => ({ providers: useHomeProviders(), combos: useHomeCombos() });
    render(both);
    await flush();
    const r = render(both);
    expect(urls().sort()).toEqual([
      "/api/combos?workspaceId=w1",
      "/api/providers?workspaceId=w1",
      "/api/workspaces/w1/settings",
    ]);
    expect(r.providers).toEqual({ connections: [{ id: "p1" }], loading: false, error: null });
    expect(r.combos).toEqual({
      combos: [{ id: "c1", name: "fast" }],
      strategies: { fast: { strategy: "round-robin" } },
      globalStrategy: "least-used",
      loading: false,
      error: null,
    });
  });
  it("inactive/switch-off (scope null, both true) uses bare legacy endpoints", async () => {
    scope.value = { ...ADMIN, scope: null };
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/providers") return json({ connections: [{ id: "p1" }] });
      if (url === "/api/combos") return json({ combos: [{ id: "c1", name: "fast" }] });
      return json({
        comboStrategies: { fast: { strategy: "round-robin" } },
        comboStrategy: "fallback",
      });
    });
    const both = () => ({ providers: useHomeProviders(), combos: useHomeCombos() });
    render(both);
    await flush();
    const r = render(both);
    expect(urls().sort()).toEqual(["/api/combos", "/api/providers", "/api/settings"]);
    expect(r.providers.connections).toEqual([{ id: "p1" }]);
    expect(r.combos.strategies).toEqual({ fast: { strategy: "round-robin" } });
    expect(r.combos.error).toBeNull();
  });
  it("settings 404 while combos 200 degrades to fallback strategy without surfacing an error", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.startsWith("/api/combos")) return json({ combos: [{ id: "c1", name: "fast" }] });
      return json({ error: "Workspace not found" }, 404);
    });
    render(useHomeCombos);
    await flush();
    const r = render(useHomeCombos);
    expect(r).toEqual({
      combos: [{ id: "c1", name: "fast" }],
      strategies: {},
      globalStrategy: "fallback",
      loading: false,
      error: null,
    });
  });
  it("admin oversight without workspace use (canReadConnections true, canUseConnections false) skips workspace settings", async () => {
    scope.value = { ...ADMIN, canReadConnections: true, canUseConnections: false };
    fetchMock.mockResolvedValue(json({ combos: [{ id: "c1", name: "fast" }] }));
    render(useHomeCombos);
    await flush();
    const r = render(useHomeCombos);
    expect(urls()).toEqual(["/api/combos?workspaceId=w1"]);
    expect(r).toEqual({
      combos: [{ id: "c1", name: "fast" }],
      strategies: {},
      globalStrategy: "fallback",
      loading: false,
      error: null,
    });
  });
});

describe("Endpoint key identity invalidation", () => {
  it("unresolved or failed auth never starts context or provisioning", async () => {
    auth.value = { loaded: false, status: {} };
    let r = render(useApiKeys);
    await flush();
    expect(r.loading).toBe(true);
    expect(r.error).toBeNull();
    auth.value = { loaded: true, status: {} };
    render(useApiKeys);
    await flush();
    expect(urls()).toEqual([]);
    // Settled auth failure terminates loading with a nonsecret error.
    r = render(useApiKeys);
    expect(r.loading).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.keys).toEqual([]);
  });
  it("does not list or provision from a bootstrap context that outlives its identity", async () => {
    let resolve;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(useApiKeys);
    auth.value = { loaded: true, status: statusFor("b", "w2") };
    fetchMock.mockImplementation(async (url) =>
      json(url.includes("context") ? hashed("w2") : { keys: [{ id: "b" }], storage: "hashed" }),
    );
    expect(render(useApiKeys).contextReady).toBe(false);
    resolve(json({ storage: "legacy" }));
    await flush();
    const r = render(useApiKeys);
    expect(r.keys).toEqual([{ id: "b" }]);
    expect(r.context.workspaceId).toBe("w2");
    expect(urls()).not.toContain("/api/keys");
  });
  it("a stale refresh cannot populate a different user's keys or reuse cached context", async () => {
    render(useApiKeys);
    await flush();
    const old = render(useApiKeys);
    let resolve;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = old.fetchKeys();
    auth.value = { loaded: true, status: statusFor("b", "w1") };
    fetchMock.mockImplementation(async (url) =>
      json(url.includes("context") ? hashed() : { keys: [{ id: "b" }], storage: "hashed" }),
    );
    const before = render(useApiKeys);
    expect(before.keys).toEqual([]);
    expect(before.capabilities.canCreate).toBe(false);
    await flush();
    resolve(json({ keys: [{ id: "stale", key: "must-not-leak" }], storage: "hashed" }));
    await pending;
    expect(render(useApiKeys).keys).toEqual([{ id: "b" }]);
    const calls = fetchMock.mock.calls.length;
    await old.fetchKeys();
    expect(fetchMock.mock.calls).toHaveLength(calls);
  });
});
