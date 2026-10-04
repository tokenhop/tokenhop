import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { getCliToken, CLI_TOKEN_HEADER } from "@/lib/auth/cliToken.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import {
  authorizeGatewayTarget,
  gatewayKeyContext,
  resolveGatewayAuth,
  sanitizeGatewayCapture,
} from "@/lib/auth/gatewayAuth.js";

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"A".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

let db;
const row = (patch = {}) => ({
  id: "key",
  workspaceId: "w",
  userId: "u",
  createdByUserId: "u",
  keyHash: digest(TOKEN),
  hashKid: KID,
  prefix: "th_AAAA…AAAA",
  name: "Runner",
  machineId: null,
  legacy: 0,
  isActive: 1,
  revokedAt: null,
  allowedModels: ["openai/gpt-4o"],
  allowedCombos: ["combo-1"],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: NOW,
  ...patch,
});
const request = ({ key = null, headers = {}, url = "http://localhost/v1/chat" } = {}) => {
  const h = new Headers(headers);
  if (key) h.set("authorization", `Bearer ${key}`);
  return { headers: h, url };
};

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
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
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
  );
  for (const id of ["u", "manager"])
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
      [id, NOW, NOW],
    );
  db.run(
    "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('w','w','shared', ?, ?)",
    [NOW, NOW],
  );
  db.run("INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES ('w','u','member',?)", [
    NOW,
  ]);
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('owner', 'owner', 'active', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('default','Default','shared', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES ('default','owner','owner',?)",
    [NOW],
  );
  db.run("INSERT OR REPLACE INTO _meta(key,value) VALUES ('defaultWorkspaceId','default')");
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
});

describe("resolveGatewayAuth", () => {
  it("resolves a hashed bearer to a key principal", async () => {
    insertHashedApiKeySync(db, row());
    const out = await resolveGatewayAuth(request({ key: TOKEN }));
    expect(out).toMatchObject({
      principal: { apiKeyId: "key", workspaceId: "w", userId: "u", via: "apiKey" },
      legacy: false,
    });
  });

  it("bearer wins over a simultaneously valid CLI token; owner cookie never widens it", async () => {
    insertHashedApiKeySync(db, row());
    const cli = await getCliToken();
    const out = await resolveGatewayAuth(
      request({ key: `th_${"B".repeat(32)}`, headers: { [CLI_TOKEN_HEADER]: cli } }),
    );
    expect(out).toBeInstanceOf(Response);
    expect(out.status).toBe(401);
    expect((await resolveGatewayAuth(request({ key: TOKEN }))).principal).not.toHaveProperty(
      "instanceRole",
    );
  });

  it("invalid presented key rejects even when keys are not required", async () => {
    insertHashedApiKeySync(db, row());
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    const out = await resolveGatewayAuth(request({ key: `th_${"B".repeat(32)}` }));
    expect(out).toBeInstanceOf(Response);
    expect(out.status).toBe(401);
  });

  it("forged remote CLI peer is denied; proven-local keyless owner+Default resolves", async () => {
    insertHashedApiKeySync(db, row());
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    const cli = await getCliToken();
    const forged = await resolveGatewayAuth(
      request({
        headers: { [CLI_TOKEN_HEADER]: cli, "x-9r-peer-token": "peer", "x-9r-real-ip": "8.8.8.8" },
      }),
    );
    expect(forged).toBeInstanceOf(Response);
    expect(forged.status).toBe(401);

    db.run(
      "UPDATE settings SET data = json_set(data, '$.allowKeylessGatewayRequests', json('true')) WHERE id = 1",
    );
    const local = await resolveGatewayAuth(
      request({
        headers: {
          "x-9r-peer-token": "peer",
          "x-9r-real-ip": "127.0.0.1",
          host: "127.0.0.1",
        },
      }),
    );
    expect(local).toMatchObject({ principal: { via: "local" }, legacy: false });
  });

  it("empty bearer with a valid CLI token or direct-local keyless both 401", async () => {
    insertHashedApiKeySync(db, row());
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    const cli = await getCliToken();
    for (const headers of [
      { authorization: "Bearer ", [CLI_TOKEN_HEADER]: cli },
      {
        authorization: "Bearer ",
        "x-9r-peer-token": "peer",
        "x-9r-real-ip": "127.0.0.1",
        host: "127.0.0.1",
      },
      { "x-api-key": "" },
      { "x-goog-api-key": "" },
      {},
    ]) {
      const url = Object.keys(headers).length === 0 ? "http://localhost/v1/chat?key=" : undefined;
      const out = await resolveGatewayAuth(request({ headers, url }));
      expect(out).toBeInstanceOf(Response);
      expect(out.status).toBe(401);
    }
  });

  it("propagates storage-state errors instead of legacy fallback", async () => {
    db.run("DELETE FROM _meta WHERE key = 'apiKeysHashKid'");
    await expect(resolveGatewayAuth(request({ key: TOKEN }))).rejects.toThrow(
      expect.objectContaining({ code: "API_KEY_STATE_INVALID" }),
    );
  });
});

