// YAN-363 gateway utility routes (voices / models/info / count_tokens):
// hashed principals only ever see their own workspace's voice credentials,
// model info respects the key allowlist, count_tokens stays a pure estimator,
// and legacy storage keeps the exact prior delegation behavior.
// External network is stubbed at the fetcher seam; the DB fixture is real.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchVoicesMock, dashboardVoicesMock, fetchMock } = vi.hoisted(() => ({
  fetchVoicesMock: vi.fn(),
  dashboardVoicesMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// Upstream fetch seam for credentialed voices (no live network).
// deepgram/inworld use the route's own fetchUpstream; stub global fetch.
vi.stubGlobal("fetch", fetchMock);
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({
  fetchElevenLabsVoices: fetchVoicesMock,
  VOICE_FETCHERS: {
    "edge-tts": async () => [
      {
        ShortName: "en-US-AriaNeural",
        FriendlyName: "Microsoft Aria Online (Natural) - English (United States)",
        Locale: "en-US",
        Gender: "Female",
      },
      {
        ShortName: "fr-FR-DeniseNeural",
        FriendlyName: "Microsoft Denise Online (Natural) - French (France)",
        Locale: "fr-FR",
        Gender: "Female",
      },
    ],
    "local-device": async () => [{ id: "voice-a", name: "Voice A", lang: "en", gender: "" }],
  },
}));

// Legacy delegation target: in-process dashboard handler, stubbed so the
// delegation mapping itself (path, status passthrough, shape) is what's under test.
vi.mock("../../src/app/api/media-providers/tts/elevenlabs/voices/route.js", () => ({
  GET: dashboardVoicesMock,
}));

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { GET as getVoices } from "@/app/api/v1/audio/voices/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";
import { POST as countTokens } from "@/app/api/v1/messages/count_tokens/route.js";

const NOW = "2026-10-04T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"V".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

let db;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(TOKEN),
    hashKid: KID,
    prefix: "th_VVVV…VVVV",
    name: "Utility key",
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
    ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "data")),
    ...(patch.data || {}),
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

function installHashedTable() {
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
}

function installLegacyTable() {
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
    isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
}

function setSettings(patch) {
  const cur = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1")?.data || "{}");
  db.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
    JSON.stringify({ ...cur, ...patch }),
  ]);
}

const bearer = (url, key, init = {}) =>
  new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM providerNodes; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
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
  installHashedTable();
  fetchVoicesMock.mockReset();
  dashboardVoicesMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("voices under hashed principals", () => {
  const url = "http://localhost/v1/audio/voices?provider=elevenlabs";

  it("fetches voices with the principal's own workspace credential, never a foreign one", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "elevenlabs", "w1");
    insertConnection("conn-w2", "elevenlabs", "w2", { priority: 0 }); // foreign, higher priority
    fetchVoicesMock.mockResolvedValue([
      {
        voice_id: "v1",
        name: "Voice One",
        labels: { gender: "neutral", language: "en" },
        category: "premade",
      },
    ]);
    const res = await getVoices(bearer(url, TOKEN));
    expect(res.status).toBe(200);
    expect(fetchVoicesMock).toHaveBeenCalledTimes(1);
    expect(fetchVoicesMock).toHaveBeenCalledWith("sk-conn-w1");
    const data = await res.json();
    expect(data.object).toBe("list");
    expect(data.data).toHaveLength(1);
    expect(data.data[0].id).toBe("v1");
    expect(data.data[0].model.endsWith("/v1")).toBe(true);
  });

  it("credentialed provider with no workspace connection: 400, zero upstream fetch", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w2", "elevenlabs", "w2"); // foreign workspace only
    const res = await getVoices(bearer(url, TOKEN));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("connection");
    expect(fetchVoicesMock).not.toHaveBeenCalled();
  });

  it("invalid bearer rejects 401 even with requireApiKey disabled", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    setSettings({ requireApiKey: false });
    const res = await getVoices(bearer(url, `th_${"X".repeat(32)}`));
    expect(res.status).toBe(401);
    expect(fetchVoicesMock).not.toHaveBeenCalled();
  });

  it("key scoped to an unrelated provider/model: 403, zero upstream fetch or catalog disclosure", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-5.4"] }));
    insertConnection("conn-w1", "elevenlabs", "w1");
    const res = await getVoices(bearer(url, TOKEN));
    expect(res.status).toBe(403);
    expect(fetchVoicesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("key scoped to one elevenlabs voice sees only that voice after upstream fetch", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["elevenlabs/v1"] }));
    insertConnection("conn-w1", "elevenlabs", "w1");
    fetchVoicesMock.mockResolvedValue([
      {
        voice_id: "v1",
        name: "Voice One",
        labels: { gender: "neutral", language: "en" },
        category: "premade",
      },
      {
        voice_id: "v2",
        name: "Voice Two",
        labels: { gender: "neutral", language: "en" },
        category: "premade",
      },
    ]);
    const res = await getVoices(bearer(url, TOKEN));
    expect(res.status).toBe(200);
    expect(fetchVoicesMock).toHaveBeenCalledWith("sk-conn-w1");
    expect((await res.json()).data.map((v) => v.id)).toEqual(["v1"]);
  });

  it("deepgram: scoped key filters tts models; unrelated key 403 before fetch", async () => {
    const dg = "http://localhost/v1/audio/voices?provider=deepgram";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        tts: [
          { canonical_name: "aura-1", name: "Aura 1", languages: ["en"], metadata: { tags: [] } },
          { canonical_name: "aura-2", name: "Aura 2", languages: ["en"], metadata: { tags: [] } },
        ],
      }),
    });

    // Unrelated scope: no fetch, no catalog disclosure.
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-5.4"] }));
    insertConnection("conn-w1", "deepgram", "w1");
    expect((await getVoices(bearer(dg, TOKEN))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    // Scoped to one deepgram tts model: fetch runs, catalog filtered to it.
    insertHashedApiKeySync(
      db,
      hashedKeyRow({
        id: "key2",
        keyHash: digest(`th_${"W".repeat(32)}`),
        allowedModels: ["deepgram/aura-1"],
      }),
    );
    const res = await getVoices(bearer(dg, `th_${"W".repeat(32)}`));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.map((v) => v.id)).toEqual(["aura-1"]);
  });

  it("inworld: scoped tts model accesses the full voice catalog (voices are not model identities)", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["inworld/inworld-tts-1.5-mini"] }));
    insertConnection("conn-w1", "inworld", "w1");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          { voiceId: "wavenet-a", displayName: "Wave A", gender: "Male", languages: ["en"] },
          { voiceId: "wavenet-b", displayName: "Wave B", gender: "Female", languages: ["en"] },
        ],
      }),
    });
    const res = await getVoices(bearer("http://localhost/v1/audio/voices?provider=inworld", TOKEN));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.map((v) => v.id).sort()).toEqual(["wavenet-a", "wavenet-b"]);
  });

  it("edge-tts: scoped voice model accesses only that voice, no credential needed", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["edge-tts/en-US-AriaNeural"] }));
    const res = await getVoices(
      bearer("http://localhost/v1/audio/voices?provider=edge-tts", TOKEN),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((v) => v.id)).toEqual(["en-US-AriaNeural"]);
  });

  it("edge-tts: unrelated key 403 before any catalog fetch", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-5.4"] }));
    const res = await getVoices(
      bearer("http://localhost/v1/audio/voices?provider=edge-tts", TOKEN),
    );
    expect(res.status).toBe(403);
  });
});

