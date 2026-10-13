// YAN-377: users/workspaces/keys/auth reset-mode CLI commands against a
// loopback stub server. Real client + real commands; only password prompts
// are injected. No real HOME (tests/vitest.config.js isolates it).
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = (rel) => require.resolve(`../../cli/src/cli/${rel}`);
const CLIENT = P("api/client.js");
const USERS_API = P("api/usersClient.js");

let server;
let captured;
let routes;
let out;
let err;

const start = () =>
  new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        captured.push({
          method: req.method,
          url: req.url,
          legacy: req.headers["x-9r-cli-token"],
          current: req.headers["x-tokenhop-cli-token"],
          body: body ? JSON.parse(body) : null,
        });
        const queue = routes[`${req.method}${req.url}`] ?? { status: 404, body: {} };
        const route = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
        res.writeHead(route.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(route.body ?? {}));
      });
    });
    server.listen(0, "127.0.0.1", resolve);
  });

const port = () => server.address().port;

function load(rel) {
  for (const mod of [
    CLIENT,
    USERS_API,
    P("commands/users.js"),
    P("commands/keys.js"),
    P("commands/authResetMode.js"),
    P("commands/_runApi.js"),
  ]) {
    delete require.cache[mod];
  }
  return require(P(rel));
}

const passwords = (...values) => ({ promptPassword: vi.fn(async () => values.shift()) });
const text = () => out.join("\n");

beforeEach(async () => {
  captured = [];
  routes = {};
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.join(" ")));
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
});

describe("headers", () => {
  it("sends both CLI token headers with the same non-empty value", async () => {
    routes["GET/api/users"] = { status: 200, body: { users: [], pagination: {} } };
    const { runUsers } = load("commands/users.js");
    expect(await runUsers(["list", "--port", String(port())])).toBe(0);
    expect(captured[0].legacy).toBeTruthy();
    expect(captured[0].current).toBe(captured[0].legacy);
  });
});

describe("users", () => {
  const cases = [
    [["approve", "u1"], "PATCH", "/api/users/u1", { instanceRole: "user" }],
    [["role", "u1", "admin"], "PATCH", "/api/users/u1", { instanceRole: "admin" }],
    [["disable", "u1"], "PATCH", "/api/users/u1", { status: "disabled" }],
    [["enable", "u1"], "PATCH", "/api/users/u1", { status: "active" }],
  ];
  it.each(cases)("%j → %s %s", async (argv, method, url, body) => {
    routes[`${method}${url}`] = { status: 200, body: { user: { id: "u1" } } };
    const { runUsers } = load("commands/users.js");
    expect(await runUsers([...argv, "--port", String(port())])).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ method, url, body });
  });

  it("list passes filters and renders rows", async () => {
    routes["GET/api/users?search=al&status=active&page=2"] = {
      status: 200,
      body: {
        users: [{ id: "u1", username: "alice", instanceRole: "user", status: "active" }],
        pagination: { page: 2, totalPages: 3, totalItems: 5 },
      },
    };
    const { runUsers } = load("commands/users.js");
    expect(
      await runUsers([
        "list",
        "--search",
        "al",
        "--status",
        "active",
        "--page",
        "2",
        "--port",
        String(port()),
      ]),
    ).toBe(0);
    expect(text()).toContain("alice");
  });

  it("rejects an invalid role locally", async () => {
    const { runUsers } = load("commands/users.js");
    expect(await runUsers(["role", "u1", "owner", "--port", String(port())])).toBe(1);
    expect(captured).toHaveLength(0);
  });

  it("reset-password sends confirmed hidden password; mismatch sends nothing", async () => {
    routes["POST/api/users/u1/password"] = { status: 200, body: { success: true } };
    let { runUsers } = load("commands/users.js");
    expect(
      await runUsers(["reset-password", "u1", "--port", String(port())], {
        io: passwords("Tmp-pass-12345", "Tmp-pass-12345"),
      }),
    ).toBe(0);
    expect(captured[0].body).toEqual({ password: "Tmp-pass-12345" });
    expect(text()).not.toContain("Tmp-pass-12345");
    captured.length = 0;
    ({ runUsers } = load("commands/users.js"));
    expect(
      await runUsers(["reset-password", "u1", "--port", String(port())], {
        io: passwords("a", "b"),
      }),
    ).toBe(1);
    expect(captured).toHaveLength(0);
  });

  it("transfer-owner sends target + prompted password, never echoes it", async () => {
    routes["POST/api/users/ownership-transfer"] = { status: 200, body: { user: {} } };
    const { runUsers } = load("commands/users.js");
    expect(
      await runUsers(["transfer-owner", "u2", "--port", String(port())], {
        io: passwords("owner-secret"),
      }),
    ).toBe(0);
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "/api/users/ownership-transfer",
      body: { toUserId: "u2", currentPassword: "owner-secret" },
    });
    expect(text() + err.join()).not.toContain("owner-secret");
  });
});

