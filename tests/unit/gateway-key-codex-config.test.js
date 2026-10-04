import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTOML, stringifyTOML } from "confbox";
import { getAdapter } from "@/lib/db/driver.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearHome, load, post, read, restoreBrand, write } from "../helpers/cliToolsBrand.js";

const master = Buffer.alloc(32, 7);
const secret = "sentinel-local-gateway-secret";
const rel = ".codex/config.toml";
let db;
let route;
const seed = () =>
  write(
    rel,
    stringifyTOML({
      model: "old",
      model_provider: "tokenhop",
      model_providers: {
        tokenhop: {
          base_url: "http://localhost:20128/v1",
          http_headers: { Authorization: `Bearer ${secret}` },
        },
        openai: {
          base_url: "https://api.openai.com/v1",
          http_headers: { Authorization: "Bearer unrelated-openai" },
        },
      },
    }),
  );
const apply = (body = {}) =>
  route.POST(post({ baseUrl: "http://localhost:20128", model: "new", ...body }));
const auth = (key) =>
  write(
    ".codex/auth.json",
    JSON.stringify({ OPENAI_API_KEY: key, auth_mode: "apikey", other: "keep" }),
  );

beforeEach(async () => {
  await clearHome([".codex"]);
  route = await load("tokenhop", "codex-settings");
  db = await getAdapter();
  db.run("DELETE FROM apiKeys");
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    masterKeyId(master),
  ]);
  vi.stubEnv("TOKENHOP_MASTER_KEY", master.toString("base64"));
  await seed();
});
afterEach(() => {
  vi.unstubAllEnvs();
  restoreBrand();
});

describe("Codex hashed client config", () => {
  it("GET sanitizes local headers without touching disk or unrelated providers", async () => {
    const before = await read(rel);
    const res = await route.GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      storage: "hashed",
      credentialConfigured: true,
      installed: true,
      hasTokenhop: true,
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(parseTOML(body.config).model_providers.openai.http_headers.Authorization).toBe(
      "Bearer unrelated-openai",
    );
    expect(await read(rel)).toBe(before);
  });
  it("model-only edit retains targeted on-disk secret", async () => {
    const res = await apply();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(secret);
    const config = parseTOML(await read(rel));
    expect(config.model).toBe("new");
    expect(config.model_providers.tokenhop.http_headers.Authorization).toBe(`Bearer ${secret}`);
  });
  it("changed destination without replacement refuses without mutation", async () => {
    const before = await read(rel);
    const res = await apply({ baseUrl: "https://different.example" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(secret);
    expect(await read(rel)).toBe(before);
  });
  it("explicit replacement writes intended config", async () => {
    const res = await apply({ baseUrl: "https://different.example", apiKey: "replacement" });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("replacement");
    const config = parseTOML(await read(rel));
    expect(config.model_providers.tokenhop.base_url).toBe("https://different.example/v1");
    expect(config.model_providers.tokenhop.http_headers.Authorization).toBe("Bearer replacement");
  });
  it("legacy GET remains byte-exact and POST still requires apiKey", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    expect((await (await route.GET()).json()).config).toBe(await read(rel));
    expect((await apply()).status).toBe(400);
    expect((await apply({ apiKey: "legacy-key" })).status).toBe(200);
  });
  it.each([null, "2026-10-04T00:00:00.000Z"])(
    "cleans inactive local auth credential, revokedAt=%s",
    async (revokedAt) => {
      db.run(
        "INSERT INTO apiKeys(id, workspaceId, keyHash, hashKid, prefix, name, isActive, revokedAt, createdAt) VALUES (?, 'w', ?, ?, 'test', 'local', 0, ?, '2026-10-04T00:00:00.000Z')",
        ["local", hashApiKey(secret, deriveApiKeyHashKey(master)), masterKeyId(master), revokedAt],
      );
      await auth(secret);
      expect((await route.DELETE()).status).toBe(200);
      expect(JSON.parse(await read(".codex/auth.json"))).toEqual({ other: "keep" });
    },
  );
  it("preserves unrelated OpenAI auth key", async () => {
    await auth("sk-tokenhop-looking-but-unrelated");
    const before = await read(".codex/auth.json");
    expect((await route.DELETE()).status).toBe(200);
    expect(await read(".codex/auth.json")).toBe(before);
  });
  it("master failure preserves auth key", async () => {
    await auth(secret);
    vi.stubEnv("TOKENHOP_MASTER_KEY", "invalid");
    const before = await read(".codex/auth.json");
    expect((await route.DELETE()).status).toBe(200);
    expect(await read(".codex/auth.json")).toBe(before);
  });
});
