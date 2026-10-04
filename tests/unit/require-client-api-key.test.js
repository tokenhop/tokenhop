// /v1 routes without a handler-level check must still enforce requireApiKey
// (local callers bypass the middleware), and /v1/audio/voices must not
// self-fetch the login-gated /api/media-providers routes.
// Uses the real isolated test DB in legacy storage shape: requireClientApiKey
// delegates to shared resolveGatewayAuth, which reads actual repositories —
// so settings + legacy apiKeys rows are seeded, not mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "cli-token"),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  VOICE_FETCHERS: {
    "edge-tts": async () => [
      { ShortName: "en-US-AvaNeural", FriendlyName: "Ava", Locale: "en-US", Gender: "Female" },
    ],
  },
}));

const { requireClientApiKey } = await import("@/lib/auth/requireClientApiKey");
const { GET: getVoices } = await import("@/app/api/v1/audio/voices/route.js");

const NOW = "2026-10-04T00:00:00.000Z";
const req = (headers = {}, url = "http://localhost/v1/models") => new Request(url, { headers });

let db;

beforeEach(async () => {
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  // Force legacy storage: no hashed markers, legacy-shape apiKeys table.
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
    isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    ["legacy1", "sk-good", "test", null, 1, NOW],
  );
});

describe("requireClientApiKey", () => {
  it("allows everything when requireApiKey is off", async () => {
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    expect(await requireClientApiKey(req())).toBeNull();
  });

  it("rejects missing and invalid keys with 401", async () => {
    expect((await requireClientApiKey(req())).status).toBe(401);
    expect((await requireClientApiKey(req({ Authorization: "Bearer sk-bad" }))).status).toBe(401);
  });

  it("accepts a valid key or the local CLI token", async () => {
    expect(await requireClientApiKey(req({ Authorization: "Bearer sk-good" }))).toBeNull();
    expect(await requireClientApiKey(req({ "x-9r-cli-token": "cli-token" }))).toBeNull();
  });
});

describe("GET /v1/audio/voices", () => {
  it("returns 401 without a key", async () => {
    const res = await getVoices(req({}, "http://localhost/v1/audio/voices?provider=edge-tts"));
    expect(res.status).toBe(401);
  });

  it("lists voices in-process with a valid key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await getVoices(
      req({ "x-api-key": "sk-good" }, "http://localhost/v1/audio/voices?provider=edge-tts"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].model).toBe("edge-tts/en-US-AvaNeural");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
