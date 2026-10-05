// YAN-363 gateway key routing: shared resolveGatewayAuth across modalities,
// plus true handleChat/combo-probe authorization coverage (zero upstream on
// any forbidden requested target, leaf, judge or adapter member).
// No live external calls — executors are mocked at the engine seam.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, loggedRaw } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  loggedRaw: { value: null },
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  notifyRequestLogsEnabled: vi.fn(),
  createRequestLogger: async () => ({
    logClientRawRequest: (endpoint, body, headers) => {
      loggedRaw.value = { endpoint, body, headers };
    },
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async () => {}),
    saveRequestDetail: vi.fn(async () => {}),
  };
});

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import {
  resolveGatewayAuth,
  authorizeGatewayTarget,
  sanitizeGatewayCapture,
  gatewayKeyContext,
} from "@/lib/auth/gatewayAuth.js";
import {
  getGatewayConnections,
  getGatewayNodes,
  requireGatewayWorkspace,
} from "@/lib/auth/gatewayResources.js";
import { listApiKeys } from "@/lib/users/apiKeyManagement.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { getModelInfo } from "@/sse/services/model.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { runComboProbe, resetProbeRateLimit } from "@/sse/services/comboProbe.js";

const NOW = "2026-10-04T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"R".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

const request = ({ key = null, headers = {}, url = "http://localhost/v1/chat" } = {}) => {
  const h = new Headers(headers);
  if (key) h.set("authorization", `Bearer ${key}`);
  return { headers: h, url };
};

let db;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(TOKEN),
    hashKid: KID,
    prefix: "th_RRRR…RRRR",
    name: "Routing key",
    machineId: null,
    legacy: 0,
    isActive: 1,
    revokedAt: null,
    allowedModels: [],
    allowedCombos: [],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...patch,
  };
}

function insertConnection(id, provider, workspaceId, patch = {}) {
  const data = JSON.stringify({
    apiKey: `sk-${id}`,
    ...(patch.data || {}),
    ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "data")),
  });
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, 'apikey', ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      provider,
      id,
      patch.priority ?? 1,
      patch.isActive === false ? 0 : 1,
      data,
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM providerNodes; DELETE FROM combos; DELETE FROM workspaceSettings; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('u1', 'user', 'active', ?, ?)",
    [NOW, NOW],
  );
  for (const id of ["w1", "w2"]) {
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
    db.run(
      "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?, 'u1', 'member', ?)",
      [id, NOW],
    );
  }
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
});

describe("hashed gateway routing", () => {
  it("invalid presented bearer rejects with no upstream resolution", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const out = await resolveGatewayAuth(request({ key: `th_${"X".repeat(32)}` }));
    expect(out).toBeInstanceOf(Response);
    expect(out.status).toBe(401);
  });

  it("principal selects only its workspace provider connections", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-w2", "openai", "w2", { priority: 0 }); // higher priority, foreign
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    const conns = await getGatewayConnections(principal, { provider: "openai", isActive: true });
    expect(conns.map((c) => c.id)).toEqual(["conn-w1"]);
    // Exhausting the workspace connection never crosses into the foreign one.
    const creds = await getProviderCredentials("openai", new Set(["conn-w1"]), null, { principal });
    expect(creds).toBeNull();
    const selected = await getProviderCredentials("openai", new Set(), null, { principal });
    expect(selected.connectionId).toBe("conn-w1");
    expect(selected.apiKey).toBe("sk-conn-w1");
  });

  it("foreign x-connection-id pin is ignored under a principal (no cross-workspace credential)", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-w2", "openai", "w2");
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    const creds = await getProviderCredentials("openai", null, null, {
      principal,
      preferredConnectionId: "conn-w2",
    });
    expect(creds).toBeNull();
  });

  it("provider-node prefix resolution stays workspace-scoped", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const data = JSON.stringify({ prefix: "t1", baseUrl: "http://node1.test" });
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('node1', 'openai-compatible', 'n1', ?, ?, ?, 'w1', NULL)`,
      [data, NOW, NOW],
    );
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    const mine = await getModelInfo("t1/m", { principal });
    expect(mine).toEqual({ provider: "node1", model: "m" });
    const nodes = await getGatewayNodes(principal, {});
    expect(nodes.map((n) => n.id)).toEqual(["node1"]);
  });

  it("scope lists gate canonical models and combos by exact id", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({
        allowedModels: ["openai/gpt-4o"],
        allowedCombos: ["combo-id-1"],
      }),
    );
    db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
       VALUES('combo-id-1', 'combo-1', NULL, ?, ?, ?)`,
      [JSON.stringify(["openai/gpt-4o"]), NOW, NOW],
    );
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    expect(authorizeGatewayTarget(principal, { modelId: "openai/gpt-4o" })).toBeNull();
    expect(authorizeGatewayTarget(principal, { modelId: "openai/other" })?.status).toBe(403);
    expect(authorizeGatewayTarget(principal, { comboId: "combo-id-1" })).toBeNull();
    expect(authorizeGatewayTarget(principal, { comboId: "combo-id-2" })?.status).toBe(403);
    // Unrestricted principal (fresh key) keeps full access.
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ id: "key2", keyHash: digest(`th_${"S".repeat(32)}`) }),
    );
    // allowedCombos already [] — only combos list restriction differs below.
  });
});

