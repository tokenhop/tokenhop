// YAN-769: MITM page must not fetch host-only routes or mount the MITM
// server card for members, and must hold a skeleton until auth resolves.
// Executes MitmPageClient as a plain function against the mocked hook
// runtime (JSX is compiled by next-swc first); fetch calls are the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "next/dist/build/swc";
import { readFileSync } from "node:fs";
import * as keyApi from "../../src/app/(dashboard)/dashboard/endpoint/hooks/keyApi.js";

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
// Pristine single-user auth status: the key context resolves to legacy
// locally, so only the bare legacy key list is requested.
const LEGACY_AUTH = { authenticated: true, requireLogin: true, hasPassword: true };
const authMock = vi.hoisted(() => ({ value: {} }));
vi.mock("@/shared/hooks/useSettingsScope", () => ({
  useSettingsScope: () => scopeMock.value,
}));

const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/mitm/MitmPageClient.js", import.meta.url),
  "utf8",
);
const compiled = transformSync(source, {
  filename: "MitmPageClient.js",
  jsc: {
    parser: { syntax: "ecmascript", jsx: true },
    transform: { react: { runtime: "automatic" } },
  },
  module: { type: "commonjs" },
});
// Evaluate the real component, substituting presentational children only.
const jsx = (type, props) => ({ type, props });
const notify = { error: vi.fn() };
const dependencies = {
  react: rt.hooks,
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@/shared/hooks/useSettingsScope": { useSettingsScope: () => scopeMock.value },
  "@/shared/hooks/useAuthStatus": {
    useAuthStatusState: () => ({ loaded: true, status: authMock.value }),
  },
  "@/app/(dashboard)/dashboard/endpoint/hooks/keyApi": keyApi,
  "@/shared/components": { Callout: "Callout", CardSkeleton: "CardSkeleton" },
  "@/shared/constants/cliTools": { MITM_TOOLS: { tool: { id: "tool" } } },
  "@/shared/constants/models": { getModelsByProviderId: () => [] },
  "@/shared/constants/providers": {},
  "@/app/(dashboard)/dashboard/cli-tools/components": {
    MitmServerCard: "MitmServerCard",
    MitmToolCard: "MitmToolCard",
    MitmRemoteSteps: "MitmRemoteSteps",
  },
  "@/store/notificationStore": { useNotificationStore: { getState: () => notify } },
  "@/store/cliAccessStore": { useCliAccessStore: (select) => select({ localOnly: false }) },
};
const exports = {};
new Function("require", "exports", compiled.code)((name) => {
  if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
  return dependencies[name];
}, exports);
const MitmPageClient = exports.default;

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
const LOADING = { ready: false, scope: null, canManageInstance: true, canHostOps: true };
const SWITCH_OFF = { ready: true, scope: null, canManageInstance: true, canHostOps: true };

const json = (body) => ({ ok: true, status: 200, json: async () => body });
let fetchMock;
const urls = () => fetchMock.mock.calls.map(([u]) => u);