describe("workspaces", () => {
  it("list, members, add, remove hit the right routes", async () => {
    routes["GET/api/workspaces"] = {
      status: 200,
      body: { workspaces: [{ id: "w1", name: "Default", memberCount: 2 }] },
    };
    routes["GET/api/workspaces/w1/members"] = {
      status: 200,
      body: { members: [{ userId: "u1", role: "manager" }] },
    };
    routes["POST/api/workspaces/w1/members"] = { status: 201, body: { member: {} } };
    routes["DELETE/api/workspaces/w1/members/u1"] = { status: 200, body: { removed: true } };
    const { runWorkspaces } = load("commands/users.js");
    const p = ["--port", String(port())];
    expect(await runWorkspaces(["list", ...p])).toBe(0);
    expect(await runWorkspaces(["members", "w1", ...p])).toBe(0);
    expect(await runWorkspaces(["add-member", "w1", "u1", "--role", "viewer", ...p])).toBe(0);
    expect(await runWorkspaces(["remove-member", "w1", "u1", ...p])).toBe(0);
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/workspaces",
      "GET /api/workspaces/w1/members",
      "POST /api/workspaces/w1/members",
      "DELETE /api/workspaces/w1/members/u1",
    ]);
    expect(captured[2].body).toEqual({ userId: "u1", role: "viewer" });
  });
});

describe("keys", () => {
  it("create prints the raw key exactly once with a store-it-now note", async () => {
    routes["GET/api/keys/context"] = {
      status: 200,
      body: {
        storage: "hashed",
        workspaceId: "w1",
        canCreate: true,
        canManage: true,
        canCreateService: true,
      },
    };
    routes["POST/api/keys?workspaceId=w2"] = {
      status: 201,
      body: { key: "th_raw_secret", id: "k1", name: "ci", storage: "hashed" },
    };
    const { run } = load("commands/keys.js");
    expect(
      await run([
        "create",
        "ci",
        "--workspace",
        "w2",
        "--type",
        "service",
        "--port",
        String(port()),
      ]),
    ).toBe(0);
    expect(captured[0].body).toEqual({ type: "service", name: "ci" });
    const all = text();
    expect(all.split("th_raw_secret")).toHaveLength(2);
    expect(all).toMatch(/store it now/i);
  });

  it("create --user sends userId in the body; rejects --user with service type", async () => {
    routes["POST/api/keys?workspaceId=w1"] = { status: 201, body: { key: "th_k", id: "k1" } };
    const { run } = load("commands/keys.js");
    const p = ["--workspace", "w1", "--port", String(port())];
    expect(await run(["create", "ci", "--user", "u9", ...p])).toBe(0);
    expect(captured[0].body).toEqual({ type: "user", name: "ci", userId: "u9" });
    captured.length = 0;
    expect(await run(["create", "ci", "--user", "u9", "--type", "service", ...p])).toBe(1);
    expect(captured).toHaveLength(0);
  });

  it("surfaces a server refusal of --user target", async () => {
    routes["POST/api/keys?workspaceId=w1"] = { status: 403, body: { error: "Forbidden" } };
    const { run } = load("commands/keys.js");
    expect(
      await run(["create", "ci", "--user", "u9", "--workspace", "w1", "--port", String(port())]),
    ).toBe(1);
    expect(err.join()).toMatch(/Forbidden/);
  });

  it("list and revoke pass workspaceId", async () => {
    routes["GET/api/keys?workspaceId=w1"] = {
      status: 200,
      body: { keys: [{ id: "k1", name: "ci", prefix: "th_A…z" }] },
    };
    routes["DELETE/api/keys/k1?workspaceId=w1"] = { status: 200, body: {} };
    const { run } = load("commands/keys.js");
    const p = ["--workspace", "w1", "--port", String(port())];
    expect(await run(["list", ...p])).toBe(0);
    expect(await run(["revoke", "k1", ...p])).toBe(0);
    expect(text()).toContain("th_A…z");
  });

  it("backup-hint never prints the env value", async () => {
    const { backupHint } = load("commands/keys.js");
    await backupHint({ env: { TOKENHOP_MASTER_KEY: "SUPER-SECRET-KEK" } });
    expect(text()).toContain("TOKENHOP_MASTER_KEY");
    expect(text()).not.toContain("SUPER-SECRET-KEK");
    expect(text()).toMatch(/unrecoverable/);
    out.length = 0;
    await backupHint({ env: {}, getDataDir: () => "/data" });
    expect(text()).toContain("/data/keys/master");
  });
});

