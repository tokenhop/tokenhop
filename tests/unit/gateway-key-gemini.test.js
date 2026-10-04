// Gemini runtime gateway auth: native TTS passthrough + translated chat path.
// Real resolveGatewayAuth/getModelInfo/getProviderCredentials against a hashed
// fixture (same shape as gateway-key-routing.test.js); only handleChat and the
// Google upstream fetch are mocked. Zero upstream on any denial.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

const NOW = "2026-10-04T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"G".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const CHAT_MODEL = "gemini-2.5-flash";
const audioBody = () => ({
  contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
  generationConfig: { responseModalities: ["AUDIO"] },
});
const chatBody = () => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
});

const post = (modelPath, body, { key = TOKEN, keyInQuery = false, headers = {} } = {}) => {
  const url = `http://localhost/v1beta/models/${modelPath}${keyInQuery ? `${modelPath.includes("?") ? "&" : "?"}key=${key}` : ""}`;
  const h = { "Content-Type": "application/json", ...headers };
  if (key && !keyInQuery) h.Authorization = `Bearer ${key}`;
  return new Request(url, { method: "POST", headers: h, body: JSON.stringify(body) });
};
const paramsFor = (modelPath) => ({ params: Promise.resolve({ path: [modelPath] }) });

let db;
let realFetch;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(TOKEN),
    hashKid: KID,
    prefix: "th_GGGG…GGGG",
    name: "Gemini key",
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

function insertConnection(id, provider, workspaceId) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, 'apikey', ?, NULL, 1, 1, ?, ?, ?, ?, NULL)`,
    [id, provider, id, JSON.stringify({ apiKey: `sk-${id}` }), NOW, NOW, workspaceId],
  );
}

function resetHashedSchema() {
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
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM providerNodes; DELETE FROM combos; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
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
}

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  resetHashedSchema();
  vi.clearAllMocks();
  mocks.handleChat.mockResolvedValue(
    Response.json({ candidates: [{ content: { parts: [{ text: "chat" }] } }] }),
  );
  realFetch = global.fetch;
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
});

describe("gemini native passthrough auth", () => {
  it("own-workspace key reaches upstream with its workspace credential", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    insertConnection("conn-w2", "gemini", "w2");
    const res = await POST(
      post(`${TTS_MODEL}:generateContent`, audioBody()),
      paramsFor(`${TTS_MODEL}:generateContent`),
    );
    expect(res.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
    );
    expect(options.headers["x-goog-api-key"]).toBe("sk-conn-w1");
  });

  it("foreign workspace key gets no credential and never fetches", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w2", "gemini", "w2");
    const res = await POST(
      post(`${TTS_MODEL}:generateContent`, audioBody()),
      paramsFor(`${TTS_MODEL}:generateContent`),
    );
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("allowedModels denial precedes any credential lookup or fetch", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-4o"] }));
    insertConnection("conn-w1", "gemini", "w1");
    const res = await POST(
      post(`${TTS_MODEL}:generateContent`, audioBody()),
      paramsFor(`${TTS_MODEL}:generateContent`),
    );
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("invalid presented key is 401 with no fallback, even beside CLI carriers", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    const req = post(`${TTS_MODEL}:generateContent`, audioBody(), {
      key: `th_${"X".repeat(32)}`,
      keyInQuery: true,
      headers: { "x-9r-cli-token": "valid-cli", cookie: "owner-session" },
    });
    const res = await POST(req, paramsFor(`${TTS_MODEL}:generateContent`));
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("query ?key= client key authorizes and is stripped from the upstream URL", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    const req = post(`${TTS_MODEL}:generateContent?alt=sse`, audioBody(), {
      key: TOKEN,
      keyInQuery: true,
    });
    const res = await POST(req, paramsFor(`${TTS_MODEL}:generateContent`));
    expect(res.status).toBe(200);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?alt=sse`,
    );
    expect(url).not.toContain("key=");
    expect(options.headers["x-goog-api-key"]).toBe("sk-conn-w1");
  });
});

describe("gemini translated chat auth", () => {
  it("threads the authorized principal and preserves carriers, no synthesized CLI headers", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    const req = post(`${CHAT_MODEL}:generateContent`, chatBody());
    const res = await POST(req, paramsFor(`${CHAT_MODEL}:generateContent`));
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    const [forwarded, , options] = mocks.handleChat.mock.calls[0];
    expect(options.principal).toMatchObject({ apiKeyId: "key1", workspaceId: "w1", via: "apiKey" });
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(forwarded.headers.get("x-9r-cli-token")).toBeNull();
    expect(await forwarded.json()).toMatchObject({ model: CHAT_MODEL });
    // Legacy passthrough shape preserved: native-format body passes through untouched.
    expect(await res.json()).toEqual({ candidates: [{ content: { parts: [{ text: "chat" }] } }] });
  });

  it("query ?key= survives into the translated request", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const req = post(`${CHAT_MODEL}:generateContent`, chatBody(), { key: TOKEN, keyInQuery: true });
    const res = await POST(req, paramsFor(`${CHAT_MODEL}:generateContent`));
    expect(res.status).toBe(200);
    const [forwarded, , options] = mocks.handleChat.mock.calls[0];
    expect(new URL(forwarded.url).searchParams.get("key")).toBe(TOKEN);
    expect(options.principal).toMatchObject({ apiKeyId: "key1", workspaceId: "w1" });
  });

  it("scope denial on the canonical translated model precedes handleChat", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-4o"] }));
    const res = await POST(
      post(`${CHAT_MODEL}:generateContent`, chatBody()),
      paramsFor(`${CHAT_MODEL}:generateContent`),
    );
    expect(res.status).toBe(403);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("invalid translated key is 401 before any routing", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const res = await POST(
      post(`${CHAT_MODEL}:generateContent`, chatBody(), { key: `th_${"X".repeat(32)}` }),
      paramsFor(`${CHAT_MODEL}:generateContent`),
    );
    expect(res.status).toBe(401);
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });
});

describe("gemini legacy storage parity", () => {
  it("valid legacy raw key routes without principal scoping", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.exec("DROP TABLE apiKeys");
    db.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
      isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('legacy1', ?, 'l', NULL, 1, ?)`,
      ["sk-legacy-raw", NOW],
    );
    insertConnection("conn-legacy", "gemini", "w1");
    const req = post(`${TTS_MODEL}:generateContent`, audioBody(), { key: "sk-legacy-raw" });
    const res = await POST(req, paramsFor(`${TTS_MODEL}:generateContent`));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("sk-conn-legacy");
    const bad = await POST(
      post(`${TTS_MODEL}:generateContent`, audioBody(), { key: "nope" }),
      paramsFor(`${TTS_MODEL}:generateContent`),
    );
    expect(bad.status).toBe(401);
  });
});
