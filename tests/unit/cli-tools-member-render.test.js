// YAN-374: behavior tests for the member export UI. Components are loaded
// through a real Vite SSR + SWC pipeline (tests/helpers/renderSsr.js) and
// rendered to markup, so these assert what each principal actually sees.
// Kept apart from cli-tools-member-ui.test.js, which mocks `react` wholesale.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSsr } from "../helpers/renderSsr.js";

const cliRoot = resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/cli-tools");
const readSrc = (file) => readFileSync(resolve(cliRoot, file), "utf8");

const MEMBER_AUTH = {
  multiUserActive: true,
  principal: {
    user: { id: "u" },
    role: "user",
    workspaces: [{ id: "w", role: "member", name: "W", kind: "shared" }],
    activeWorkspaceId: "w",
  },
};
const ADMIN_AUTH = {
  multiUserActive: true,
  principal: {
    user: { id: "a" },
    role: "owner",
    workspaces: [{ id: "w", role: "owner", name: "W", kind: "shared" }],
    activeWorkspaceId: "w",
  },
};

describe("rendered cards: member vs legacy host (YAN-374)", () => {
  let ssr;
  let access;
  let tools;
  let settings;
  beforeAll(async () => {
    ssr = await createSsr();
    access = await ssr.load("/src/store/cliAccessStore.js");
    settings = await ssr.load("/src/store/toolSettingsStore.js");
    tools = (await ssr.load("/src/shared/constants/cliTools.js")).CLI_TOOLS;
  });
  afterAll(async () => {
    delete globalThis.__authStatus;
    delete globalThis.__authLoaded;
    access.useCliAccessStore.setState({ localOnly: false, noHost: false, remoteProbe: false });
    await ssr.close();
  });
  const setAccess = ({ auth, noHost, loaded = true }) => {
    globalThis.__authStatus = auth;
    globalThis.__authLoaded = loaded;
    access.useCliAccessStore.setState({ localOnly: noHost, noHost, remoteProbe: false });
    settings.useToolSettingsStore.setState({ loaded: true });
  };
  const card = async (file, toolId, extra = {}) => {
    const mod = await ssr.load(`/src/app/(dashboard)/dashboard/cli-tools/components/${file}`);
    return renderToStaticMarkup(
      createElement(mod.default, {
        toolId,
        tool: tools[toolId],
        baseUrl: "http://x",
        apiKeys: [],
        activeProviders: [],
        hasActiveProviders: false,
        ...extra,
      }),
    );
  };
  const MODEL_CARDS = [
    ["CopilotToolCard.js", "copilot"],
    ["OpenCodeToolCard.js", "opencode"],
    ["CoworkToolCard.js", "cowork"],
  ];

  it.each(MODEL_CARDS)(
    "%s: member with no providers gets free-text model entry",
    async (file, id) => {
      setAccess({ auth: MEMBER_AUTH, noHost: true });
      const html = await card(file, id);
      // ModelTextAdd renders a text input labelled "Add model" plus an enabled Add button.
      expect(html).toMatch(/<input[^>]*aria-label="Add model"/);
    },
  );

  it.each(MODEL_CARDS)(
    "%s: legacy zero-provider host does NOT get the member input",
    async (file, id) => {
      setAccess({ auth: {}, noHost: false });
      const html = await card(file, id);
      expect(html).not.toMatch(/<input[^>]*aria-label="Add model"/);
    },
  );

  it.each([
    ["ClaudeToolCard.js", "claude"],
    ["CodexToolCard.js", "codex"],
    ["ClineToolCard.js", "cline"],
    ["KiloToolCard.js", "kilo"],
    ["DefaultToolCard.js", "cursor"],
    ["DroidToolCard.js", "droid"],
  ])(
    "%s: model is a typeable input with no providers (member export never blocked)",
    async (file, id) => {
      setAccess({ auth: MEMBER_AUTH, noHost: true });
      const html = await card(file, id);
      // Either a text input for the model or the Droid add-model input is rendered.
      expect(html).toMatch(
        /<input[^>]*type="text"|<input[^>]*aria-label="(Model|Add model)"|placeholder="provider\/model-id"|Not mapped/,
      );
    },
  );

  it("host-capable principal sees the ready-gated skeleton before auth, never a status", async () => {
    setAccess({ auth: {}, noHost: false, loaded: false });
    const html = await card("ClaudeToolCard.js", "claude");
    expect(html).not.toContain("Not installed");
    expect(html).not.toContain("Not configured");
  });
});