describe("voices legacy delegation", () => {
  it("legacy storage delegates in-process to the dashboard handler and maps its result unchanged", async () => {
    installLegacyTable();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('legacy1', 'sk-legacy-raw', 'l', NULL, 1, ?)`,
      [NOW],
    );
    dashboardVoicesMock.mockResolvedValue(
      Response.json({
        byLang: {
          en: { code: "en", name: "English", voices: [{ id: "lv", name: "Legacy Voice" }] },
        },
      }),
    );
    const res = await getVoices(
      bearer("http://localhost/v1/audio/voices?provider=elevenlabs", "sk-legacy-raw"),
    );
    expect(res.status).toBe(200);
    // Delegation target is the in-process dashboard route under /api/media-providers.
    const delegatedUrl = new URL(dashboardVoicesMock.mock.calls[0][0].url);
    expect(delegatedUrl.pathname).toBe("/api/media-providers/tts/elevenlabs/voices");
    const data = await res.json();
    expect(data.data[0]).toMatchObject({ id: "lv", name: "Legacy Voice" });
    expect(data.data[0].model.endsWith("/lv")).toBe(true);
  });

  it("upstream dashboard error status and message pass through", async () => {
    installLegacyTable();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES ('legacy1', 'sk-legacy-raw', 'l', NULL, 1, ?)`,
      [NOW],
    );
    dashboardVoicesMock.mockResolvedValue(
      Response.json({ error: "upstream down" }, { status: 503 }),
    );
    const res = await getVoices(
      bearer("http://localhost/v1/audio/voices?provider=elevenlabs", "sk-legacy-raw"),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe("upstream down");
  });
});

describe("models/info allowlist", () => {
  const url = (id) => `http://localhost/v1/models/info?id=${encodeURIComponent(id)}`;

  it("restricted key: allowed model 200, out-of-scope model 403", async () => {
    insertHashedApiKeySync(db, hashedKeyRow({ allowedModels: ["openai/gpt-5.4"] }));
    const ok = await getModelInfo(bearer(url("openai/gpt-5.4"), TOKEN));
    expect(ok.status).toBe(200);
    const info = await ok.json();
    expect(info.id).toBe("openai/gpt-5.4");
    expect(info.endpoint).toBe("/v1/chat/completions");
    const denied = await getModelInfo(bearer(url("anthropic/claude-3-5-sonnet-20241022"), TOKEN));
    expect(denied.status).toBe(403);
  });

  it("unrestricted key reads any known model", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const res = await getModelInfo(bearer(url("openai/gpt-5.4"), TOKEN));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("openai/gpt-5.4");
  });
});

describe("count_tokens", () => {
  it("authenticated request returns a positive deterministic estimate", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const body = { system: "abcd", messages: [{ role: "user", content: "hi!" }] };
    const res = await countTokens(
      bearer("http://localhost/v1/messages/count_tokens", TOKEN, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    // 4 system chars + 3 content chars → ceil(7/4) = 2.
    expect(await res.json()).toEqual({ input_tokens: 2 });
  });

  it("invalid bearer 401 before estimation", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const res = await countTokens(
      bearer("http://localhost/v1/messages/count_tokens", `th_${"X".repeat(32)}`, {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