function render() {
  rt.state.index = 0;
  rt.state.pending = [];
  const view = MitmPageClient();
  for (const run of rt.state.pending) run();
  return view;
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
/** Nodes a member must not see / that own host routes. */
const nodeText = (node) =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(nodeText).join(" ")
      : node?.props?.children
        ? nodeText(node.props.children)
        : "";
const nodeTitle = (node) =>
  Array.isArray(node)
    ? node.map(nodeTitle).join(" ")
    : node?.props?.title
      ? `${node.props.title} ${nodeText(node.props.children)}`
      : node?.props?.children
        ? nodeTitle(node.props.children)
        : "";

beforeEach(() => {
  rt.state.slots = [];
  scopeMock.value = ADMIN;
  authMock.value = LEGACY_AUTH;
  fetchMock = vi.fn(async (url) => json(url === "/api/keys" ? { keys: [] } : {}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MitmPageClient capability gate", () => {
  it("never starts the key list from a context started before an identity change", async () => {
    let resolveContext;
    authMock.value = {
      authenticated: true,
      userSecurityEnforced: true,
      multiUserActive: true,
      principal: { user: { id: "a" }, role: "owner", activeWorkspaceId: "w1" },
    };
    fetchMock.mockImplementation((url) =>
      url.startsWith("/api/keys/context")
        ? new Promise((resolve) => {
            resolveContext = resolve;
          })
        : Promise.resolve(json({ keys: [{ id: "b" }] })),
    );
    render();
    await flush();
    authMock.value = {
      ...authMock.value,
      principal: { user: { id: "b" }, role: "owner", activeWorkspaceId: "w2" },
    };
    render();
    scopeMock.value = MEMBER;
    render();
    resolveContext(
      json({ storage: "hashed", workspaceId: "w1", canCreate: true, canManage: true }),
    );
    await flush();
    expect(urls()).not.toContain("/api/keys?workspaceId=w1");
  });
  it("hostOps without settings.manage skips the instance settings GET", async () => {
    scopeMock.value = { ...ADMIN, canManageInstance: false };
    render();
    await flush();
    expect(urls().sort()).toEqual(["/api/keys", "/api/models/alias", "/api/providers"]);
    const server = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(server.props.cloudEnabled).toBe(false); // no 403, no cloud flag
  });

  it("owner/admin fetches providers, keys, aliases and settings", async () => {
    render();
    await flush();
    expect(urls().sort()).toEqual([
      "/api/keys",
      "/api/models/alias",
      "/api/providers",
      "/api/settings",
    ]);
  });

  it("switch off (single user) keeps the legacy fetches", async () => {
    scopeMock.value = SWITCH_OFF;
    render();
    await flush();
    expect(urls()).toContain("/api/settings");
  });

  it("member: skeleton while auth is unresolved, then an admin-only notice, never a fetch", async () => {
    scopeMock.value = LOADING;
    let view = render();
    expect(view.props["aria-busy"]).toBe("true");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    scopeMock.value = MEMBER;
    view = render();
    await flush();
    render(); // member effect cleanup + no new loads
    expect(fetchMock).not.toHaveBeenCalled();
    const text = nodeTitle(view);
    expect(text).toContain("MITM setup is for instance admins");
    expect(text).not.toContain("Set up from a remote dashboard");
  });

  it("member view never mounts the host server card (source-level pin)", () => {
    const gate = source.indexOf("if (!canHostOps)");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(source.indexOf("<MitmServerCard"));
    expect(gate).toBeLessThan(source.indexOf("<MitmToolCard"));
  });

  it("discards in-flight data after revoke, including across re-grant", async () => {
    const pending = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    render();
    scopeMock.value = MEMBER;
    render();
    scopeMock.value = ADMIN;
    render();
    for (const resolve of pending.slice(0, 4))
      resolve(json({ keys: [{ key: "stale-secret" }], cloudEnabled: true }));
    await flush();
    const view = render();
    const server = view.props.children.find((node) => node?.type === "MitmServerCard");
    expect(server.props.apiKeys).toEqual([]);
    expect(server.props.cloudEnabled).toBe(false);
  });

  it("hashed storage lists keys scoped to the active workspace, never bare /api/keys", async () => {
    authMock.value = {
      authenticated: true,
      userSecurityEnforced: true,
      multiUserActive: true,
      principal: { user: { id: "o" }, role: "owner", activeWorkspaceId: "w 1" },
    };
    fetchMock.mockImplementation(async (url) =>
      json(
        url.startsWith("/api/keys/context")
          ? { storage: "hashed", workspaceId: "w 1", canCreate: true, canManage: true }
          : url.startsWith("/api/keys")
            ? { storage: "hashed", keys: [{ id: "k", prefix: "th_ab…cd" }] }
            : {},
      ),
    );
    render();
    await flush();
    expect(urls()).toContain("/api/keys/context?workspaceId=w%201");
    expect(urls()).toContain("/api/keys?workspaceId=w%201");
    expect(urls()).not.toContain("/api/keys");
    const server = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(server.props.apiKeys).toEqual([{ id: "k", prefix: "th_ab…cd" }]);
  });

  it("drops a key list that resolves after the identity changed", async () => {
    let resolveList;
    authMock.value = LEGACY_AUTH;
    fetchMock.mockImplementation((url) =>
      url === "/api/keys"
        ? new Promise((resolve) => {
            resolveList = resolve;
          })
        : Promise.resolve(json({})),
    );
    render();
    await flush();
    authMock.value = { ...LEGACY_AUTH, hasPassword: false };
    fetchMock.mockImplementation(async (url) =>
      json(url === "/api/keys" ? { keys: [{ id: "new" }] } : {}),
    );
    render();
    await flush();
    resolveList(json({ keys: [{ id: "old", key: "stale-secret" }] }));
    await flush();
    const server = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(server.props.apiKeys).toEqual([{ id: "new" }]);
  });

  it("does not render the previous identity's keys during an identity transition", async () => {
    authMock.value = LEGACY_AUTH;
    fetchMock.mockImplementation(async (url) =>
      json(url === "/api/keys" ? { keys: [{ id: "old", key: "sk-old" }] } : {}),
    );
    render();
    await flush();
    const loaded = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(loaded.props.apiKeys).toEqual([{ id: "old", key: "sk-old" }]);
    authMock.value = { ...LEGACY_AUTH, hasPassword: false };
    fetchMock.mockImplementation(async (url) =>
      json(url === "/api/keys" ? { keys: [{ id: "new", key: "sk-new" }] } : {}),
    );
    const during = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(during.props.apiKeys).toEqual([]);
    await flush();
    const after = render().props.children.find((node) => node?.type === "MitmServerCard");
    expect(after.props.apiKeys).toEqual([{ id: "new", key: "sk-new" }]);
  });
});
