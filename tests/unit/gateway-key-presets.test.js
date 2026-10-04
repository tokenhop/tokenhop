// YAN-363 preset SERVER containment: hashed-storage apiKeys preset policy.
// Local HMAC conversion, metadata-only GET, ambiguity rollback, foreign refs,
// external preservation, tool-settings containment, legacy contract.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getCliToolPresets,
  setCliToolPresets,
  getCliToolSettings,
  setCliToolSettings,
  deleteCliToolSettings,
} from "@/lib/db/repos/cliToolSettingsRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { generateGatewayApiKey, apiKeyPrefix } from "@/shared/utils/apiKey.js";

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
let db;
let hashKey;

const ctxFor = (userId, instanceRole = "user", workspaceRoles = { w: "manager" }) => ({
  userId,
  instanceRole,
  workspaceIds: Object.keys(workspaceRoles),
  workspaceRoles,
  via: "session",
});
const owner = () => ctxFor("admin", "admin", { w: "manager" }); // manager of w only
const foreignAdmin = () => ctxFor("foreign", "admin", { other: "manager" }); // manager of other only
const bearer = () => ({ ...owner(), via: "apiKey", apiKeyId: "k" });

const seedHashedDb = (rows) => {
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid'); DELETE FROM kv WHERE scope IN ('cliToolPresets','cliToolSettings')",
  );
  for (const [id, role] of [
    ["admin", "admin"],
    ["foreign", "admin"],
  ]) {
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, ?, 'active', ?, ?)",
      [id, role, NOW, NOW],
    );
  }
  for (const id of ["w", "other"]) {
    db.run(
      "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
  }
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('w', 'admin', 'manager', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('other', 'admin', 'manager', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('other', 'foreign', 'manager', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
    [KID],
  );
  for (const { id, raw, workspaceId, isActive = 1, revokedAt = null, name = "k" } of rows) {
    db.run(
      "INSERT INTO apiKeys(id, workspaceId, keyHash, hashKid, prefix, name, legacy, isActive, revokedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
      [
        id,
        workspaceId,
        hashApiKey(raw, hashKey),
        KID,
        apiKeyPrefix(raw),
        name,
        isActive,
        revokedAt,
        NOW,
      ],
    );
  }
};

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  hashKey = deriveApiKeyHashKey(MASTER);
  db = await getAdapter();
});

const rawOf = async (kind = "apiKeys") =>
  JSON.parse(
    db.get("SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = ?", [kind]).value,
  );

