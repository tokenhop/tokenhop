// YAN-363: CLI keys menu + client against the /api/keys contract.
// Real client module against a loopback http.Server (query/context
// behavior); menu helpers via stubbed require-injection (formatting and
// copy restrictions). No server routes, no deps, isolated DATA_DIR via
// tests/vitest.config.js.
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CLIENT_PATH = require.resolve("../../cli/src/cli/api/client.js");
const MENU_PATH = require.resolve("../../cli/src/cli/menus/apiKeys.js");
const INPUT_PATH = require.resolve("../../cli/src/cli/utils/input.js");
const CLIPBOARD_PATH = require.resolve("../../cli/src/cli/utils/clipboard.js");
const DISPLAY_PATH = require.resolve("../../cli/src/cli/utils/display.js");

// ---------------------------------------------------------------------------
// Loopback server harness for the real client module
// ---------------------------------------------------------------------------

let server;
let captured;
let routes; // path → { status, body } per test

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        captured.push({
          method: req.method,
          url: req.url,
          token: req.headers["x-9r-cli-token"],
          body: body ? JSON.parse(body) : null,
        });
        const route = routes[req.url] || routes[req.method + req.url] || { status: 404, body: {} };
        const payload = JSON.stringify(route.body ?? {});
        res.writeHead(route.status, { "Content-Type": "application/json" });
        res.end(payload);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function freshClient() {
  delete require.cache[CLIENT_PATH];
  const api = require(CLIENT_PATH);
  api.configure({ host: "127.0.0.1", port: server.address().port, protocol: "http:" });
  return api;
}

const ctx = (over = {}) => ({
  storage: "hashed",
  workspaceId: "ws-1",
  canCreate: true,
  canManage: true,
  canCreateService: true,
  ...over,
});

beforeEach(async () => {
  captured = [];
  routes = {};
  await startServer();
});

afterEach(async () => {
  delete require.cache[CLIENT_PATH];
  delete require.cache[MENU_PATH];
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
});

describe("client: /api/keys/context", () => {
  it("fetches the context over the CLI token transport", async () => {
    routes["/api/keys/context"] = { status: 200, body: ctx() };
    const api = freshClient();
    const result = await api.getApiKeysContext();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(ctx());
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("/api/keys/context");
    expect(typeof captured[0].token).toBe("string");
    expect(captured[0].token.length).toBeGreaterThan(0);
  });

  it("accepts an explicit legacy context", async () => {
    routes["/api/keys/context"] = { status: 200, body: ctx({ storage: "legacy" }) };
    const result = await freshClient().getApiKeysContext();
    expect(result.success).toBe(true);
    expect(result.data.storage).toBe("legacy");
    expect(captured).toHaveLength(1);
  });

  it("rejects malformed context envelopes", async () => {
    for (const body of [
      {},
      { ...ctx(), storage: "weird" },
      { ...ctx(), workspaceId: " " },
      { ...ctx(), canCreate: "yes" },
    ]) {
      routes["/api/keys/context"] = { status: 200, body };
      const result = await freshClient().getApiKeysContext();
      expect(result.success).toBe(false);
    }
  });

  it("falls back to legacy on context 401 only when the collection confirms the legacy envelope", async () => {
    routes["/api/keys/context"] = { status: 401, body: { error: "Unauthorized" } };
    routes["GET/api/keys"] = { status: 200, body: { keys: [{ id: "k", key: "raw", name: "n" }] } };
    const result = await freshClient().getApiKeysContext();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ storage: "legacy" });
    expect(captured).toHaveLength(2);
  });

  it("never downgrades when the confirmation is missing, failed, or hashed", async () => {
    const cases = [
      { status: 400, body: { error: "workspaceId is required" } }, // hashed storage
      { status: 500, body: { error: "Failed to fetch keys" } },
      { status: 403, body: { error: "Forbidden" } },
      { status: 200, body: { storage: "hashed", keys: [] } }, // hashed envelope
      { status: 200, body: { keys: [{ id: "k", name: "no-raw-key" }] } }, // not legacy shape
    ];
    for (const legacy of cases) {
      routes["/api/keys/context"] = { status: 401, body: { error: "Unauthorized" } };
      routes["GET/api/keys"] = legacy;
      const result = await freshClient().getApiKeysContext();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(captured).toHaveLength(2);
      captured = [];
      routes = { "/api/keys/context": { status: 401, body: { error: "Unauthorized" } } };
    }
  });

  it("does not probe legacy on non-401 context failures", async () => {
    for (const status of [500, 503, 404]) {
      routes["/api/keys/context"] = { status, body: { error: "boom" } };
      const result = await freshClient().getApiKeysContext();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(status);
      expect(captured).toHaveLength(1);
      captured = [];
    }
  });
});

