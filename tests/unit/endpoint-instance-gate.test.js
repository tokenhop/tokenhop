// YAN-769: Endpoint remote-access hook must not call instance/host routes
// (/api/settings, /api/tunnel/status) for members or before auth resolves,
// while switch-off and owner/admin keep the exact same calls. Runs the real
// useTunnelControls (+ transport hooks) on a minimal hook runtime: no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

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

const scopeMock = vi.hoisted(() => ({ value: {} }));
vi.mock("@/shared/hooks/useSettingsScope", () => ({
  useSettingsScope: () => scopeMock.value,
}));

import { useTunnelControls } from "../../src/app/(dashboard)/dashboard/endpoint/hooks/useTunnelControls.js";

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const SETTINGS = { requireApiKey: true, requireLogin: true, hasPassword: true };
const STATUS = {
  tunnel: { enabled: true, tunnelUrl: "https://t.example", publicUrl: "https://p.example" },
  tailscale: { enabled: false },
};

const ADMIN = {
  ready: true,
  scope: { workspaceId: "w" },
  canManageInstance: true,
  canHostOps: true,
};
const MEMBER = {
  ready: true,
  scope: { workspaceId: "w" },
  canManageInstance: false,
  canHostOps: false,
};
const LOADING = { ready: false, scope: null, canManageInstance: true, canHostOps: true }; // unresolved auth
const SWITCH_OFF = { ready: true, scope: null, canManageInstance: true, canHostOps: true };
// Hypothetical settings capability without hostOps: settings load
// stays, every tunnel call/poll is suppressed.
const SETTINGS_ONLY = {
  ready: true,
  scope: { workspaceId: "w" },
  canManageInstance: true,
  canHostOps: false,
};

let fetchMock;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function render() {
  rt.state.index = 0;
  rt.state.pending = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: test driver re-renders the hook against a mocked React runtime.
  const result = useTunnelControls();
  for (const run of rt.state.pending) run();
  return result;
}
const urls = () => fetchMock.mock.calls.map(([u]) => u).filter((u) => u.startsWith("/api/"));