describe("presets hashed containment", () => {
  it("converts known local raw (incl. inactive) to canonical { name, apiKeyId }, no raw persisted", async () => {
    const live = generateGatewayApiKey();
    const dead = generateGatewayApiKey();
    seedHashedDb([
      { id: "live", raw: live, workspaceId: "w" },
      { id: "dead", raw: dead, workspaceId: "w", isActive: 0, revokedAt: NOW },
    ]);
    await setCliToolPresets(owner(), "apiKeys", [
      { name: "x-live", key: live },
      { name: "x-dead", key: dead },
    ]);
    const stored = await rawOf();
    expect(stored).toEqual([
      { name: "x-live", apiKeyId: "live" },
      { name: "x-dead", apiKeyId: "dead" },
    ]);
    expect(JSON.stringify(stored)).not.toContain(live);
    expect(JSON.stringify(stored)).not.toContain(dead);
    const got = await getCliToolPresets(owner());
    expect(got.apiKeys).toEqual([
      { name: "x-live", apiKeyId: "live" },
      { name: "x-dead", apiKeyId: "dead" },
    ]);
    for (const item of got.apiKeys) {
      expect(Object.keys(item).sort()).toEqual(["apiKeyId", "name"]);
    }
  });

  it("redacts names that carry raw material with the fixed label", async () => {
    const raw = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw, workspaceId: "w" }]);
    await setCliToolPresets(owner(), "apiKeys", [{ name: `copy ${raw}`, key: raw }]);
    expect(await rawOf()).toEqual([{ name: "API key", apiKeyId: "live" }]);
    // sentinel: ordinary name preserved, name identical to raw sanitized
    await setCliToolPresets(owner(), "apiKeys", [{ name: "ops", key: raw }]);
    expect(await rawOf()).toEqual([{ name: "ops", apiKeyId: "live" }]);
    await setCliToolPresets(owner(), "apiKeys", [{ name: raw, key: raw }]);
    expect(await rawOf()).toEqual([{ name: "API key", apiKeyId: "live" }]);
  });

  it("unknown raw stops with static error and no mutation", async () => {
    const known = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw: known, workspaceId: "w" }]);
    await setCliToolPresets(owner(), "apiKeys", [{ name: "a", key: known }]);
    const before = await rawOf();
    const err = await setCliToolPresets(owner(), "apiKeys", [
      { name: "a", key: generateGatewayApiKey() },
    ]).catch((e) => e);
    expect(err.message).toBe("Credential preset rejected; values withheld");
    expect(await rawOf()).toEqual(before);
  });

  it("foreign refs are denied on write and hidden on read", async () => {
    const mine = generateGatewayApiKey();
    const theirs = generateGatewayApiKey();
    seedHashedDb([
      { id: "mine", raw: mine, workspaceId: "w" },
      { id: "theirs", raw: theirs, workspaceId: "other" },
    ]);
    // owner (w only) cannot see or write the other-workspace row
    db.run("DELETE FROM memberships WHERE workspaceId = 'other' AND userId = 'admin'");
    let err = await setCliToolPresets(owner(), "apiKeys", [
      { name: "x", apiKeyId: "theirs" },
    ]).catch((e) => e);
    expect(err.status).toBe(403);
    err = await setCliToolPresets(owner(), "apiKeys", [{ name: "x", key: theirs }]).catch((e) => e);
    expect(err.status).toBe(403);
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = 'apiKeys'"),
    ).toBeFalsy();
    // Seed both refs: failed writes above correctly left storage empty.
    db.run("INSERT INTO kv(scope, key, value) VALUES ('cliToolPresets', 'apiKeys', ?)", [
      JSON.stringify([
        { name: "API key", apiKeyId: "mine" },
        { name: "API key", apiKeyId: "theirs" },
      ]),
    ]);
    expect((await getCliToolPresets(owner())).apiKeys).toEqual([
      { name: "API key", apiKeyId: "mine" },
    ]);
    // foreign admin sees only their own row; cannot write w's ref
    expect((await getCliToolPresets(foreignAdmin())).apiKeys).toEqual([
      { name: "API key", apiKeyId: "theirs" },
    ]);
    err = await setCliToolPresets(foreignAdmin(), "apiKeys", [
      { name: "x", apiKeyId: "mine" },
    ]).catch((e) => e);
    expect(err.status).toBe(403);
    // removal of another workspace's ref is not honored
    await setCliToolPresets(owner(), "apiKeys", [{ name: "y", key: mine }]);
    await setCliToolPresets(owner(), "apiKeys", []);
    expect(await rawOf()).toEqual([
      { name: "y", apiKeyId: "mine" },
      { name: "API key", apiKeyId: "theirs" },
    ]);
  });

  it("existing external presets persist on disk, project as metadata marker, round-trip preserved", async () => {
    const known = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw: known, workspaceId: "w" }]);
    const external = { name: "vendor", key: "sk-external-1" };
    db.run("INSERT INTO kv(scope, key, value) VALUES ('cliToolPresets', 'apiKeys', ?)", [
      JSON.stringify([{ name: "x", key: known }, external]),
    ]);
    const got = await getCliToolPresets(owner());
    expect(got.apiKeys[0]).toEqual({ name: "x", apiKeyId: "live" });
    const marker = got.apiKeys[1];
    expect(Object.keys(marker).sort()).toEqual(["external", "externalRef", "name"]);
    expect(marker.name).toBe("External credential");
    expect(marker.external).toBe(true);
    expect(JSON.stringify(marker)).not.toContain("sk-external-1");
    // round-trip preserves bytes; tampered marker rejected
    await setCliToolPresets(owner(), "apiKeys", [got.apiKeys[1]]);
    expect(await rawOf()).toEqual([{ name: "x", apiKeyId: "live" }, external]);
    const bad = await setCliToolPresets(owner(), "apiKeys", [{ ...marker, name: "renamed" }]).catch(
      (e) => e,
    );
    expect(bad.message).toBe("Credential preset rejected; values withheld");
    expect(await rawOf()).toEqual([{ name: "x", apiKeyId: "live" }, external]);
  });

  it("bearer and unauthenticated principals are denied without touching storage", async () => {
    const known = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw: known, workspaceId: "w" }]);
    for (const ctx of [bearer(), null]) {
      await expect(
        setCliToolPresets(ctx, "apiKeys", [{ name: "a", key: known }]),
      ).rejects.toMatchObject({ status: 403 });
      await expect(getCliToolPresets(ctx)).rejects.toMatchObject({ status: 403 });
    }
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = 'apiKeys'"),
    ).toBeFalsy();
  });

  it("endpoints kind passes through byte-identical in hashed mode", async () => {
    seedHashedDb([]);
    const items = [{ name: "box", baseUrl: "http://box:20128/v1" }];
    await setCliToolPresets(owner(), "endpoints", items);
    expect(await rawOf("endpoints")).toEqual(items);
    expect((await getCliToolPresets(owner())).endpoints).toEqual(items);
  });
});