describe("authorizeGatewayTarget", () => {
  it("denies restricted models/combos, allows unrestricted lists", async () => {
    insertHashedApiKeySync(db, row());
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    expect(authorizeGatewayTarget(principal, { modelId: "openai/gpt-4o" })).toBeNull();
    expect(authorizeGatewayTarget(principal, { modelId: "other/model" })?.status).toBe(403);
    expect(authorizeGatewayTarget(principal, { comboId: "combo-1" })).toBeNull();
    expect(authorizeGatewayTarget(principal, { comboId: "combo-x" })?.status).toBe(403);
    insertHashedApiKeySync(
      db,
      row({
        id: "open",
        keyHash: digest(`th_${"C".repeat(32)}`),
        allowedModels: [],
        allowedCombos: [],
      }),
    );
    const { principal: open } = await resolveGatewayAuth(request({ key: `th_${"C".repeat(32)}` }));
    expect(authorizeGatewayTarget(open, { modelId: "anything/at-all" })).toBeNull();
    expect(authorizeGatewayTarget(open, { comboId: "anything" })).toBeNull();
  });
});

describe("gatewayKeyContext and sanitizeGatewayCapture", () => {
  it("exposes IDs only, never key material", async () => {
    insertHashedApiKeySync(db, row());
    const { principal } = await resolveGatewayAuth(request({ key: TOKEN }));
    expect(gatewayKeyContext(principal)).toEqual({
      apiKeyId: "key",
      workspaceId: "w",
      userId: "u",
    });
    expect(JSON.stringify(gatewayKeyContext(principal))).not.toContain(TOKEN);
    expect(gatewayKeyContext(null)).toBeNull();
  });

  it("redacts secret headers and the ?key= query without mutating input", async () => {
    const headers = new Headers({ authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN });
    const out = sanitizeGatewayCapture({ headers, url: "http://localhost/v1?key=secret" });
    expect(out.headers.get("authorization")).toBe("[REDACTED]");
    expect(out.headers.get("x-api-key")).toBe("[REDACTED]");
    expect(out.url).not.toContain("secret");
    expect(headers.get("authorization")).toContain(TOKEN);
  });

  it("redacts the trusted peer token and leaves the input untouched", () => {
    const headers = new Headers({ "x-9r-peer-token": "peer", "x-9r-real-ip": "127.0.0.1" });
    const out = sanitizeGatewayCapture({ headers });
    expect(out.headers.get("x-9r-peer-token")).toBe("[REDACTED]");
    expect(out.headers.get("x-9r-real-ip")).toBe("127.0.0.1");
    expect(headers.get("x-9r-peer-token")).toBe("peer");
    expect(JSON.stringify(out)).not.toContain('"peer"');
  });
});

// MITM internal credential is gateway-only: no dashboard/cookie/CLI fallback,
// no client key rows required; must be current and proven direct loopback.
describe("MITM internal credential", () => {
  const INTERNAL = `th_mitm_${"X".repeat(32)}`;
  const OLD = `th_mitm_${"Y".repeat(32)}`;
  const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const peer = { "x-9r-peer-token": "peer", "x-9r-real-ip": "127.0.0.1" };

  beforeEach(() => {
    db.run("UPDATE settings SET data = ? WHERE id = 1", [
      JSON.stringify({ requireApiKey: true, mitmInternalVerifier: hash(INTERNAL) }),
    ]);
  });

  it("current internal credential with trusted direct loopback resolves gateway-only owner+Default even with zero client keys", async () => {
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(0);
    const out = await resolveGatewayAuth(request({ key: INTERNAL, headers: peer }));
    expect(out).toEqual({
      principal: {
        userId: "owner",
        workspaceId: "default",
        apiKeyId: null,
        scopes: { allowedModels: [], allowedCombos: [] },
        via: "mitm",
      },
      legacy: false,
    });
    expect(out.principal).not.toHaveProperty("instanceRole"); // no dashboard authority
  });

  it("old/rotated internal credential is 401, no keyless/CLI fallback", async () => {
    expect((await resolveGatewayAuth(request({ key: OLD, headers: peer }))).status).toBe(401);
    db.run("UPDATE settings SET data = ? WHERE id = 1", [
      JSON.stringify({ requireApiKey: true, mitmInternalVerifier: hash(OLD) }),
    ]);
    expect((await resolveGatewayAuth(request({ key: INTERNAL, headers: peer }))).status).toBe(401);
    expect((await resolveGatewayAuth(request({ key: OLD, headers: peer }))).principal.via).toBe(
      "mitm",
    );
  });

  it.each([
    {},
    { host: "localhost", "x-9r-real-ip": "127.0.0.1" },
    { "x-9r-peer-token": "forged", "x-9r-real-ip": "127.0.0.1" },
    { "x-9r-peer-token": "peer", "x-9r-real-ip": "203.0.113.5" },
    { ...peer, "x-9r-via-proxy": "1" },
  ])("nonlocal/forged peer proof is 401: %j", async (headers) => {
    expect((await resolveGatewayAuth(request({ key: INTERNAL, headers }))).status).toBe(401);
  });

  it("live membership recheck: removing owner from Default denies current token", async () => {
    db.run("DELETE FROM memberships WHERE workspaceId='default' AND userId='owner'");
    expect((await resolveGatewayAuth(request({ key: INTERNAL, headers: peer }))).status).toBe(401);
  });
});
