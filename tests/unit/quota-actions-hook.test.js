import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same minimal hook runtime as quota-data-hook.test.js (no DOM renderer installed).
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

// YAN-749: single-user scope (switch off), so every settings call stays on /api/settings.
vi.mock("@/shared/hooks/useSettingsScope", () => ({
  useSettingsScope: () => ({ ready: true, scope: null, canManageInstance: true }),
}));

import {
  AUTO_PING_SETTINGS_KEYS,
  useQuotaActions,
} from "../../src/app/(dashboard)/dashboard/quota/hooks/useQuotaActions.js";

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: `status ${status}`,
  json: async () => body,
});

let routes;
let notify;
let store;
let fetchConnections;
let fetchQuota;
let invalidateQuota;
let retryLoad;

function route(url, init = {}) {
  const method = init.method || "GET";
  if (url.startsWith("/api/proxy-pools")) return json(200, { proxyPools: [] });
  if (url === "/api/settings") return routes.settings(method, init);
  const putMatch = url.match(/^\/api\/providers\/([^/?]+)$/);
  if (putMatch && (method === "PUT" || method === "DELETE")) {
    return (routes.providers[putMatch[1]] || routes.providers.__default)(method);
  }
  const creditsMatch = url.match(/^\/api\/usage\/([^/?]+)\/codex-reset-credits$/);
  if (creditsMatch) return (routes.credits[creditsMatch[1]] || (() => json(200, {})))(method);
  return json(200, {});
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function render() {
  rt.state.index = 0;
  rt.state.pending = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: test driver re-renders the hook against a mocked React runtime.
  const result = useQuotaActions({
    fetchConnections,
    fetchQuota,
    invalidateQuota,
    retryLoad,
    page: 1,
    quotaData: store.quotaData,
    setQuotaData: (v) => {
      store.quotaData = typeof v === "function" ? v(store.quotaData) : v;
    },
    setLoading: (v) => {
      store.loading = typeof v === "function" ? v(store.loading) : v;
    },
    setErrors: (v) => {
      store.errors = typeof v === "function" ? v(store.errors) : v;
    },
    notify,
  });
  for (const run of rt.state.pending) run();
  return result;
}

async function mount() {
  render();
  await flush();
  return render();
}

beforeEach(() => {
  rt.state.slots = [];
  store = {
    quotaData: { a: { quotas: [] } },
    loading: { a: false },
    errors: { a: null },
  };
  routes = {
    settings: () => json(200, {}),
    providers: { __default: () => json(200, {}) },
    credits: {},
  };
  notify = { error: vi.fn(), info: vi.fn() };
  fetchConnections = vi.fn(async () => []);
  retryLoad = vi.fn(async () => {
    await fetchConnections(1);
  });
  fetchQuota = vi.fn(async () => true);
  invalidateQuota = vi.fn();
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  };
  globalThis.fetch = vi.fn(async (url, init) => route(url, init));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.window;
});

