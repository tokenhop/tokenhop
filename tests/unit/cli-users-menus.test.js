// YAN-377: interactive terminal menus for users & workspaces. Main menu is
// byte-identical while multi-user is off; when on it gains a workspace picker
// that scopes providers/combos/keys to the owner's selected workspace, plus a
// gated users/workspaces management section. Loopback stub server only.
import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const P = (rel) => require.resolve(`../../cli/src/cli/${rel}`);

let server;
let captured;
let routes;
let out;

const start = () =>
  new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        const queue = routes[`${req.method}${req.url}`] ?? { status: 404, body: {} };
        const route = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
        res.writeHead(route.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(route.body ?? {}));
      });
    });
    server.listen(0, "127.0.0.1", resolve);
  });

const port = () => server.address().port;

const STATUS_ON = {
  multiUserActive: true,
  principal: {
    workspaces: [
      { id: "w1", name: "Mine" },
      { id: "w2", name: "Default", isDefault: true },
    ],
  },
};

// CJS modules: purge the cache, patch utils/input before the menus destructure it.
function loadUi({ selectMenu, confirm, prompt, pause } = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/cli/src/cli/")) delete require.cache[key];
  }
  const input = require(P("utils/input.js"));
  input.selectMenu = selectMenu;
  input.confirm = confirm ?? vi.fn(async () => true);
  input.prompt = prompt ?? vi.fn(async () => "");
  input.pause = pause ?? vi.fn(async () => {});
  const api = require(P("api/client.js"));
  api.configure({ host: "127.0.0.1", port: port(), protocol: "http:" });
  return {
    ui: require(P("terminalUI.js")),
    api,
    workspace: require(P("api/workspaceSelection.js")),
  };
}

const MAIN = (title) => /Terminal UI$/.test(title);

beforeEach(async () => {
  captured = [];
  routes = {
    "GET/api/tunnel/status": { status: 200, body: { enabled: false } },
    "GET/api/providers": { status: 200, body: { connections: [] } },
    "GET/api/keys": { status: 200, body: { keys: [] } },
  };
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
});

const mainLabels = (selectMenu) =>
  selectMenu.mock.calls
    .find(([t]) => MAIN(t))[1]
    .map((i) => i.label)
    .filter((l) => typeof l === "string");

describe("main menu gating", () => {
  it("multi-user off: menu is exactly the existing one", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: { multiUserActive: false } };
    const selectMenu = vi.fn(async () => -1);
    await loadUi({ selectMenu }).ui.startTerminalUI(port());
    const labels = selectMenu.mock.calls[0][1].map((i) => i.label);
    expect(labels).toEqual([
      "← Back to Interface Menu",
      "Providers",
      "API Keys",
      "Combos",
      "CLI Tools",
      "Settings",
    ]);
  });

  it("multi-user on: workspace picker + Users & workspaces appear", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    const selectMenu = vi.fn(async () => -1);
    await loadUi({ selectMenu }).ui.startTerminalUI(port());
    expect(mainLabels(selectMenu)).toContain("Users & workspaces");
    expect(mainLabels(selectMenu).some((l) => /^Workspace: Default \(change\)$/.test(l))).toBe(
      true,
    );
  });

  it("picked workspace scopes providers & combos requests", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    routes["GET/api/providers?workspaceId=w1"] = { status: 200, body: { connections: [] } };
    routes["GET/api/combos?workspaceId=w1"] = { status: 200, body: { combos: [] } };
    let step = 0;
    let api;
    const selectMenu = vi.fn(async (title, items) => {
      if (title === "Choose workspace") return 1; // Mine
      if (MAIN(title)) {
        step += 1;
        if (step === 1) return items.findIndex((i) => /^Workspace:/.test(i.label));
        if (step === 2) {
          await api.getProviders();
          await api.getCombos();
        }
      }
      return -1;
    });
    ({ api } = loadUi({ selectMenu }));
    (await api) && (await require(P("terminalUI.js")).startTerminalUI(port()));
    const urls = captured.map((c) => c.url);
    expect(urls).toContain("/api/providers?workspaceId=w1");
    expect(urls).toContain("/api/combos?workspaceId=w1");
    expect(urls).not.toContain("/api/providers");
  });
});

describe("switch state changes while the TUI runs", () => {
  const legacy = [
    "← Back to Interface Menu",
    "Providers",
    "API Keys",
    "Combos",
    "CLI Tools",
    "Settings",
  ];

  it("on → off: section vanishes, selection cleared, requests unscoped", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    routes["GET/api/providers?workspaceId=w2"] = { status: 200, body: { connections: [] } };
    let entry = 0;
    let api;
    const selectMenu = vi.fn(async (title) => {
      if (!MAIN(title)) return -1;
      entry += 1;
      if (entry === 1) {
        await api.getProviders(); // scoped while on
        routes["GET/api/auth/status"] = { status: 200, body: { multiUserActive: false } };
        return 4; // CLI Tools → back to main menu (stub returns -1 inside)
      }
      if (entry === 2) await api.getProviders(); // must be pristine now
      return -1;
    });
    const loaded = loadUi({ selectMenu });
    api = loaded.api;
    await loaded.ui.startTerminalUI(port());
    const mains = selectMenu.mock.calls.filter(([t]) => MAIN(t));
    expect(mains[0][1].map((i) => i.label)).toContain("Users & workspaces");
    expect(mains[1][1].map((i) => i.label)).toEqual(legacy);
    expect(loaded.workspace.getSelectedWorkspaceId()).toBeUndefined();
    const providers = captured.filter((c) => c.url.startsWith("/api/providers"));
    expect(providers.some((c) => c.url === "/api/providers?workspaceId=w2")).toBe(true);
    expect(providers.at(-1).url).toBe("/api/providers");
  });

  it("off → on: section appears on next main-menu entry", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: { multiUserActive: false } };
    let entry = 0;
    const selectMenu = vi.fn(async (title) => {
      if (!MAIN(title)) return -1;
      entry += 1;
      if (entry === 1) {
        routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
        return 4;
      }
      return -1;
    });
    await loadUi({ selectMenu }).ui.startTerminalUI(port());
    const mains = selectMenu.mock.calls.filter(([t]) => MAIN(t));
    expect(mains[0][1].map((i) => i.label)).toEqual(legacy);
    expect(mains[1][1].map((i) => i.label)).toContain("Users & workspaces");
  });

  it("status unavailable (server restart): menu falls back to legacy, selection cleared", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    let entry = 0;
    const selectMenu = vi.fn(async (title) => {
      if (!MAIN(title)) return -1;
      entry += 1;
      if (entry === 1) {
        routes["GET/api/auth/status"] = { status: 500, body: {} };
        return 4;
      }
      return -1;
    });
    const loaded = loadUi({ selectMenu });
    await loaded.ui.startTerminalUI(port());
    const mains = selectMenu.mock.calls.filter(([t]) => MAIN(t));
    expect(mains[1][1].map((i) => i.label)).toEqual(legacy);
    expect(loaded.workspace.getSelectedWorkspaceId()).toBeUndefined();
  });
});

