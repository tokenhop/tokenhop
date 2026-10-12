// YAN-374: members (no instance.hostOps) get an export-only CLI Tools page —
// nav visible, no host-only fetches, export wording, "Create my key". With the
// multi-user switch off every label and fetch stays exactly as before.
// Style follows mitm-instance-gate.test.js: source-level pins plus a plain
// function render of CLIToolsPageClient with fetch calls as the contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "next/dist/build/swc";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const cliRoot = resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/cli-tools");
const readSrc = (file) => readFileSync(resolve(cliRoot, file), "utf8");

describe("navigation: CLI tools visible to members (YAN-374)", () => {
  it("the cli-tools nav item carries no hostOps capability cap", () => {
    const nav = readFileSync(
      resolve(import.meta.dirname, "../../src/shared/constants/navigation.js"),
      "utf8",
    );
    const start = nav.indexOf('id: "cli-tools"');
    const item = nav.slice(start);
    const next = item.slice(0, item.indexOf("},"));
    expect(next).not.toContain("cap:");
    expect(next).toContain('label: "CLI tools"');
  });

  it("visibleGroups includes cli-tools for a member can()", async () => {
    const { visibleGroups } = await import("../../src/shared/constants/navigation.js");
    // Member: workspace-level capabilities, no instance.* capabilities.
    const can = (cap) => cap.startsWith("workspace.");
    const hrefs = visibleGroups({ multiUser: true, can })
      .flatMap((g) => g.items)
      .map((i) => i.href);
    expect(hrefs).toContain("/dashboard/cli-tools");
    // Host-only pages stay hidden from members.
    expect(hrefs).not.toContain("/dashboard/mitm");
  });

  it("visibleGroups is unchanged when every capability is granted (host)", async () => {
    const { visibleGroups } = await import("../../src/shared/constants/navigation.js");
    const hrefs = visibleGroups({ can: () => true })
      .flatMap((g) => g.items)
      .map((i) => i.href);
    expect(hrefs).toContain("/dashboard/cli-tools");
  });
});