describe("client: hashed key operations", () => {
  it("threads workspaceId through list, create, and delete", async () => {
    const api = freshClient();
    routes["GET/api/keys?workspaceId=ws%2F1"] = {
      status: 200,
      body: { keys: [{ id: "k1", name: "CI", prefix: "th_ABC…XYZ" }], storage: "hashed" },
    };
    routes["POST/api/keys?workspaceId=ws%2F1"] = {
      status: 201,
      body: { key: "th_secret", name: "CI", id: "k1", metadata: { id: "k1" }, storage: "hashed" },
    };
    routes["DELETE/api/keys/k1?workspaceId=ws%2F1"] = {
      status: 200,
      body: { key: {}, storage: "hashed" },
    };

    const list = await api.getApiKeys("ws/1");
    expect(list.success).toBe(true);
    expect(list.data.storage).toBe("hashed");
    expect(list.data.keys[0].prefix).toBe("th_ABC…XYZ");

    const created = await api.createApiKey("CI", { workspaceId: "ws/1", type: "user" });
    expect(created.success).toBe(true);
    expect(created.data.key).toBe("th_secret");

    const deleted = await api.deleteApiKey("k1", "ws/1");
    expect(deleted.success).toBe(true);

    expect(captured.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/keys?workspaceId=ws%2F1",
      "POST /api/keys?workspaceId=ws%2F1",
      "DELETE /api/keys/k1?workspaceId=ws%2F1",
    ]);
    expect(captured[1].body).toEqual({ type: "user", name: "CI" });
  });

  it("keeps the pristine legacy call shapes", async () => {
    const api = freshClient();
    routes["GET/api/keys"] = { status: 200, body: { keys: [] } };
    routes["POST/api/keys"] = { status: 201, body: { key: "raw", name: "n", id: "i" } };
    routes["DELETE/api/keys/i"] = { status: 200, body: { message: "ok" } };

    expect((await api.getApiKeys()).success).toBe(true);
    expect((await api.createApiKey("n")).success).toBe(true);
    expect((await api.deleteApiKey("i")).success).toBe(true);

    expect(captured.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/keys",
      "POST /api/keys",
      "DELETE /api/keys/i",
    ]);
    expect(captured[1].body).toEqual({ name: "n" });
  });

  it("rejects non user/service types locally without any request", async () => {
    const api = freshClient();
    const result = await api.createApiKey("n", { workspaceId: "w", type: "team" });
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Menu helpers (stubbed client/input/clipboard via require injection)
// ---------------------------------------------------------------------------

function loadMenu(overrides = {}) {
  const clientStub = {
    getApiKeysContext: vi.fn(),
    getApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    ...overrides.client,
  };
  const inputStub = {
    prompt: overrides.prompt ?? vi.fn(async () => "my key"),
    confirm: overrides.confirm ?? vi.fn(async () => false),
    pause: vi.fn(async () => {}),
    selectMenu: vi.fn(async () => -1),
  };
  const clipboardStub = { copyToClipboard: overrides.copyToClipboard ?? vi.fn(() => true) };
  const displayStub = {
    showStatus: overrides.showStatus ?? vi.fn(),
    clearScreen: vi.fn(),
    showHeader: vi.fn(),
  };
  for (const [path, mod] of [
    [CLIENT_PATH, clientStub],
    [INPUT_PATH, inputStub],
    [CLIPBOARD_PATH, clipboardStub],
    [DISPLAY_PATH, displayStub],
  ]) {
    require.cache[path] = { id: path, filename: path, loaded: true, exports: mod };
  }
  delete require.cache[MENU_PATH];
  const menu = require(MENU_PATH);
  return { menu, clientStub, inputStub, clipboardStub };
}

describe("menu: mode resolution and formatting", () => {
  it("resolves the menu mode from the context", async () => {
    const { resolveKeysMode } = loadMenu().menu.__test__;
    expect(resolveKeysMode({ storage: "hashed", workspaceId: "w" })).toBe("hashed");
    expect(resolveKeysMode({ storage: "legacy" })).toBe("legacy");
    expect(resolveKeysMode(undefined)).toBe("legacy");
  });

  it("formats hashed list items with prefix only — no raw key, no reveal", async () => {
    const { formatHashedKeyItem } = loadMenu().menu.__test__;
    expect(formatHashedKeyItem({ name: "CI", type: "service", prefix: "th_ABC…Wxyz" })).toBe(
      "CI [service] th_ABC…Wxyz",
    );
    expect(formatHashedKeyItem({ name: "mine", type: "user", prefix: "th_DEF…Abcd" })).toBe(
      "mine [user] th_DEF…Abcd",
    );
    expect(formatHashedKeyItem({ type: "user", prefix: "th_G…z", isActive: false })).toBe(
      "(unnamed) [user] th_G…z (inactive)",
    );
    expect(formatHashedKeyItem({ name: "x", type: "user", prefix: "p", revokedAt: "now" })).toBe(
      "x [user] p (revoked)",
    );
    // No code path in the formatter ever touches a raw `key` field.
    expect(formatHashedKeyItem.toString()).not.toContain(".key");
  });
});

describe("menu: hashed key creation", () => {
  it("creates a user key explicitly, shows the secret once, copies once, drops it", async () => {
    const confirm = vi.fn(async () => true); // copy? yes
    const createResult = {
      success: true,
      data: {
        key: "th_secret_raw",
        name: "my key",
        id: "k1",
        metadata: { id: "k1", type: "user", name: "my key" },
        storage: "hashed",
      },
    };
    const { menu, clientStub, clipboardStub } = loadMenu({
      confirm,
      client: { createApiKey: vi.fn(async () => createResult) },
    });
    const logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    const ok = await menu.__test__.handleCreateHashedKey("ws-1", false);

    expect(ok).toBe(true);
    expect(clientStub.createApiKey).toHaveBeenCalledWith("my key", {
      workspaceId: "ws-1",
      type: "user",
    });
    expect(logs.filter((line) => line.includes("th_secret_raw"))).toHaveLength(1);
    expect(clipboardStub.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(clipboardStub.copyToClipboard).toHaveBeenCalledWith("th_secret_raw");
    // Memory-only: the returned payload no longer carries the secret.
    expect(createResult.data.key).toBeUndefined();
  });

  it("member flow (allowService=false) never offers or sends a service key", async () => {
    const confirm = vi.fn(async () => true); // would answer yes to anything
    const { menu, clientStub } = loadMenu({
      confirm,
      client: {
        createApiKey: vi.fn(async () => ({
          success: true,
          data: { key: "k", name: "n", id: "i", metadata: { id: "i", type: "user" } },
        })),
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await menu.__test__.handleCreateHashedKey("ws-1", false);
    expect(clientStub.createApiKey).toHaveBeenCalledWith("my key", {
      workspaceId: "ws-1",
      type: "user",
    });
  });

  it("offers a service key only when allowed and sends the explicit choice", async () => {
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true) // service? yes
      .mockResolvedValueOnce(false); // copy? no
    const { menu, clientStub, clipboardStub } = loadMenu({
      confirm,
      client: {
        createApiKey: vi.fn(async () => ({
          success: true,
          data: { key: "k", name: "n", id: "i", metadata: { id: "i", type: "service" } },
        })),
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await menu.__test__.handleCreateHashedKey("ws-1", true);
    expect(clientStub.createApiKey).toHaveBeenCalledWith("my key", {
      workspaceId: "ws-1",
      type: "service",
    });
    expect(clipboardStub.copyToClipboard).not.toHaveBeenCalled();
  });

  it("surfaces creation failures without leaking anything", async () => {
    const { menu, clientStub } = loadMenu({
      client: { createApiKey: vi.fn(async () => ({ success: false, error: "Forbidden" })) },
    });
    const ok = await menu.__test__.handleCreateHashedKey("ws-1", false);
    expect(ok).toBe(false);
    expect(clientStub.createApiKey).toHaveBeenCalledTimes(1);
  });

  it("refuses empty names before any request", async () => {
    const { menu, clientStub } = loadMenu({ prompt: vi.fn(async () => "   ") });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await menu.__test__.handleCreateHashedKey("ws-1", false);
    expect(clientStub.createApiKey).not.toHaveBeenCalled();
  });
});