describe("API keys menu scoping", () => {
  it("selected workspace scopes the key context and key collection", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    routes["GET/api/keys/context?workspaceId=w1"] = {
      status: 200,
      body: {
        storage: "hashed",
        workspaceId: "w1",
        canCreate: true,
        canManage: true,
        canCreateService: false,
      },
    };
    routes["GET/api/keys?workspaceId=w1"] = {
      status: 200,
      body: { storage: "hashed", keys: [{ id: "k1", name: "ci", prefix: "th_a…" }] },
    };
    const selectMenu = vi.fn(async () => -1);
    const { workspace } = loadUi({ selectMenu });
    await workspace.loadMultiUserState();
    expect(workspace.selectWorkspace("w1")).toBe(true);
    await require(P("menus/apiKeys.js")).showApiKeysMenu(port());
    const urls = captured.map((c) => c.url);
    expect(urls).toContain("/api/keys/context?workspaceId=w1");
    expect(urls).toContain("/api/keys?workspaceId=w1");
  });
});

const USER = { id: "u1", username: "alice", instanceRole: "user", status: "active" };

function usersFlow(extra) {
  routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
  routes["GET/api/users?page=1"] = {
    status: 200,
    body: { users: [USER], pagination: { page: 1, totalPages: 1 } },
  };
  routes["GET/api/users/u1"] = { status: 200, body: { user: USER } };
  routes["PATCH/api/users/u1"] = { status: 200, body: { user: USER } };
  let main = 0;
  const seen = {};
  return vi.fn(async (title, items) => {
    seen[title] = (seen[title] ?? 0) + 1;
    if (MAIN(title))
      return ++main === 1 ? items.findIndex((i) => i.label === "Users & workspaces") : -1;
    if (title === "Users & workspaces") return seen[title] === 1 ? 1 : -1;
    if (title === "Users") return seen[title] === 1 ? 4 : -1;
    if (title === "alice") return seen[title] === 1 ? extra : -1;
    return -1;
  });
}

describe("users & workspaces actions", () => {
  it("approve forwards PATCH; back returns up through users list", async () => {
    const selectMenu = usersFlow(1);
    await loadUi({ selectMenu }).ui.startTerminalUI(port());
    const patches = captured.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ instanceRole: "user" });
    const titles = selectMenu.mock.calls.map(([t]) => t);
    expect(titles.filter((t) => t === "alice")).toHaveLength(2);
    expect(titles.filter((t) => t === "Users")).toHaveLength(2);
  });

  it("disable asks confirmation; declining forwards nothing", async () => {
    const confirm = vi.fn(async () => false);
    await loadUi({ selectMenu: usersFlow(3), confirm }).ui.startTerminalUI(port());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Disable alice"));
    expect(captured.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("disable confirmed forwards status disabled", async () => {
    await loadUi({ selectMenu: usersFlow(3) }).ui.startTerminalUI(port());
    expect(captured.find((c) => c.method === "PATCH").body).toEqual({ status: "disabled" });
  });

  it("workspaces → members → remove forwards DELETE after confirmation", async () => {
    routes["GET/api/auth/status"] = { status: 200, body: STATUS_ON };
    routes["GET/api/workspaces"] = {
      status: 200,
      body: { workspaces: [{ id: "ws1", name: "Team", memberCount: 1 }] },
    };
    routes["GET/api/workspaces/ws1/members"] = {
      status: 200,
      body: { members: [{ userId: "u1", displayName: "Alice", role: "member", source: "manual" }] },
    };
    routes["DELETE/api/workspaces/ws1/members/u1"] = { status: 200, body: { removed: true } };
    let main = 0;
    const seen = {};
    const confirm = vi.fn(async () => true);
    const selectMenu = vi.fn(async (title, items) => {
      seen[title] = (seen[title] ?? 0) + 1;
      if (MAIN(title))
        return ++main === 1 ? items.findIndex((i) => i.label === "Users & workspaces") : -1;
      if (title === "Users & workspaces") return seen[title] === 1 ? 2 : -1;
      if (title === "Workspaces") return seen[title] === 1 ? 1 : -1;
      if (title === "Members: Team") return seen[title] === 1 ? 2 : -1;
      if (title === "Alice") return seen[title] === 1 ? 1 : -1;
      return -1;
    });
    await loadUi({ selectMenu, confirm }).ui.startTerminalUI(port());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Remove u1"));
    expect(captured.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});