describe("CLIToolsPageClient host-only fetch gating", () => {
  const source = readFileSync(resolve(cliRoot, "CLIToolsPageClient.js"), "utf8");
  const compiled = transformSync(source, {
    filename: "CLIToolsPageClient.js",
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "commonjs" },
  });
  const jsx = (type, props) => ({ type, props });
  const toolData = {
    value: {
      loading: false,
      ready: true,
      canHostOps: true,
      activeProviders: [],
      apiKeys: [],
      modelAliases: {},
      hasActiveProviders: false,
    },
  };
  const dependencies = {
    react: rt.hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol.for("test.fragment") },
    "@/shared/components": {
      CardSkeleton: "CardSkeleton",
      EmptyState: "EmptyState",
      SegmentedControl: "SegmentedControl",
      ToolbarSearch: "ToolbarSearch",
    },
    "next/navigation": { useRouter: () => ({ replace() {} }) },
    "./hooks/useToolSetupData": { useToolSetupData: () => toolData.value },
    "./lib/toolStatus": {
      countToolsByFilter: () => ({}),
      filterToolEntries: () => [],
      deriveToolStatus: () => null,
    },
    "./components/ToolGridCard": { default: "ToolGridCard" },
    "./components/InterceptTools": { default: "InterceptTools" },
    "./components/ToolSetupPanel": { default: "ToolSetupPanel" },
    "./components/LocalOnlyNotice": { default: "LocalOnlyNotice" },
    "@/shared/constants/cliTools": {
      CLI_TOOLS: { demo: { id: "demo", name: "Demo" } },
      MITM_TOOLS: {},
    },
    "@/shared/utils/localOnly": { isLocalOnlyResponse: async () => false },
    "@/store/cliAccessStore": {
      useCliAccessStore: Object.assign((select) => select({ localOnly: false, noHost: false }), {
        getState: () => ({ localOnly: false, noHost: false }),
      }),
      markLocalOnly: () => {},
    },
  };
  const exports = {};
  new Function("require", "exports", compiled.code)((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
    return dependencies[name];
  }, exports);
  const CLIToolsPageClient = exports.default;

  let fetchMock;
  const urls = () => fetchMock.mock.calls.map(([u]) => u);
  const render = () => {
    rt.state.index = 0;
    rt.state.pending = [];
    const view = CLIToolsPageClient({});
    for (const run of rt.state.pending) run();
    return view;
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    rt.state.slots = [];
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("host-capable principal fetches all-statuses once auth is ready", async () => {
    toolData.value = { ...toolData.value, ready: true, canHostOps: true };
    render();
    await flush();
    expect(urls()).toContain("/api/cli-tools/all-statuses");
  });

  it("member (canHostOps false) never fetches all-statuses", async () => {
    toolData.value = { ...toolData.value, ready: true, canHostOps: false };
    render();
    await flush();
    expect(urls()).not.toContain("/api/cli-tools/all-statuses");
  });

  // Statuses reach CLIToolsView as a prop; walk the element tree for it.
  const statusesOf = (node) => {
    if (!node || typeof node !== "object") return undefined;
    if (node.props && "statuses" in node.props && "remote" in node.props) {
      return node.props.statuses;
    }
    const kids = node.props?.children;
    for (const child of Array.isArray(kids) ? kids : [kids]) {
      const found = statusesOf(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  it("host -> member flip clears host install data and discards an in-flight response", async () => {
    const hostPayload = { claude: { installed: true, hasTokenhop: true } };
    let releaseSlow;
    fetchMock.mockImplementation(
      (url) =>
        new Promise((resolve) => {
          if (url !== "/api/cli-tools/all-statuses")
            return resolve({ ok: true, json: async () => ({}) });
          releaseSlow = () => resolve({ ok: true, status: 200, json: async () => hostPayload });
        }),
    );
    // 1) host: load completes, host detection data is shown.
    toolData.value = { ...toolData.value, ready: true, canHostOps: true };
    render();
    releaseSlow();
    await flush();
    expect(statusesOf(render())).toEqual(hostPayload);
    // 2) role flips to member: statuses and error state are dropped at once.
    toolData.value = { ...toolData.value, ready: true, canHostOps: false };
    render();
    await flush();
    expect(statusesOf(render())).toEqual({});
    // 3) a new host-era request that is still in flight must not resurrect data.
    toolData.value = { ...toolData.value, ready: true, canHostOps: true };
    render();
    toolData.value = { ...toolData.value, ready: true, canHostOps: false };
    render();
    releaseSlow();
    await flush();
    expect(statusesOf(render())).toEqual({});
  });

  it("host -> member flip also clears a stale detection error", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/cli-tools/all-statuses")
        return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });
    toolData.value = { ...toolData.value, ready: true, canHostOps: true };
    render();
    await flush();
    const failed = render();
    expect(JSON.stringify(failed, (_k, v) => (typeof v === "symbol" ? String(v) : v))).toContain(
      '"statusesError":true',
    );
    toolData.value = { ...toolData.value, ready: true, canHostOps: false };
    render();
    await flush();
    expect(JSON.stringify(render(), (_k, v) => (typeof v === "symbol" ? String(v) : v))).toContain(
      '"statusesError":false',
    );
  });

  it("waits for auth: no all-statuses fetch before the scope is ready", async () => {
    toolData.value = { ...toolData.value, ready: false, canHostOps: false };
    render();
    await flush();
    expect(urls()).not.toContain("/api/cli-tools/all-statuses");
    toolData.value = { ...toolData.value, ready: true, canHostOps: true };
    render();
    await flush();
    expect(urls()).toContain("/api/cli-tools/all-statuses");
  });
});