beforeEach(() => {
  rt.state.slots = [];
  scopeMock.value = ADMIN;
  fetchMock = vi.fn(async (url) => (url === "/api/settings" ? json(SETTINGS) : json(STATUS)));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const slot of rt.state.slots) slot.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTunnelControls capability gate", () => {
  it("owner/admin loads settings + tunnel status once", async () => {
    render();
    await flush();
    const r = render();
    expect(urls().sort()).toEqual(["/api/settings", "/api/tunnel/status"]);
    expect(r.canManage).toBe(true);
    expect(r.canHost).toBe(true);
    expect(r.requireApiKey).toBe(true);
    expect(r.tunnelEnabled).toBe(true);
    expect(r.tunnelChecking).toBe(false);
  });

  it("switch off (single user) keeps the legacy calls", async () => {
    scopeMock.value = SWITCH_OFF;
    render();
    await flush();
    const r = render();
    expect(urls().sort()).toEqual(["/api/settings", "/api/tunnel/status"]);
    expect(r.canManage).toBe(true);
    await r.handleRequireApiKey(false);
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch[0]).toBe("/api/settings");
    expect(JSON.parse(patch[1].body)).toEqual({ requireApiKey: false });
    expect(render().requireApiKey).toBe(false);
  });

  it("member never calls settings or tunnel status, and PATCH is a no-op", async () => {
    scopeMock.value = MEMBER;
    render();
    await flush();
    const r = render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.canManage).toBe(false);
    expect(r.tunnelChecking).toBe(false); // no endless skeleton
    await r.handleRequireApiKey(true);
    await r.handleRequireLogin(false);
    await r.handleTunnelDashboardAccess(true);
    await r.handleEnableTunnel();
    await r.handleDisableTunnel();
    await r.handleConnectTailscale();
    await r.checkTailscaleInstalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render().requireApiKey).toBe(false);
  });

  it("calls nothing while auth is unresolved, then loads once it resolves as admin", async () => {
    scopeMock.value = LOADING;
    render();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render().canManage).toBe(false);
    scopeMock.value = ADMIN;
    render();
    await flush();
    expect(urls().sort()).toEqual(["/api/settings", "/api/tunnel/status"]);
    expect(render().canManage).toBe(true);
  });

  it("unresolved auth that resolves as member never calls anything", async () => {
    scopeMock.value = LOADING;
    render();
    scopeMock.value = MEMBER;
    render();
    await flush();
    render();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settings.manage without hostOps loads settings but never touches tunnel routes", async () => {
    scopeMock.value = SETTINGS_ONLY;
    render();
    await flush();
    let r = render();
    expect(urls()).toEqual(["/api/settings"]);
    expect(r.canManage).toBe(true);
    expect(r.canHost).toBe(false);
    expect(r.requireApiKey).toBe(true);
    expect(r.tunnelEnabled).toBe(false);
    await r.handleRequireApiKey(false);
    expect(render().requireApiKey).toBe(false); // PATCH still allowed
    await r.handleEnableTunnel();
    await r.handleConnectTailscale();
    r = render();
    expect(urls().filter((u) => u.startsWith("/api/tunnel"))).toEqual([]);
    expect(r.tunnelChecking).toBe(false);
  });

  it("drops a load that finishes after access was revoked", async () => {
    const pending = [];
    fetchMock.mockImplementation(
      (url) =>
        new Promise((resolve) =>
          pending.push(() => resolve(url === "/api/settings" ? json(SETTINGS) : json(STATUS))),
        ),
    );
    render();
    await flush();
    expect(pending).toHaveLength(2);
    scopeMock.value = MEMBER; // role change mid-flight
    render();
    for (const done of pending) done();
    await flush();
    const r = render();
    expect(r.requireApiKey).toBe(false);
    expect(r.tunnelEnabled).toBe(false);
    expect(r.tunnelUrl).toBe("");
  });

  it("a tailscale login-poll loop stops mid-loop when access is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval"] });
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/settings") return json(SETTINGS);
      if (url === "/api/tunnel/tailscale-check") return json({ loggedIn: false });
      if (url === "/api/tunnel/tailscale-enable")
        return json({ needsLogin: true, authUrl: "https://auth.example" });
      return json(STATUS);
    });
    render();
    await flush();
    const r = render();
    const connect = r.handleConnectTailscale();
    await flush();
    expect(urls()).toContain("/api/tunnel/tailscale-enable");
    expect(render().tsAuthUrl).toBe("https://auth.example");
    scopeMock.value = MEMBER; // role change mid-poll
    render();
    await vi.advanceTimersByTimeAsync(3000);
    await connect;
    expect(urls()).not.toContain("/api/tunnel/tailscale-check");
    const after = urls().filter((u) => u.startsWith("/api/tunnel")).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(urls().filter((u) => u.startsWith("/api/tunnel")).length).toBe(after);
    expect(render().tsAuthUrl).toBe("");
  });

  it("clears stale permission states after polls resolve", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render();
    await flush();
    render(); // tunnel enabled but unreachable -> degraded poll armed
    const before = fetchMock.mock.calls.length;
    scopeMock.value = MEMBER;
    render();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe("page wiring", () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const ep = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");

  it("Endpoint hides instance-only controls for members", () => {
    expect(ep).toContain("showRemote={tunnel.canHost}");
    expect(ep).toContain("showRequireApiKey={tunnel.canManage}");
    expect(ep).toMatch(/\{tunnel\.canManage && \(\s*<div className="min-w-0">\s*<AccessCard/);
  });

  it("MITM gates on ready + canHostOps before mounting host cards or fetching", () => {
    const mitm = read("src/app/(dashboard)/dashboard/mitm/MitmPageClient.js");
    expect(mitm).toContain("if (!allowed) return undefined;");
    const gate = mitm.indexOf("if (!canHostOps)");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(mitm.indexOf("<MitmServerCard"));
    expect(mitm.indexOf("if (!ready)")).toBeLessThan(gate);
  });
});