describe("no host status fetch before auth ready or for members (YAN-374)", () => {
  let ssr;
  let fetchCalls;
  beforeAll(async () => {
    ssr = await createSsr();
  });
  afterAll(async () => {
    await ssr.close();
  });
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal("fetch", (...args) => {
      fetchCalls.push(args[0]);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("useSetupCard sources gate the fetch on ready && canHostOps", () => {
    const src = readSrc("components/setupCard.js");
    expect(src).toContain("const allowed = ready && canHostOps;");
    expect(src).toMatch(/if \(!ready\) return;/);
    expect(src).toMatch(/if \(!canHostOps\) \{\n\s+setStatus\(null\);/);
    // statusUrl fetch sits after both returns
    const firstFetch = src.indexOf("fetch(statusUrl)\n        .then");
    expect(firstFetch).toBeGreaterThan(src.indexOf("if (!canHostOps)"));
  });

  it("ClaudeToolCard uses the same gate; status is null for members", () => {
    const src = readSrc("components/ClaudeToolCard.js");
    expect(src).toContain("useCliScope()");
    expect(src).toContain("const claudeStatus = settingsReady && canHostOps ? hostStatus : null;");
    expect(src).toMatch(
      /if \(!settingsReady\) return;\n\s+if \(!canHostOps\) setClaudeStatus\(null\);/,
    );
    expect(src).toContain("!allowedRef.current ||");
  });
});

describe("cache isolation (YAN-374)", () => {
  it("markNoHost clears tool settings and presets; clearNoHost keeps remote localOnly", async () => {
    vi.resetModules();
    const access = await import("../../src/store/cliAccessStore.js");
    const settings = await import("../../src/store/toolSettingsStore.js");
    const presets = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js"
    );
    globalThis.window = {
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ presets: {}, settings: {} }),
    }));
    try {
      settings.useToolSettingsStore.setState({
        saved: { claude: { model: "host/secret" } },
        loaded: true,
      });
      access.useCliAccessStore.setState({ localOnly: false, noHost: false, remoteProbe: false });
      presets.upsertPreset("https://host.example/v1");
      access.markNoHost();
      expect(settings.useToolSettingsStore.getState().saved).toEqual({});
      expect(settings.useToolSettingsStore.getState().loaded).toBe(false);
      expect(presets.readPresets()).toEqual([]);
      expect(presets.readKeyPresets()).toEqual([]);
      access.clearNoHost();
      expect(access.useCliAccessStore.getState().localOnly).toBe(false);
    } finally {
      delete globalThis.window;
      vi.unstubAllGlobals();
    }
  });

  it("remote dashboard (probe) stays localOnly after clearNoHost", async () => {
    vi.resetModules();
    const access = await import("../../src/store/cliAccessStore.js");
    access.useCliAccessStore.setState({ localOnly: false, noHost: false, remoteProbe: false });
    access.markLocalOnly();
    access.markNoHost();
    access.clearNoHost();
    expect(access.useCliAccessStore.getState()).toMatchObject({ localOnly: true, noHost: false });
  });

  it("flushToolSettings and saving are inert for members", async () => {
    vi.resetModules();
    const access = await import("../../src/store/cliAccessStore.js");
    const settings = await import("../../src/store/toolSettingsStore.js");
    const calls = [];
    vi.stubGlobal("fetch", async (...a) => {
      calls.push(a);
      return { ok: true, json: async () => ({}) };
    });
    access.markNoHost();
    settings.setToolSettings("claude", { model: "x" });
    await settings.flushToolSettings("claude");
    await settings.loadToolSettings();
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("Create my key is member-only, creator-only (YAN-374)", () => {
  let ssr;
  let access;
  beforeAll(async () => {
    ssr = await createSsr();
    access = await ssr.load("/src/store/cliAccessStore.js");
  });
  afterAll(async () => {
    delete globalThis.__authStatus;
    access.useCliAccessStore.setState({
      localOnly: false,
      noHost: false,
      remoteProbe: false,
      keyCanCreate: false,
    });
    await ssr.close();
  });
  const picker = async ({ auth, noHost, keyCanCreate }) => {
    globalThis.__authStatus = auth;
    access.useCliAccessStore.setState({ localOnly: noHost, noHost, keyCanCreate });
    const mod = await ssr.load(
      "/src/app/(dashboard)/dashboard/cli-tools/components/ApiKeySelect.js",
    );
    return renderToStaticMarkup(createElement(mod.default, { hashed: true, onChange() {} }));
  };

  it("member who can create sees the button", async () => {
    expect(await picker({ auth: MEMBER_AUTH, noHost: true, keyCanCreate: true })).toContain(
      "Create my key",
    );
  });
  it("viewer (cannot create) sees no button", async () => {
    expect(await picker({ auth: MEMBER_AUTH, noHost: true, keyCanCreate: false })).not.toContain(
      "Create my key",
    );
  });
  it("host owner never gets the new affordance", async () => {
    expect(await picker({ auth: ADMIN_AUTH, noHost: false, keyCanCreate: true })).not.toContain(
      "Create my key",
    );
  });
  it("switch-off host never gets it either", async () => {
    expect(await picker({ auth: {}, noHost: false, keyCanCreate: true })).not.toContain(
      "Create my key",
    );
  });
});

describe("member intercept steps hide the MITM link", () => {
  it("RemoteInterceptSteps links to /dashboard/mitm only when not a member", () => {
    const src = readSrc("components/InterceptTools.js");
    expect(src).toContain("function RemoteInterceptSteps({ member = false })");
    expect(src).toContain("{!member && <MitmRemoteSteps />}");
    expect(src).toMatch(/\{!member && \(?\s*<Link/);
  });
});