describe("useToolSetupData skips host-only fetches for members", () => {
  const hook = readSrc("hooks/useToolSetupData.js");

  it("gates tunnel status, providers and aliases on canHostOps", () => {
    expect(hook).toContain("const skipHost = ready && !canHostOps;");
    expect(hook).toMatch(/skipHost \? null : fetch\("\/api\/providers"\)/);
    expect(hook).toMatch(/skipHost \? null : fetch\("\/api\/tunnel\/status"\)/);
    expect(hook).toMatch(
      /skipHost \? null : fetch\(withWorkspace\("\/api\/models\/alias", scope\?\.workspaceId\)\)/,
    );
  });

  it("falls back to window.location.origin without a tunnel call", () => {
    expect(hook).toContain('if (typeof window !== "undefined") return window.location.origin;');
    const fallback = hook.indexOf("window.location.origin");
    expect(fallback).toBeGreaterThan(0);
    // The tunnel branch only fires from fetched state (skipped for members).
    expect(hook.slice(0, fallback)).not.toContain('fetch("/api/tunnel/status").then');
  });

  it("marks export-only mode once the scope resolves", () => {
    expect(hook).toContain("useCliScope()");
    expect(readSrc("hooks/useCliScope.js")).toContain(
      "syncCliIdentity(identity, !scope.canHostOps)",
    );
  });

  it("members export without provider data (hasActiveProviders never blocks them)", () => {
    expect(hook).toContain("availableModels.length > 0 || (ready && !canHostOps)");
  });
});

describe("export-only wording and persistence seams", () => {
  it("SetupScaffold keeps off-switch labels, maps them only when multi-user is active", () => {
    const s = readSrc("components/SetupScaffold.js");
    expect(s).toContain(
      'multiUser && applyLabel === "Apply" ? "Apply on this machine" : applyLabel',
    );
    expect(s).toContain('multiUser ? "Copy config" : "Set up manually"');
    expect(s).toContain('multiUser ? "Copy config" : "Manual config"');
  });

  it("member notice explains the export flow without remote-dashboard wording", () => {
    const s = readSrc("components/LocalOnlyNotice.js");
    expect(s).toContain("Copy config for your machine");
    expect(s).toContain("Only an owner or admin can apply settings directly on the host.");
  });

  it("setupCard skips the member-403 alias fetch (noHost gate before fetch)", () => {
    const s = readSrc("components/setupCard.js");
    expect(s).toMatch(
      /useCliAccessStore\.getState\(\)\.noHost \? Promise\.resolve\(null\) : fetch/,
    );
  });

  it("intercept section waits for auth and never fetches the host route for members", () => {
    const s = readSrc("components/InterceptTools.js");
    expect(s).toContain("useSettingsScope");
    expect(s).toMatch(/if \(!ready\) return;/);
    expect(s).toContain("if (!canHostOps || useCliAccessStore.getState().localOnly) {");
    const gate = s.indexOf("if (!canHostOps");
    expect(gate).toBeLessThan(s.indexOf('fetch("/api/cli-tools/antigravity-mitm"'));
  });

  it("MITM card skips its mount fetch for members", () => {
    const s = readSrc("components/MitmToolCard.js");
    expect(s).toMatch(/if \(isExpanded && !noHost\) loadSavedMappings\(\)/);
  });

  it("tool settings skip /api/cli-tool-settings for members (memory only)", () => {
    const s = readFileSync(
      resolve(import.meta.dirname, "../../src/store/toolSettingsStore.js"),
      "utf8",
    );
    expect(s).toContain("const noHost = () => useCliAccessStore.getState().noHost;");
    const loadGate = s.indexOf("if (noHost())");
    expect(loadGate).toBeGreaterThan(-1);
    expect(loadGate).toBeLessThan(s.indexOf('fetch("/api/cli-tool-settings")'));
  });

  it("endpoint/key presets skip /api/cli-tool-presets for members (memory only)", () => {
    const s = readSrc("components/cliEndpointPresets.js");
    expect(s).toContain("const noHost = () => useCliAccessStore.getState().noHost;");
    expect(s).toContain('typeof window === "undefined" || noHost()');
    expect(s).toMatch(/setStoreItems\(store, items\);\n {4}if \(noHost\(\)\) return;/);
  });
});