describe("auth reset-mode password", () => {
  it("plain success sends one request without password", async () => {
    routes["POST/api/auth/reset-mode"] = {
      status: 200,
      body: { success: true, authMode: "password", ownerPasswordSet: true },
    };
    const { run } = load("commands/authResetMode.js");
    expect(await run(["password", "--port", String(port())])).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({ mode: "password" });
  });

  it("409 OWNER_PASSWORD_REQUIRED prompts then retries with the password", async () => {
    routes["POST/api/auth/reset-mode"] = [
      { status: 409, body: { error: "Owner needs a password", code: "OWNER_PASSWORD_REQUIRED" } },
      { status: 200, body: { success: true, authMode: "password", ownerPasswordSet: true } },
    ];
    const { run } = load("commands/authResetMode.js");
    const io = passwords("New-pass-12345", "New-pass-12345");
    expect(await run(["password", "--port", String(port())], { io })).toBe(0);
    expect(captured.map((c) => c.body)).toEqual([
      { mode: "password" },
      { mode: "password", password: "New-pass-12345" },
    ]);
    expect(text()).not.toContain("New-pass-12345");
  });
});

describe("error mapping", () => {
  it("404 → multi-user not enabled", async () => {
    const { runUsers } = load("commands/users.js");
    expect(await runUsers(["list", "--port", String(port())])).toBe(1);
    expect(err.join()).toMatch(
      /multi-user is not enabled on this server \(TOKENHOP_MULTI_USER=on\)/,
    );
  });

  it("401/403 give clear messages", async () => {
    routes["GET/api/users"] = { status: 401, body: { error: "Unauthorized" } };
    routes["GET/api/workspaces"] = { status: 403, body: { error: "Forbidden" } };
    const cmd = load("commands/users.js");
    expect(await cmd.runUsers(["list", "--port", String(port())])).toBe(1);
    expect(await cmd.runWorkspaces(["list", "--port", String(port())])).toBe(1);
    expect(err.join("\n")).toMatch(/Unauthorized: run the CLI on the server host/);
    expect(err.join("\n")).toMatch(/only the instance owner/);
  });

  it("refused port → server not running", async () => {
    const dead = port();
    await new Promise((resolve) => server.close(resolve));
    const { runUsers } = load("commands/users.js");
    expect(await runUsers(["list", "--port", String(dead)])).toBe(1);
    expect(err.join()).toMatch(
      new RegExp(`tokenhop server is not running on 127\\.0\\.0\\.1:${dead}`),
    );
    await start();
  });

  it("--help exits 0 without a request", async () => {
    const { runUsers } = load("commands/users.js");
    expect(await runUsers(["--help"])).toBe(0);
    expect(captured).toHaveLength(0);
    expect(text()).toContain("transfer-owner");
  });
});