describe("tool settings containment", () => {
  it("known raw converts to ref, prefs preserved, unknown rejected, external survives omission", async () => {
    const known = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw: known, workspaceId: "w" }]);
    await setCliToolSettings(owner(), "claude", { model: "opus", apiKey: known });
    expect(
      JSON.parse(
        db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'claude'").value,
      ),
    ).toEqual({
      model: "opus",
      apiKey: { apiKeyId: "live" },
    });
    const bad = await setCliToolSettings(owner(), "claude", {
      apiKey: generateGatewayApiKey(),
    }).catch((e) => e);
    expect(bad.status).toBe(400);
    // stored ref survives an update that omits the secret slot
    await setCliToolSettings(owner(), "claude", { model: "sonnet" });
    expect(
      JSON.parse(
        db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'claude'").value,
      ),
    ).toEqual({
      model: "sonnet",
      apiKey: { apiKeyId: "live" },
    });
    expect(await getCliToolSettings(owner(), "claude")).toEqual({
      model: "sonnet",
      apiKey: { apiKeyId: "live" },
    });
    // DELETE clears the slot (route-level allow); no secret projection remains
    await deleteCliToolSettings(owner(), "claude");
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'claude'"),
    ).toBeFalsy();
  });

  it("stored external string redacts on read and survives omission on write", async () => {
    seedHashedDb([]);
    db.run("INSERT INTO kv(scope, key, value) VALUES ('cliToolSettings', 'codex', ?)", [
      JSON.stringify({ model: "o3", apiKey: "sk-external-9" }),
    ]);
    const redacted = await getCliToolSettings(owner(), "codex");
    expect(redacted.model).toBe("o3");
    expect(redacted.apiKey.external).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("sk-external-9");
    await setCliToolSettings(owner(), "codex", { model: "o4" });
    expect(
      JSON.parse(
        db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'codex'").value,
      ),
    ).toEqual({
      model: "o4",
      apiKey: "sk-external-9",
    });
    await setCliToolSettings(owner(), "codex", { model: "o4", apiKey: redacted.apiKey });
    expect(
      JSON.parse(
        db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'codex'").value,
      ).apiKey,
    ).toBe("sk-external-9");
  });
});

describe("tool settings deletion authority", () => {
  it("hashed: bearer, anonymous and disabled principals are refused before kv.remove", async () => {
    const raw = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw, workspaceId: "w" }]);
    const stored = JSON.stringify({ model: "o3", apiKey: "sk-external-9" });
    db.run("INSERT INTO kv(scope, key, value) VALUES ('cliToolSettings', 'codex', ?)", [stored]);
    const row = () =>
      db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'codex'").value;

    for (const ctx of [bearer(), null]) {
      await expect(deleteCliToolSettings(ctx, "codex")).rejects.toMatchObject({ status: 403 });
    }
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'admin'");
    await expect(deleteCliToolSettings(owner(), "codex")).rejects.toMatchObject({ status: 403 });
    // Row byte-identical, external secret reference intact.
    expect(row()).toBe(stored);
  });

  it("hashed: authorized owner deletes the stored settings", async () => {
    const raw = generateGatewayApiKey();
    seedHashedDb([{ id: "live", raw, workspaceId: "w" }]);
    await setCliToolSettings(owner(), "claude", { model: "opus", apiKey: raw });
    await deleteCliToolSettings(owner(), "claude");
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'claude'"),
    ).toBeFalsy();
  });

  it("legacy storage deletes unconditionally", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.run("INSERT INTO kv(scope, key, value) VALUES ('cliToolSettings', 'codex', ?)", [
      JSON.stringify({ model: "o3" }),
    ]);
    await deleteCliToolSettings(null, "codex");
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'cliToolSettings' AND key = 'codex'"),
    ).toBeFalsy();
  });
});

describe("legacy contract", () => {
  it("legacy storage keeps exact raw read/write (route-era bounds)", async () => {
    db = await getAdapter();
    db.exec(
      "DELETE FROM kv WHERE scope = 'cliToolPresets'; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
    );
    const items = [{ name: "mine", key: "sk-mine" }];
    await setCliToolPresets(null, "apiKeys", items);
    expect(await rawOf()).toEqual(items);
    expect((await getCliToolPresets()).apiKeys).toEqual(items);
    const bad = await setCliToolPresets(null, "apiKeys", [{ name: "x" }]).catch((e) => e);
    expect(bad.message).toBe("Credential preset rejected; values withheld");
  });
});