describe("member key creation (YAN-374)", () => {
  const s = readSrc("components/ApiKeySelect.js");

  const create = readSrc("components/createMemberKey.js");

  it("posts a user-typed key scoped to the active workspace", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ key: "th_raw", id: "k1", storage: "hashed" }) };
    });
    const { createMemberKey } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/createMemberKey.js"
    );
    await expect(createMemberKey("ws 1")).resolves.toBe("th_raw");
    expect(calls[0].url).toBe("/api/keys?workspaceId=ws%201");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ type: "user" });
    vi.unstubAllGlobals();
  });

  it.each([
    ["missing key", { id: "k1", plain: "th_legacy" }],
    ["non-string key", { key: { raw: "x" } }],
    ["empty key", { key: "" }],
  ])("rejects a response with %s (no `plain` fallback)", async (_label, body) => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => body }));
    const { createMemberKey } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/createMemberKey.js"
    );
    await expect(createMemberKey("w")).rejects.toThrow("did not return a key");
    vi.unstubAllGlobals();
  });

  it("surfaces the server error on a failed create", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({ error: "nope" }) }));
    const { createMemberKey } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/createMemberKey.js"
    );
    await expect(createMemberKey("w")).rejects.toThrow("nope");
    vi.unstubAllGlobals();
  });

  it("has no plain fallback in source", () => {
    expect(create).not.toContain("plain");
  });

  it("feeds the raw key into onChange only — never into persisted fields or presets", () => {
    const create = s.slice(s.indexOf("const createKey = async"), s.indexOf("const refPresets"));
    expect(create).toContain("onChange(raw)");
    expect(create).not.toContain("upsertKeyPreset(");
    expect(create).not.toContain("setFields(");
    // Raw keys stay out of persistence even outside the create path:
    // apiKeyPatch returns null for unknown raws and upsertKeyPreset refuses them.
  });

  it("announces the one-time raw key via an aria-live region", () => {
    expect(s).toContain("Create my key");
    expect(s).toMatch(/aria-live="polite"[\s\S]*?isn't saved\./);
  });

  it("members are never offered host-stored credential reuse", () => {
    expect(s).toContain("pasteOnly");
    expect(s).toContain(
      'MEMBER_SOURCE_OPTIONS = [{ value: "new", label: "Paste or create a key" }]',
    );
    expect(s).toContain("options={pasteOnly ? MEMBER_SOURCE_OPTIONS : SOURCE_OPTIONS}");
  });
});

describe("switch off: labels and fetches unchanged", () => {
  it("LocalOnlyNotice member branch is opt-in only", () => {
    const s = readSrc("components/LocalOnlyNotice.js");
    expect(s).toContain("if (member)");
    expect(s).toContain('title="CLI tools require local access"');
  });

  it("SetupScaffold defaults resolve to the legacy labels without multi-user", () => {
    const s = readSrc("components/SetupScaffold.js");
    expect(s).toContain("useMultiUserActive");
    // off-path: applyText/exportText/manualText fall back to the exact props/defaults.
    expect(s).toContain(": applyLabel;");
    expect(s).toContain('"Set up manually"');
    expect(s).toContain('"Manual config"');
  });

  it("remote localOnly survives promotion from noHost", async () => {
    const access = await import("../../src/store/cliAccessStore.js");
    access.useCliAccessStore.setState({ localOnly: false, noHost: false, remoteProbe: false });
    access.markLocalOnly();
    access.markNoHost();
    access.clearNoHost();
    expect(access.useCliAccessStore.getState()).toMatchObject({ localOnly: true, noHost: false });
    access.useCliAccessStore.setState({ localOnly: false, remoteProbe: false });
  });
});