describe("workspace selection helper", () => {
  const status = (body) => ({ status: 200, body });
  const ws = [
    { id: "w1", name: "Mine" },
    { id: "w2", name: "Default", isDefault: true },
  ];

  it("defaults to the Default workspace and scopes providers/combos", async () => {
    routes["GET/api/auth/status"] = status({
      multiUserActive: true,
      principal: { workspaces: ws },
    });
    routes["GET/api/providers?workspaceId=w2"] = status({ connections: [] });
    routes["GET/api/combos?workspaceId=w1"] = status({ combos: [] });
    routes["POST/api/combos?workspaceId=w1"] = status({});
    const api = load("api/client.js");
    api.configure({ host: "127.0.0.1", port: port(), protocol: "http:" });
    delete require.cache[P("api/workspaceSelection.js")];
    const sel = require(P("api/workspaceSelection.js"));
    expect(await sel.loadMultiUserState()).toBeTruthy();
    expect(sel.getSelectedWorkspaceId()).toBe("w2");
    expect((await api.getProviders()).success).toBe(true);
    expect(sel.selectWorkspace("nope")).toBe(false);
    expect(sel.selectWorkspace("w1")).toBe(true);
    expect((await api.getCombos()).success).toBe(true);
    expect((await api.createCombo({ name: "c", models: [] })).success).toBe(true);
  });

  it("scopes the OAuth authorize start URL; exchange/poll stay unscoped; no selection → pristine", async () => {
    routes["GET/api/auth/status"] = status({
      multiUserActive: true,
      principal: { workspaces: ws },
    });
    const red = encodeURIComponent("http://localhost:1455/auth/callback");
    routes[`GET/api/oauth/codex/authorize?redirect_uri=${red}&workspaceId=w1`] = status({
      url: "https://idp/authorize",
    });
    routes[`POST/api/oauth/codex/exchange`] = status({ ok: true });
    const api = load("api/client.js");
    api.configure({ host: "127.0.0.1", port: port(), protocol: "http:" });
    delete require.cache[P("api/workspaceSelection.js")];
    const sel = require(P("api/workspaceSelection.js"));
    await sel.loadMultiUserState();
    sel.selectWorkspace("w1");
    expect((await api.getOAuthAuthUrl("codex")).success).toBe(true);
    expect(captured.at(-1).url).toBe(
      `/api/oauth/codex/authorize?redirect_uri=${red}&workspaceId=w1`,
    );
    expect((await api.exchangeOAuthCode("codex", { code: "c" })).success).toBe(true);
    expect(captured.at(-1).url).toBe("/api/oauth/codex/exchange");
    // No selection: authorize stays pristine (no workspaceId appended).
    routes["GET/api/auth/status"] = status({ multiUserActive: false });
    routes[`GET/api/oauth/codex/authorize?redirect_uri=${red}`] = status({ url: "u" });
    await sel.loadMultiUserState();
    expect((await api.getOAuthAuthUrl("codex")).success).toBe(true);
    expect(captured.at(-1).url).toBe(`/api/oauth/codex/authorize?redirect_uri=${red}`);
  });

  it("multi-user off leaves requests pristine", async () => {
    routes["GET/api/auth/status"] = status({ multiUserActive: false });
    routes["GET/api/providers"] = status({ connections: [] });
    const api = load("api/client.js");
    api.configure({ host: "127.0.0.1", port: port(), protocol: "http:" });
    delete require.cache[P("api/workspaceSelection.js")];
    const sel = require(P("api/workspaceSelection.js"));
    expect(await sel.loadMultiUserState()).toBeNull();
    expect(sel.getSelectedWorkspaceId()).toBeUndefined();
    await api.getProviders();
    expect(captured.at(-1).url).toBe("/api/providers");
  });
});