describe("legacy parity", () => {
  it("legacy storage keeps requireClientApiKey semantics: invalid key 401, missing key 401", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.exec("DROP TABLE apiKeys");
    db.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
      isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
    // requireApiKey=true, no key rows: every presented key is invalid.
    const missing = await resolveGatewayAuth(request({}));
    expect(missing).toBeInstanceOf(Response);
    expect(missing.status).toBe(401);
    const invalid = await resolveGatewayAuth(request({ key: "th-whatever" }));
    expect(invalid).toBeInstanceOf(Response);
    expect(invalid.status).toBe(401);
    // A valid legacy raw key passes as legacy (no principal authority).
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('legacy1', ?, 'l', NULL, 1, ?)`,
      ["sk-legacy-raw", NOW],
    );
    const ok = await resolveGatewayAuth(request({ key: "sk-legacy-raw" }));
    expect(ok).toEqual({ principal: null, legacy: true });
    // requireApiKey=false: same request passes through as legacy (no principal).
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    const open = await resolveGatewayAuth(request({}));
    expect(open).toEqual({ principal: null, legacy: true });
  });
});

// ---------------------------------------------------------------------------
// True handler coverage: handleChat + combo probe under hashed principals.
// Executor seam is mocked, so `executeMock` call count == upstream call count.
// ---------------------------------------------------------------------------

const okUpstream = () => ({
  response: new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
  url: "https://fake.local/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

const chatRequest = (body, { key = TOKEN, url, headers = {} } = {}) =>
  new Request(url || "http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const msg = (content) => ({ model: "", messages: [{ role: "user", content }] });
const imgMsg = () => ({
  model: "",
  messages: [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    },
  ],
});

function setSettings(patch) {
  const cur = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1")?.data || "{}");
  db.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
    JSON.stringify({ ...cur, ...patch }),
  ]);
}

// YAN-364: aliases live under the workspace's ws:<id>/ kv prefix.
async function setModelAlias(alias, model) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [`ws:w1/${alias}`, JSON.stringify(model)],
  );
}

// YAN-364: a workspace principal reads its own id-keyed strategy row, never the
// name-keyed instance blob (no cross-workspace inheritance).
function setWorkspaceStrategies(workspaceId, comboStrategies) {
  db.run(
    `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
     ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data`,
    [workspaceId, JSON.stringify({ comboStrategies }), NOW],
  );
}

function insertCombo(id, name, models) {
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES(?, ?, NULL, ?, ?, ?, 'w1')`,
    [id, name, JSON.stringify(models), NOW, NOW],
  );
}

describe("hashed chat handler authorization", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue(okUpstream());
    loggedRaw.value = null;
  });

  it("positive: unrestricted key serves a canonical model through the real handler", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "openai/gpt-4o" }));
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).choices?.[0]?.message?.content).toBe("ok");
  });

  it("current MITM bearer routes only through Default without dashboard management authority", async () => {
    const internal = `th_mitm_${"M".repeat(32)}`;
    const headers = { "x-9r-peer-token": "peer", "x-9r-real-ip": "127.0.0.1" };
    db.run("UPDATE users SET instanceRole = 'owner' WHERE id = 'u1'");
    db.run("UPDATE workspaces SET name = 'Default' WHERE id = 'w1'");
    db.run("UPDATE memberships SET role = 'owner' WHERE workspaceId = 'w1' AND userId = 'u1'");
    db.run("INSERT INTO _meta(key,value) VALUES ('defaultWorkspaceId','w1')");
    setSettings({
      mitmInternalVerifier: crypto.createHash("sha256").update(internal).digest("hex"),
    });
    insertConnection("conn-default", "openai", "w1", { priority: 10 });
    insertConnection("conn-foreign", "openai", "w2", { priority: 1 });
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(0);

    const { principal, legacy } = await resolveGatewayAuth(request({ key: internal, headers }));
    expect(legacy).toBe(false);
    expect(principal).toMatchObject({
      via: "mitm",
      workspaceId: "w1",
      userId: "u1",
      apiKeyId: null,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(principal).not.toHaveProperty("instanceRole");
    expect((await requireGatewayWorkspace(principal)).workspaceId).toBe("w1");
    expect(
      (await getGatewayConnections(principal, { provider: "openai", isActive: true })).map(
        (c) => c.id,
      ),
    ).toEqual(["conn-default"]);
    expect(await getModelInfo("openai/gpt-4o", { principal })).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(
      await getProviderCredentials("openai", new Set(["conn-default"]), null, { principal }),
    ).toBeNull();
    expect(
      await getProviderCredentials("openai", null, null, {
        principal,
        preferredConnectionId: "conn-foreign",
      }),
    ).toBeNull();
    // Even advisory owner roles cannot turn the gateway-only via into management authority.
    await expect(
      listApiKeys({ ...principal, instanceRole: "owner", workspaceRoles: { w1: "owner" } }, "w1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const res = await handleChat(
      chatRequest({ ...msg("hi"), model: "openai/gpt-4o" }, { key: internal, headers }),
    );
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].credentials).toMatchObject({
      connectionId: "conn-default",
      apiKey: "sk-conn-default",
    });
    expect((await res.json()).choices?.[0]?.message?.content).toBe("ok");
  });

  it("forbidden canonical model: 403, zero upstream", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-4o"] }));
    insertConnection("conn-w1", "openai", "w1");
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "anthropic/claude-3" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("aliases canonicalize before the scope check (allowed passes, denied 403 zero upstream)", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-4o"] }));
    insertConnection("conn-w1", "openai", "w1");
    await setModelAlias("fast", "openai/gpt-4o");
    await setModelAlias("fancy", "anthropic/claude-3");
    const ok = await handleChat(chatRequest({ ...msg("hi"), model: "fast" }));
    expect(ok.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const denied = await handleChat(chatRequest({ ...msg("hi"), model: "fancy" }));
    expect(denied.status).toBe(403);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("requested combo outside allowedCombos: 403, zero upstream", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedCombos: ["combo-yes"] }));
    insertCombo("combo-no", "nope", ["openai/gpt-4o"]);
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "nope" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("combo member denial skips ahead to an allowed member (no upstream for the denied one)", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o"], allowedCombos: ["c1"] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertCombo("c1", "combo1", ["anthropic/claude-3", "openai/gpt-4o"]);
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "combo1" }));
    expect(res.status).toBe(200);
    // Exactly one upstream call, for the allowed member (executor body is the
    // provider-shaped request: provider prefix stripped).
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].body.model).toBe("gpt-4o");
  });

  it("combo with every member denied: 403, zero upstream", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["x/y"], allowedCombos: ["c1"] }));
    insertCombo("c1", "combo1", ["anthropic/claude-3", "openai/gpt-4o"]);
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "combo1" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("nested combo outside allowedCombos is skipped, outer allowed member serves", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o"], allowedCombos: ["outer"] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertCombo("inner", "innerc", ["anthropic/claude-3"]);
    insertCombo("outer", "outerc", ["innerc", "openai/gpt-4o"]);
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "outerc" }));
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("fusion judge outside allowedModels: 403 before any panel call, zero upstream", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({
        allowedModels: ["openai/gpt-4o", "anthropic/claude-x"],
        allowedCombos: ["f1"],
      }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-a1", "anthropic", "w1");
    insertCombo("f1", "fusionc", ["openai/gpt-4o", "anthropic/claude-x"]);
    setSettings({
      comboStrategies: {
        fusionc: { fallbackStrategy: "fusion", judgeModel: "anthropic/claude-j" },
      },
    });
    setWorkspaceStrategies("w1", {
      f1: { fallbackStrategy: "fusion", judgeModel: "anthropic/claude-j" },
    });
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "fusionc" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("fusion panel member denial drops the member; remaining allowed panel answers", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o"], allowedCombos: ["f1"] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertCombo("f1", "fusionc", ["openai/gpt-4o", "anthropic/claude-x"]);
    setSettings({ comboStrategies: { fusionc: { fallbackStrategy: "fusion" } } });
    setWorkspaceStrategies("w1", { f1: { fallbackStrategy: "fusion" } });
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "fusionc" }));
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("fusion with every panel member denied: 403, zero upstream", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["z/z"], allowedCombos: ["f1"] }));
    insertCombo("f1", "fusionc", ["anthropic/claude-x", "openai/gpt-4o"]);
    setSettings({ comboStrategies: { fusionc: { fallbackStrategy: "fusion" } } });
    setWorkspaceStrategies("w1", { f1: { fallbackStrategy: "fusion" } });
    const res = await handleChat(chatRequest({ ...msg("hi"), model: "fusionc" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("capacity adapter never turns a denied requested model into a fallback permit: 403, zero upstream", async () => {
    // deepseek-chat has no vision; the vision pool adds openai/gpt-4o. The
    // REQUESTED model is out of scope, so the adapter must not serve instead.
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-4o"] }));
    insertConnection("conn-w1", "openai", "w1");
    setSettings({ capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o"] } } });
    const res = await handleChat(chatRequest({ ...imgMsg(), model: "deepseek/deepseek-chat" }));
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("capacity adapter serves when both the adapter member and the requested model are in scope", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o", "deepseek/deepseek-chat"] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    setSettings({ capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o"] } } });
    const res = await handleChat(chatRequest({ ...imgMsg(), model: "deepseek/deepseek-chat" }));
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("hashed capture is sanitized: cookie and bearer redacted, ?key= stripped from url", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    const res = await handleChat(
      chatRequest(
        { ...msg("hi"), model: "openai/gpt-4o" },
        {
          url: "http://localhost/v1/chat/completions?x=1&key=th_SECRETCARRIER",
          headers: { cookie: "auth_token=dashboard-session" },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(loggedRaw.value).not.toBeNull();
    expect(loggedRaw.value.headers.cookie).toBe("[REDACTED]");
    expect(loggedRaw.value.headers.authorization).toBe("[REDACTED]");
    expect(loggedRaw.value.endpoint).not.toContain("th_SECRETCARRIER");
  });
});

describe("sanitizeGatewayCapture units", () => {
  it("redacts every gateway secret carrier incl. cookie, and query key in urls", () => {
    const out = sanitizeGatewayCapture({
      headers: new Headers({
        authorization: "Bearer th_x",
        "x-api-key": "a",
        "x-goog-api-key": "g",
        "x-9r-cli-token": "c",
        "x-9r-peer-token": "p",
        cookie: "auth_token=s",
        "content-type": "application/json",
      }),
      url: "http://localhost/v1/chat/completions?x=1&key=th_SECRET",
    });
    const h = Object.fromEntries(out.headers);
    expect(h.authorization).toBe("[REDACTED]");
    expect(h["x-api-key"]).toBe("[REDACTED]");
    expect(h["x-goog-api-key"]).toBe("[REDACTED]");
    expect(h["x-9r-cli-token"]).toBe("[REDACTED]");
    expect(h["x-9r-peer-token"]).toBe("[REDACTED]");
    expect(h.cookie).toBe("[REDACTED]");
    expect(h["content-type"]).toBe("application/json");
    expect(new URL(out.url).searchParams.get("key")).toBe("[REDACTED]");
    expect(new URL(out.url).searchParams.get("x")).toBe("1");
  });
});

describe("gatewayKeyContext attribution", () => {
  it("keyless authenticated principal keeps owner+Default attribution with apiKeyId null", () => {
    // CLI/local owner principal shape (ownerPrincipal in gatewayAuth.js).
    const keyless = Object.freeze({
      userId: "u1",
      workspaceId: "w1",
      apiKeyId: null,
      scopes: Object.freeze({
        allowedModels: Object.freeze([]),
        allowedCombos: Object.freeze([]),
      }),
      via: "local",
    });
    expect(gatewayKeyContext(keyless)).toEqual({
      apiKeyId: null,
      workspaceId: "w1",
      userId: "u1",
    });
  });

  it("key principal carries its apiKeyId; legacy null principal stays null", () => {
    const keyed = Object.freeze({
      userId: "u1",
      workspaceId: "w1",
      apiKeyId: "key1",
      scopes: Object.freeze({
        allowedModels: Object.freeze([]),
        allowedCombos: Object.freeze([]),
      }),
      via: "apiKey",
    });
    expect(gatewayKeyContext(keyed).apiKeyId).toBe("key1");
    expect(gatewayKeyContext(null)).toBeNull();
    expect(gatewayKeyContext(undefined)).toBeNull();
  });
});

describe("combo probe under hashed storage", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue(okUpstream());
    resetProbeRateLimit();
  });

  it("probe with an authorized principal runs the real pipeline and serves", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedCombos: ["c1"] }));
    insertConnection("conn-w1", "openai", "w1");
    insertCombo("c1", "probec", ["openai/gpt-4o"]);
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    const result = await runComboProbe({ comboId: "c1", principal });
    expect(result.served?.outcome).toBe("served");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("principal-less probe refuses on hashed storage (no owner/all-connection escalation)", async () => {
    // No owner user, no defaultWorkspaceId: nothing derives, nothing bypasses.
    insertCombo("c1", "probec", ["openai/gpt-4o"]);
    await expect(runComboProbe({ comboId: "c1" })).rejects.toMatchObject({ status: 503 });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("scoped principal denied the combo surfaces the probe 403, zero upstream", async () => {
    insertCombo("c1", "probec", ["openai/gpt-4o"]);
    const scoped = Object.freeze({
      userId: "u1",
      workspaceId: "w1",
      apiKeyId: "key1",
      scopes: Object.freeze({
        allowedModels: Object.freeze([]),
        allowedCombos: Object.freeze(["some-other-combo"]),
      }),
      via: "apiKey",
    });
    await expect(runComboProbe({ comboId: "c1", principal: scoped })).rejects.toMatchObject({
      status: 403,
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("authenticated management caller derives a live Default-workspace probe principal", async () => {
    db.run(
      `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('owner1', 'owner', 'active', ?, ?)`,
      [NOW, NOW],
    );
    db.run(`INSERT INTO _meta(key, value) VALUES ('defaultWorkspaceId', 'w1')`);
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('w1', 'owner1', 'manager', ?)`,
      [NOW],
    );
    insertConnection("conn-w1", "openai", "w1");
    insertCombo("c1", "probec", ["openai/gpt-4o"]);
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({ sub: "owner1", sv: 1 });
    const result = await runComboProbe({
      comboId: "c1",
      request: { headers: new Headers(), cookies: { get: () => ({ value: token }) } },
    });
    expect(result.served?.outcome).toBe("served");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