// React effect harness executes the real shared status hook. Presentation and
// unrelated imports are inert; no source regex can accidentally pass this gate.
describe("useSetupCard status requests (behavior)", () => {
  let scope;
  let access;
  let hook;
  let fetchMock;
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const render = () => {
    rt.state.index = 0;
    rt.state.pending = [];
    const view = hook({ statusUrl: "/api/cli-tools/demo", toolId: "demo" });
    for (const run of rt.state.pending) run();
    return view;
  };
  beforeEach(() => {
    rt.state.slots = [];
    scope = { ready: false, canHostOps: true };
    access = { localOnly: false, noHost: false, generation: 0 };
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ installed: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const compiled = transformSync(readSrc("components/setupCard.js"), {
      filename: "setupCard.js",
      jsc: {
        parser: { syntax: "ecmascript", jsx: true },
        transform: { react: { runtime: "automatic" } },
      },
      module: { type: "commonjs" },
    });
    const dependencies = {
      react: rt.hooks,
      "prop-types": require("prop-types"),
      "../hooks/useCliScope": { useCliScope: () => scope },
      "@/store/cliAccessStore": {
        useCliAccessStore: { getState: () => access },
        markLocalOnly: () => {
          access.localOnly = true;
        },
      },
      "@/shared/utils/localOnly": { isLocalOnlyResponse: async () => false },
    };
    const output = {};
    new Function("require", "exports", compiled.code)((name) => dependencies[name] ?? {}, output);
    hook = output.useSetupCard;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("before ready: effect and explicit fetchStatus both make zero requests", async () => {
    const view = render();
    await view.fetchStatus();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.checking).toBe(true);
  });
  it("member: no status or aliases fetch and no loading flash", async () => {
    scope = { ready: true, canHostOps: false };
    const view = render();
    await view.fetchStatus();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.checking).toBe(false);
    expect(view.status).toBeNull();
  });
  it("legacy host: fetch after ready, callback changes cause no request loop", async () => {
    render();
    scope = { ready: true, canHostOps: true };
    render();
    await flush();
    render();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/cli-tools/demo",
      "/api/models/alias",
    ]);
  });
  it("revoke while a host load is in-flight hides and discards its result", async () => {
    let release;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    scope = { ready: true, canHostOps: true };
    render();
    scope = { ready: true, canHostOps: false };
    access.generation += 1;
    expect(render().status).toBeNull();
    release({ ok: true, json: async () => ({ installed: true }) });
    await flush();
    expect(render().status).toBeNull();
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("preset import cannot resume into another principal's cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("drops host key presets after an endpoint import crosses markNoHost", async () => {
    vi.resetModules();
    const { ACTIVE } = await import("../../src/shared/brand/index.js");
    const local = new Map([
      [
        `${ACTIVE.storageKeyPrefix}cliToolEndpointPresets`,
        JSON.stringify([{ name: "local", baseUrl: "https://local.example" }]),
      ],
    ]);
    const events = [];
    vi.stubGlobal("window", {
      localStorage: { getItem: (k) => local.get(k) ?? null, removeItem: (k) => local.delete(k) },
      dispatchEvent: (event) => events.push(event.type),
    });
    const put = deferred();
    const fetchMock = vi.fn(async (_url, init = {}) =>
      init.method === "PUT"
        ? put.promise
        : {
            ok: true,
            json: async () => ({
              presets: {
                endpoints: [],
                apiKeys: [{ name: "host credential", apiKeyId: "host-id" }],
              },
            }),
          },
    );
    vi.stubGlobal("fetch", fetchMock);
    const access = await import("../../src/store/cliAccessStore.js");
    const presets = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js"
    );
    presets.readPresets();
    await settle();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true);
    expect(presets.readPresets()).toHaveLength(1); // import really paused
    access.markNoHost();
    const eventsAfterReset = events.length;
    put.resolve({ ok: true, json: async () => ({ presets: { endpoints: [], apiKeys: [] } }) });
    await settle();
    expect(presets.readPresets()).toEqual([]);
    expect(presets.readKeyPresets()).toEqual([]);
    expect(events).toHaveLength(eventsAfterReset);
    expect(local.size).toBe(1); // stale import does not delete browser data
  });
});