describe("useQuotaActions", () => {
  it("clears per-id state and closes the delete dialog on success", async () => {
    let r = await mount();
    r.setDeleteConfirmState({ id: "a" });
    r = render();
    await r.handleDeleteConnection("a");
    r = render();
    expect(store.quotaData).toEqual({});
    expect(store.loading).toEqual({});
    expect(store.errors).toEqual({});
    expect(invalidateQuota).toHaveBeenCalledWith("a");
    expect(fetchConnections).toHaveBeenCalled();
    expect(r.deleteConfirmState).toBeNull();
    expect(r.deleteError).toBeNull();
    expect(r.deletingId).toBeNull();
  });

  it("keeps the delete dialog open with inline error + retry toast on HTTP failure", async () => {
    routes.providers = { __default: () => json(500, { error: "db down" }) };
    let r = await mount();
    r.setDeleteConfirmState({ id: "a" });
    r = render();
    await expect(r.handleDeleteConnection("a")).rejects.toThrow(/500.*db down/);
    r = render();
    expect(r.deleteConfirmState).toEqual({ id: "a" });
    expect(r.deleteError).toMatch(/500.*db down/);
    expect(store.quotaData).toEqual({ a: { quotas: [] } });
    expect(invalidateQuota).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
  });

  it("keeps the delete dialog open on network failure", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).startsWith("/api/providers/")) throw new Error("offline");
      return route(url, init);
    });
    let r = await mount();
    r.setDeleteConfirmState({ id: "a" });
    r = render();
    await expect(r.handleDeleteConnection("a")).rejects.toThrow("offline");
    r = render();
    expect(r.deleteConfirmState).toEqual({ id: "a" });
    expect(r.deleteError).toBe("offline");
  });

  it("toasts toggle failures with a retry action and releases the row", async () => {
    routes.providers = { __default: () => json(403, { error: "forbidden" }) };
    const r = await mount();
    await r.handleToggleConnectionActive("a", false);
    expect(fetchConnections).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][0]).toMatch(/disable/);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
    expect(render().togglingId).toBeNull();
  });

  it("reconciles the page after a successful toggle", async () => {
    const r = await mount();
    await r.handleToggleConnectionActive("a", true);
    expect(fetchConnections).toHaveBeenCalledWith(1);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("returns the server message and toasts on failed edit save", async () => {
    routes.providers = { __default: () => json(422, { error: "bad name" }) };
    let r = await mount();
    r.setSelectedConnection({ id: "a", provider: "codex" });
    r = render();
    const message = await r.handleUpdateConnection({ name: "x" });
    expect(message).toMatch(/422.*bad name/);
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1]).toBeUndefined();
    expect(fetchConnections).not.toHaveBeenCalled();
  });

  it("closes the edit modal and refetches quota on successful save", async () => {
    let r = await mount();
    r.setSelectedConnection({ id: "a", provider: "codex" });
    r.setShowEditModal(true);
    r = render();
    const message = await r.handleUpdateConnection({ name: "x" });
    expect(message).toBeNull();
    expect(fetchConnections).toHaveBeenCalled();
    expect(fetchQuota).toHaveBeenCalledWith("a", "codex");
    r = render();
    expect(r.showEditModal).toBe(false);
    expect(r.selectedConnection).toBeNull();
  });

  it("reverts auto-ping and toasts on settings PATCH failure", async () => {
    routes.settings = (method) =>
      method === "PATCH" ? json(500, { error: "nope" }) : json(200, {});
    let r = await mount();
    await r.toggleAutoPing("a", "codex", true);
    r = render();
    expect(r.autoPingMaps.codex.a).not.toBe(true);
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
  });

  it("stays open on failed Codex reset and toasts a retry", async () => {
    routes.credits = { a: () => json(400, { error: "no credits" }) };
    let r = await mount();
    r.setResetConfirmState({ connection: { id: "a", provider: "codex" }, count: 1 });
    r = render();
    await expect(r.handleResetCodexLimit("a", "codex")).rejects.toThrow("no credits");
    r = render();
    expect(r.resetConfirmState).not.toBeNull();
    expect(r.resettingLimitId).toBeNull();
    expect(store.errors.a).toMatch(/400.*no credits/);
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
  });

  it("closes the Codex reset dialog on success", async () => {
    routes.credits = { a: () => json(200, { ok: true }) };
    let r = await mount();
    r.setResetConfirmState({ connection: { id: "a", provider: "codex" }, count: 1 });
    r = render();
    await r.handleResetCodexLimit("a", "codex");
    expect(fetchQuota).toHaveBeenCalledWith("a", "codex");
    r = render();
    expect(r.resetConfirmState).toBeNull();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("sorts Codex reset credits and records load failures inline", async () => {
    routes.credits = {
      a: () =>
        json(200, {
          credits: [
            { id: "late", expiresAt: "2030-01-02T00:00:00Z" },
            { id: "early", expiresAt: "2030-01-01T00:00:00Z" },
          ],
        }),
    };
    let r = await mount();
    await r.handleViewCodexResetCredits({ id: "a", provider: "codex" });
    r = render();
    expect(r.resetCreditsState.data.credits.map((c) => c.id)).toEqual(["early", "late"]);

    routes.credits = { a: () => json(500, { error: "upstream" }) };
    await r.handleViewCodexResetCredits({ id: "a", provider: "codex" });
    r = render();
    expect(r.resetCreditsState.error).toMatch(/upstream/);
    expect(r.resetCreditsState.data).toBeNull();
  });

  it("reverts quota visibility and toasts on failure", async () => {
    routes.settings = (method) => {
      if (method === "GET") return json(200, { quotaVisibility: {} });
      return json(500, { error: "locked" });
    };
    const r = await mount();
    r.handleHideQuota("codex", { modelKey: "m", name: "n" });
    await flush();
    const next = render();
    expect(next.quotaVisibility).toEqual({});
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
  });

  it("reconciles successful writes and throws on partial bulk failure", async () => {
    routes.providers = {
      good: () => json(200, {}),
      bad: () => json(500, { error: "stuck" }),
      __default: () => json(200, {}),
    };
    const r = await mount();
    await expect(r.bulkSetActive(["good", "bad"], false)).rejects.toThrow(/1 of 2/);
    // "good" committed — the list must refresh even though "bad" failed.
    expect(fetchConnections).toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
    expect(render().bulkToggling).toBe(false);
  });

  it("skips the reconcile when every bulk target fails", async () => {
    routes.providers = {
      bad1: () => json(500, { error: "stuck" }),
      bad2: () => json(500, { error: "stuck" }),
      __default: () => json(200, {}),
    };
    const r = await mount();
    await expect(r.bulkSetActive(["bad1", "bad2"], false)).rejects.toThrow(/2 of 2/);
    expect(fetchConnections).not.toHaveBeenCalled();
    expect(render().bulkToggling).toBe(false);
  });

  it("closes the delete dialog on committed delete and routes refresh retry through retryLoad", async () => {
    fetchConnections.mockRejectedValueOnce(new Error("list down"));
    let r = await mount();
    r.setDeleteConfirmState({ id: "a" });
    r = render();
    await r.handleDeleteConnection("a");
    r = render();
    expect(r.deleteConfirmState).toBeNull();
    expect(store.quotaData).toEqual({});
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][0]).toMatch(/list refresh failed/);
    // The refresh-only retry must not re-run the DELETE.
    const providerDeletes = fetch.mock.calls.filter(
      ([url, init]) => url === "/api/providers/a" && init?.method === "DELETE",
    ).length;
    routes.providers = { __default: () => json(200, {}) };
    fetchConnections.mockResolvedValueOnce([]);
    await notify.error.mock.calls[0][1].action.onSelect();
    await flush();
    expect(retryLoad).toHaveBeenCalledOnce();
    expect(fetchConnections).toHaveBeenCalled();
    expect(
      fetch.mock.calls.filter(
        ([url, init]) => url === "/api/providers/a" && init?.method === "DELETE",
      ).length,
    ).toBe(providerDeletes);
  });

  it("clears stale delete errors via clearDeleteError", async () => {
    routes.providers = { __default: () => json(500, { error: "db down" }) };
    let r = await mount();
    r.setDeleteConfirmState({ id: "a" });
    r = render();
    await expect(r.handleDeleteConnection("a")).rejects.toThrow("db down");
    r = render();
    expect(r.deleteError).toMatch(/db down/);
    r.clearDeleteError();
    r = render();
    expect(r.deleteError).toBeNull();
    // Deleting a different connection resets the inline error first.
    routes.providers = { __default: () => json(200, {}) };
    await r.handleDeleteConnection("a");
    expect(render().deleteError).toBeNull();
  });

  it("treats rejected provider promises as failed, not silent", async () => {
    routes.providers = {
      good: () => json(200, {}),
      boom: () => {
        throw new Error("offline");
      },
      __default: () => json(200, {}),
    };
    const r = await mount();
    await expect(r.bulkSetActive(["good", "boom"], false)).rejects.toThrow(/1 of 2/);
    expect(fetchConnections).toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(render().bulkToggling).toBe(false);
  });

  it("shares one AUTO_PING_SETTINGS_KEYS map with the page", () => {
    expect(AUTO_PING_SETTINGS_KEYS).toEqual({ claude: "claudeAutoPing", codex: "codexAutoPing" });
  });

  it("toasts settings load failures with retry", async () => {
    routes.settings = () => json(500, { error: "settings down" });
    await mount();
    expect(notify.error).toHaveBeenCalled();
    expect(notify.error.mock.calls[0][0]).toMatch(/settings/);
    expect(notify.error.mock.calls[0][1].action.label).toBe("Retry");
  });
});
