import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook runtime: state survives renders, effects run only when deps
// change (with cleanup), setters are stable. No DOM renderer is installed.
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

import { useQuotaData } from "../../src/app/(dashboard)/dashboard/quota/hooks/useQuotaData.js";
import {
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
} from "../../src/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: `status ${status}`,
  json: async () => body,
});

let routes;
let notify;
let docListeners;
const connA = { id: "a", provider: "codex" };
const connB = { id: "b", provider: "gemini-cli" };

function route(url) {
  if (url.startsWith("/api/providers/client")) return routes.connections();
  const id = url.match(/^\/api\/usage\/([^/?]+)/)?.[1];
  return (routes[id] || (() => json(200, {})))();
}

const props = () => ({
  page: 1,
  pageSize: 20,
  accountFilter: "all",
  providerFilter: "all",
  notify,
});

function render(p = props()) {
  rt.state.index = 0;
  rt.state.pending = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: test driver re-renders the hook against a mocked React runtime.
  const result = useQuotaData(p);
  for (const run of rt.state.pending) run();
  return result;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function mount(p) {
  render(p);
  await flush();
  return render(p);
}

beforeEach(() => {
  rt.state.slots = [];
  scopeMock.value = { ready: true, scope: null };
  routes = {
    connections: () =>
      json(200, {
        connections: [connA, connB],
        pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
      }),
    a: () => json(200, { plan: "pro" }),
    b: () => json(200, {}),
  };
  notify = { error: vi.fn(), info: vi.fn() };
  docListeners = {};
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  globalThis.document = {
    hidden: false,
    addEventListener: (t, fn) => {
      docListeners[t] = fn;
    },
    removeEventListener: (t) => {
      delete docListeners[t];
    },
  };
  globalThis.fetch = vi.fn(async (url) => route(url));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.window;
  delete globalThis.document;
});

const calls = (prefix) => fetch.mock.calls.filter(([u]) => u.startsWith(prefix)).length;

describe("useQuotaData", () => {
  it("loads connections, pagination and quota on mount", async () => {
    const r = await mount();
    expect(r.connections).toEqual([connA, connB]);
    expect(r.pagination.total).toBe(2);
    expect(r.connectionsLoading).toBe(false);
    expect(r.initialQuotaLoaded).toBe(true);
    expect(r.quotaData.a.plan).toBe("pro");
    expect(r.errors).toEqual({ a: null, b: null });
  });

  it("surfaces a failed connections response instead of an empty list", async () => {
    routes.connections = () => json(500, { error: "db down" });
    const r = await mount();
    expect(r.connectionsError).toMatch(/500/);
    expect(r.connectionsLoading).toBe(false);
    expect(r.initialQuotaLoaded).toBe(true);
    expect(calls("/api/usage/")).toBe(0);
  });

  it("does not swallow 401 or 404 quota responses", async () => {
    routes.a = () => json(401, { error: "token expired" });
    routes.b = () => json(404, { error: "gone" });
    const r = await mount();
    expect(r.errors.a).toMatch(/401.*token expired/);
    expect(r.errors.b).toMatch(/404.*gone/);
    expect(r.loading).toEqual({ a: false, b: false });
  });

  it("shows connection refresh failures with a retry action", async () => {
    const r = await mount();
    routes.connections = () => json(503, { error: "offline" });
    const summary = await r.refreshAll(true);
    expect(summary).toBeUndefined();
    expect(render().connectionsError).toMatch(/503.*offline/);
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
    routes.connections = () =>
      json(200, {
        connections: [connA],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      });
    await notify.error.mock.calls[0][1].action.onSelect();
    expect(render().connectionsError).toBeNull();
  });

  it("runs one refreshAll at a time", async () => {
    const r = await mount();
    const before = calls("/api/providers/client");
    const first = r.refreshAll(true);
    const second = r.refreshAll(true);
    await Promise.all([first, second]);
    expect(calls("/api/providers/client") - before).toBe(1);
    expect(render().refreshingAll).toBe(false);
  });

  it("summarizes refreshAll failures in one error toast with retry", async () => {
    const r = await mount();
    routes.b = () => json(500, { error: "upstream" });
    const summary = await r.refreshAll(true);
    expect(summary).toEqual({ total: 2, failed: 1 });
    expect(notify.error).toHaveBeenCalledTimes(1);
    const [message, options] = notify.error.mock.calls[0];
    expect(message).toMatch(/1 of 2/);
    expect(options.action.label).toBe("Retry");
    const before = calls("/api/providers/client");
    await options.action.onSelect();
    expect(calls("/api/providers/client") - before).toBe(1);
  });

  it("polls on one interval, exposes nextRefreshAt, pauses while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let r = await mount();
    expect(r.autoRefresh).toBe(true);
    r = render();
    expect(r.nextRefreshAt).toBe(Date.now() + REFRESH_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(1);

    const before = calls("/api/providers/client");
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    await flush();
    expect(calls("/api/providers/client") - before).toBe(1);
    expect(notify.error).not.toHaveBeenCalled();

    document.hidden = true;
    docListeners.visibilitychange();
    expect(vi.getTimerCount()).toBe(0);
    expect(render().nextRefreshAt).toBeNull();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 3);
    await flush();
    expect(calls("/api/providers/client") - before).toBe(1);

    document.hidden = false;
    docListeners.visibilitychange();
    expect(vi.getTimerCount()).toBe(1);
    expect(render().nextRefreshAt).toBe(Date.now() + REFRESH_INTERVAL_MS);
  });

  it("hydrates autoRefresh from storage and persists changes", async () => {
    window.localStorage.setItem("quotaAutoRefresh", "false");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let r = await mount();
    r = render();
    expect(r.autoRefresh).toBe(false);
    expect(r.nextRefreshAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    r.setAutoRefresh(true);
    render();
    expect(window.localStorage.getItem("quotaAutoRefresh")).toBe("true");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("syncs a clamped page back to the caller via setPage", async () => {
    routes.connections = () =>
      json(200, {
        connections: [connA],
        pagination: { page: 2, pageSize: 20, total: 30, totalPages: 2 },
      });
    const setPage = vi.fn();
    const r = await mount({ ...props(), page: 3, setPage });
    expect(r.pagination.page).toBe(2);
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("ignores stale connections responses", async () => {
    await mount();
    const first = json(200, {
      connections: [connA],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    const second = json(200, {
      connections: [connB],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    const pending = [];
    globalThis.fetch = vi.fn((url) => {
      if (url.startsWith("/api/providers/client")) {
        return new Promise((resolve) => pending.push(resolve));
      }
      return route(url);
    });
    const p1 = render().fetchConnections(1);
    const p2 = render().fetchConnections(1);
    pending[1](second);
    await expect(p2).resolves.toEqual([connB]);
    expect(render().connections).toEqual([connB]);
    pending[0](first);
    await expect(p1).resolves.toBeNull();
    expect(render().connections).toEqual([connB]);
  });

  it("keeps current data when a stale connections request fails", async () => {
    await mount();
    const late = json(200, {
      connections: [connA],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    let failFirst;
    let passSecond;
    let seen = 0;
    globalThis.fetch = vi.fn((url) => {
      if (!url.startsWith("/api/providers/client")) return route(url);
      seen += 1;
      if (seen === 1) return new Promise((_, reject) => (failFirst = reject));
      return new Promise((resolve) => (passSecond = resolve));
    });
    const p1 = render().fetchConnections(1);
    const p2 = render().fetchConnections(1);
    passSecond(late);
    await expect(p2).resolves.toEqual([connA]);
    failFirst(new Error("stale network"));
    await expect(p1).resolves.toBeNull();
    const latest = render();
    expect(latest.connections).toEqual([connA]);
    expect(latest.connectionsError).toBeNull();
  });

  it("keeps the newer quota and cache when an older request succeeds last", async () => {
    await mount();
    const pending = [];
    routes.a = () => new Promise((resolve) => pending.push(resolve));
    const first = render().fetchQuota("a", "codex");
    const second = render().fetchQuota("a", "codex", { force: true });
    expect(pending).toHaveLength(2);
    pending[1](json(200, { plan: "fresh" }));
    await expect(second).resolves.toBe(true);
    pending[0](json(200, { plan: "stale" }));
    await expect(first).resolves.toBeNull();
    const latest = render();
    expect(latest.quotaData.a.plan).toBe("fresh");
    expect(latest.loading.a).toBe(false);
    expect(latest.errors.a).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(QUOTA_CACHE_KEY)).a.plan).toBe("fresh");
  });

  it("ignores stale failures, including 401 cache writes, after a successful refresh", async () => {
    await mount();
    const pending = [];
    routes.a = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const first = render().fetchQuota("a", "codex");
    const second = render().fetchQuota("a", "codex", { force: true });
    pending[1].resolve(json(200, { plan: "fresh" }));
    await expect(second).resolves.toBe(true);
    pending[0].resolve(json(401, { error: "expired stale token" }));
    await expect(first).resolves.toBeNull();
    expect(render().quotaData.a.plan).toBe("fresh");
    expect(render().errors.a).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(QUOTA_CACHE_KEY)).a.plan).toBe("fresh");

    const third = render().fetchQuota("a", "codex");
    const fourth = render().fetchQuota("a", "codex");
    pending[3].resolve(json(200, { plan: "newer" }));
    await expect(fourth).resolves.toBe(true);
    pending[2].reject(new Error("stale network"));
    await expect(third).resolves.toBeNull();
    expect(render().quotaData.a.plan).toBe("newer");
    expect(render().errors.a).toBeNull();
  });

  it("lets refreshAll supersede in-flight initial quota loads without a false failure", async () => {
    const pending = [];
    routes.a = () => new Promise((resolve) => pending.push(resolve));
    render();
    await flush();
    expect(pending).toHaveLength(1);
    const refresh = render().refreshAll(true);
    await flush();
    expect(pending).toHaveLength(2);
    pending[1](json(200, { plan: "refresh" }));
    await flush();
    pending[0](json(500, { error: "old failure" }));
    expect(await refresh).toEqual({ total: 2, failed: 0 });
    await flush();
    const latest = render();
    expect(latest.quotaData.a.plan).toBe("refresh");
    expect(latest.errors.a).toBeNull();
    expect(latest.initialQuotaLoaded).toBe(true);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("drops a late quota settle for a deleted account", async () => {
    await mount();
    let resolveOld;
    routes.a = () => new Promise((resolve) => (resolveOld = resolve));
    const old = render().fetchQuota("a", "codex");
    render().invalidateQuota("a");
    routes.connections = () =>
      json(200, {
        connections: [connB],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      });
    await render().retryLoad();
    resolveOld(json(200, { plan: "deleted" }));
    await expect(old).resolves.toBeNull();
    const latest = render();
    expect(latest.connections).toEqual([connB]);
    expect(latest.quotaData.a).toBeUndefined();
    expect(latest.loading.a).toBeUndefined();
    expect(latest.errors.a).toBeUndefined();
  });

  it("ignores an old page's quota response after a page change", async () => {
    await mount();
    let resolveOld;
    routes.a = () => new Promise((resolve) => (resolveOld = resolve));
    const old = render().fetchQuota("a", "codex");
    routes.connections = () =>
      json(200, {
        connections: [connB],
        pagination: { page: 2, pageSize: 20, total: 21, totalPages: 2 },
      });
    await render({ ...props(), page: 2 }).retryLoad();
    resolveOld(json(200, { plan: "wrong page" }));
    await expect(old).resolves.toBeNull();
    const latest = render({ ...props(), page: 2 });
    expect(latest.connections).toEqual([connB]);
    expect(latest.quotaData.a).toBeUndefined();
  });

  it("retryLoad refetches the list and quota after a failure", async () => {
    routes.connections = () => json(500, { error: "db down" });
    await mount();
    expect(render().connectionsError).toMatch(/500/);
    routes.connections = () =>
      json(200, {
        connections: [connA],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      });
    await render().retryLoad();
    const latest = render();
    expect(latest.connectionsError).toBeNull();
    expect(latest.connections).toEqual([connA]);
    expect(latest.quotaData.a.plan).toBe("pro");
  });

  it("retryLoad swallows failures for the retry UI", async () => {
    await mount();
    routes.connections = () => json(500, { error: "offline" });
    await expect(render().retryLoad()).resolves.toBeUndefined();
    expect(render().connectionsError).toMatch(/500/);
  });

  it("passes force through to quota requests on force refresh", async () => {
    const r = await mount();
    fetch.mockClear();
    await r.refreshAll(true);
    const usageCalls = fetch.mock.calls.map(([u]) => u).filter((u) => u.startsWith("/api/usage/"));
    expect(usageCalls).toContain("/api/usage/a?force=1");
    expect(usageCalls).toContain("/api/usage/b?force=1");
    fetch.mockClear();
    await render().refreshAll();
    const pollCalls = fetch.mock.calls.map(([u]) => u).filter((u) => u.startsWith("/api/usage/"));
    expect(pollCalls).toContain("/api/usage/a");
    expect(pollCalls.every((u) => !u.includes("force"))).toBe(true);
  });

  it("keeps one interval across filter changes and polls with latest filters", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await mount();
    render();
    expect(vi.getTimerCount()).toBe(1);
    render({ ...props(), providerFilter: "codex" });
    expect(vi.getTimerCount()).toBe(1);
    fetch.mockClear();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    await flush();
    const listCalls = fetch.mock.calls
      .map(([u]) => u)
      .filter((u) => u.startsWith("/api/providers/client"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toContain("provider=codex");
  });

  it("appends workspaceId to the list query when scoped", async () => {
    scopeMock.value = { ready: true, scope: { workspaceId: "ws-1" } };
    await mount();
    const listCalls = fetch.mock.calls
      .map(([u]) => u)
      .filter((u) => u.startsWith("/api/providers/client"));
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((u) => u.includes("workspaceId=ws-1"))).toBe(true);
  });

  it("stays loading without fetching while the scope is not ready", async () => {
    scopeMock.value = { ready: false, scope: null };
    render();
    await flush();
    const latest = render();
    expect(latest.connections).toEqual([]);
    expect(latest.connectionsLoading).toBe(true);
    expect(latest.initialQuotaLoaded).toBe(false);
    expect(fetch.mock.calls.filter(([u]) => u.startsWith("/api/providers/client"))).toHaveLength(0);
  });
});