describe("setup data ignores obsolete key failures and body reads", () => {
  let scope, access, hook, mode, canCreate, loadContext, loadSettingsMock;
  const render = () => {
    rt.state.index = 0;
    rt.state.pending = [];
    const view = hook();
    for (const run of rt.state.pending) run();
    return view;
  };
  beforeEach(() => {
    rt.state.slots = [];
    scope = {
      ready: true,
      canHostOps: true,
      canManageInstance: true,
      scope: null,
      identity: "old",
    };
    access = { generation: 0, identity: "old" };
    mode = vi.fn();
    canCreate = vi.fn();
    loadSettingsMock = vi.fn(async () => null);
    loadContext = vi.fn(async () => ({ storage: "hashed", canCreate: true, workspaceId: "w" }));
    const store = Object.assign((select) => select(access), { getState: () => access });
    const dependencies = {
      react: rt.hooks,
      "./useCliScope": { useCliScope: () => scope },
      "@/store/cliAccessStore": { useCliAccessStore: store, setKeyCanCreate: canCreate },
      "../components/cliEndpointPresets": { setKeyPresetStorageMode: mode },
      "../../endpoint/hooks/useApiKeys": {
        loadKeyContext: (...args) => loadContext(...args),
        loadKeyList: async () => [],
      },
      "@/shared/constants/models": { getModelsByProviderId: () => [], PROVIDER_ID_TO_ALIAS: {} },
      "@/shared/utils/settingsApi": {
        loadSettings: (...args) => loadSettingsMock(...args),
        onHttpError: () => () => null,
      },
      "@/app/(dashboard)/dashboard/providers/connectTarget": { withWorkspace: (path) => path },
    };
    const compiled = transformSync(readSrc("hooks/useToolSetupData.js"), {
      filename: "useToolSetupData.js",
      jsc: { parser: { syntax: "ecmascript" } },
      module: { type: "commonjs" },
    });
    const output = {};
    new Function("require", "exports", compiled.code)((name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
      return dependencies[name];
    }, output);
    hook = output.useToolSetupData;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const switchIdentity = () => {
    scope = { ...scope, identity: "new" };
    access.generation += 1;
    access.identity = "new";
  };

  it("old key rejection cannot erase the new key context or create permission", async () => {
    const old = deferred();
    loadContext.mockImplementationOnce(() => old.promise);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render();
    await settle();
    switchIdentity();
    render();
    await settle();
    expect(render().keyContext?.storage).toBe("hashed");
    mode.mockClear();
    canCreate.mockClear();
    old.reject(new Error("old identity lost access"));
    await settle();
    expect(mode).not.toHaveBeenCalled();
    expect(canCreate).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(render().keyContext?.workspaceId).toBe("w");
  });

  it("old identity settings cannot overwrite new flags after an intervening await", async () => {
    // Member path (no provider body read), so settings is the first state write
    // the obsolete run reaches after its key-context await resumes.
    scope = { ...scope, canHostOps: false };
    const oldKeys = deferred();
    loadContext.mockImplementationOnce(() => oldKeys.promise);
    loadSettingsMock
      .mockResolvedValueOnce({ cloudEnabled: true, ccFilterNaming: true })
      .mockResolvedValueOnce({ cloudEnabled: false, ccFilterNaming: false });
    render();
    await settle();
    switchIdentity();
    render();
    await settle();
    expect(render().ccFilterNaming).toBe(false);
    oldKeys.resolve({ storage: "hashed", canCreate: true, workspaceId: "old" });
    await settle();
    const view = render();
    expect(view.cloudEnabled).toBe(false);
    expect(view.ccFilterNaming).toBe(false);
    expect(view.keyContext?.workspaceId).toBe("w");
  });

  it.each(["/api/providers", "/api/tunnel/status", "/api/models/alias"])(
    "drops obsolete response body from %s after identity changes",
    async (path) => {
      const body = deferred();
      let first = true;
      const fresh = {
        connections: [{ provider: "new", name: "new" }],
        tunnel: { enabled: true, publicUrl: "https://new.example" },
        aliases: { new: "new/model" },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => ({
          ok: true,
          json: () => {
            if (url === path && first) {
              first = false;
              return body.promise;
            }
            return Promise.resolve(fresh);
          },
        })),
      );
      render();
      await settle();
      expect(first).toBe(false); // old body read really pending
      switchIdentity();
      render();
      await settle();
      const old = {
        connections: [{ provider: "old", name: "host-secret" }],
        tunnel: { enabled: true, publicUrl: "https://old.example" },
        aliases: { old: "old/model" },
      };
      body.resolve(old);
      await settle();
      const view = render();
      expect(view.connections).toEqual(fresh.connections);
      expect(view.tunnelPublicUrl).toBe("https://new.example");
      expect(view.modelAliases).toEqual(fresh.aliases);
    },
  );
});
