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

import { useQuotaData } from "../../src/app/(dashboard)/dashboard/quota/hooks/useQuotaData.js";
import { REFRESH_INTERVAL_MS } from "../../src/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";

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
});
