import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { exportWorkspace, importWorkspace } from "@/lib/db/workspaceTransfer.js";

vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => true) }));
const NOW = "2026-10-09T00:00:00.000Z";
const ctx = { userId: "u", workspaceRoles: { source: "owner", dest: "owner" } };
let db;

beforeAll(async () => {
  db = await getAdapter();
  db.run(
    `INSERT INTO users(id, instanceRole, status, sessionVersion, createdAt, updatedAt)
    VALUES('u', 'owner', 'active', 1, ?, ?)`,
    [NOW, NOW],
  );
  for (const id of ["source", "dest", "sibling"]) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt)
      VALUES(?, ?, 'shared', 'u', ?, ?)`,
      [id, id, NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt)
      VALUES(?, 'u', 'owner', 'manual', ?)`,
      [id, NOW],
    );
  }
  for (const [id, workspaceId, secret] of [
    ["connection-source", "source", "source-secret"],
    ["connection-sibling", "sibling", "sibling-secret"],
  ]) {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data,
      createdAt, updatedAt, workspaceId, createdByUserId) VALUES(?, 'openai', 'api_key', 'Main', 1, 1, ?, ?, ?, ?, 'u')`,
      [id, JSON.stringify({ apiKey: secret }), NOW, NOW, workspaceId],
    );
  }
  db.run(
    `INSERT INTO combos(id, name, models, createdAt, updatedAt, workspaceId, createdByUserId)
    VALUES('combo-source', 'Main', '[]', ?, ?, 'source', 'u')`,
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'ws:source/test', '\"openai/gpt-4o\"')",
  );
  db.run(
    "INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'ws:source/custom-node', '\"node-source/model\"')",
  );
  db.run(
    "INSERT INTO kv(scope, key, value) VALUES('disabledModels', 'ws:source/node-source', '[\"old\"]')",
  );
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('customModels', 'ws:source/exact-key-not-reconstructed', '{"id":"m"}')`,
  );
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
    VALUES('node-source', 'openai-compatible', 'Custom', '{"prefix":"custom"}', ?, ?, 'source', 'u')`,
    [NOW, NOW],
  );
  db.run("UPDATE providerConnections SET provider = 'node-source' WHERE id = 'connection-source'");
  db.run("UPDATE combos SET models = '[\"node-source/model\"]' WHERE id = 'combo-source'");
});

describe("workspace transfer", () => {
  it("refuses non-owners and wrong passphrases without changing resources", async () => {
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    await expect(
      exportWorkspace({ userId: "u", workspaceRoles: { source: "member" } }, "source", {
        passphrase: "test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    await expect(importWorkspace(ctx, "dest", doc, { passphrase: "wrong" })).rejects.toMatchObject({
      code: "PASSPHRASE_INVALID",
    });
    expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
  });

  it("rejects a credential moved between exported rows", async () => {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data,
      createdAt, updatedAt, workspaceId, createdByUserId) VALUES('connection-two', 'openai', 'api_key', 'Two', 1, 1, ?, ?, ?, 'source', 'u')`,
      [JSON.stringify({ apiKey: "second-secret" }), NOW, NOW],
    );
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    const [first, second] = doc.connections;
    first.data.apiKey = second.data.apiKey;
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    await expect(importWorkspace(ctx, "dest", doc, { passphrase: "test" })).rejects.toMatchObject({
      code: "TRANSFER_FORMAT_INVALID",
    });
    expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
  });

  it("refuses a pending owner without changing resources", async () => {
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    db.run("UPDATE users SET instanceRole = 'pending' WHERE id = 'u'");
    try {
      await expect(importWorkspace(ctx, "dest", doc, { passphrase: "test" })).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
      expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
    } finally {
      db.run("UPDATE users SET instanceRole = 'owner' WHERE id = 'u'");
    }
  });

  it("rejects duplicate payload entries atomically", async () => {
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    doc.connections.push(structuredClone(doc.connections[0]));
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    await expect(importWorkspace(ctx, "dest", doc, { passphrase: "test" })).rejects.toMatchObject({
      code: "TRANSFER_CONFLICT",
    });
    expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
  });
  it("rejects repeated source connection IDs even when names differ", async () => {
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    doc.connections.push({ ...structuredClone(doc.connections[0]), name: "Different name" });
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    await expect(importWorkspace(ctx, "dest", doc, { passphrase: "test" })).rejects.toMatchObject({
      code: "TRANSFER_FORMAT_INVALID",
    });
    expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
  });

  it("merges destination preferences and reports existing combo, node and KV conflicts", async () => {
    db.run(
      `INSERT OR REPLACE INTO workspaceSettings(workspaceId, data, updatedAt) VALUES('source', ?, ?)`,
      [
        JSON.stringify({ rtkEnabled: true, comboStrategies: { "combo-source": "round-robin" } }),
        NOW,
      ],
    );
    db.run(
      `INSERT OR REPLACE INTO workspaceSettings(workspaceId, data, updatedAt) VALUES('dest', ?, ?)`,
      [JSON.stringify({ cavemanEnabled: true, comboStrategies: { existing: "fallback" } }), NOW],
    );
    const doc = await exportWorkspace(ctx, "source", { passphrase: "test" });
    db.run(
      `INSERT INTO combos(id, name, models, workspaceId, createdByUserId, createdAt, updatedAt)
      VALUES('dest-existing', 'Main', '[]', 'dest', 'u', ?, ?)`,
      [NOW, NOW],
    );
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
      VALUES('dest-node', 'openai-compatible', 'Existing', '{"prefix":"custom"}', ?, ?, 'dest', 'u')`,
      [NOW, NOW],
    );
    db.run(
      "INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'ws:dest/test', '\"existing\"')",
    );
    const before = JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"));
    const conflict = await importWorkspace(ctx, "dest", doc, { passphrase: "test" }).catch(
      (error) => error,
    );
    expect(conflict).toMatchObject({ code: "TRANSFER_CONFLICT" });
    expect(conflict.conflicts).toEqual(
      expect.arrayContaining(["combo:Main", "node:custom", "kv:modelAliases/test"]),
    );
    expect(JSON.stringify(db.all("SELECT * FROM providerConnections ORDER BY id"))).toBe(before);
    db.run("DELETE FROM combos WHERE id = 'dest-existing'");
    db.run("DELETE FROM providerNodes WHERE id = 'dest-node'");
    db.run("DELETE FROM kv WHERE scope = 'modelAliases' AND key = 'ws:dest/test'");
    await importWorkspace(ctx, "dest", doc, { passphrase: "test" });
    const prefs = JSON.parse(
      db.get("SELECT data FROM workspaceSettings WHERE workspaceId = 'dest'").data,
    );
    expect(prefs).toMatchObject({ cavemanEnabled: true, rtkEnabled: true });
    expect(prefs.comboStrategies.existing).toBe("fallback");
    expect(Object.values(prefs.comboStrategies)).toContain("round-robin");
  });

  it("round-trips secrets with fresh IDs without leaking sibling data or mutating the document", async () => {
    // Clear only resources created by the preceding destination-merge scenario.
    db.run("DELETE FROM providerConnections WHERE workspaceId = 'dest'");
    db.run("DELETE FROM providerNodes WHERE workspaceId = 'dest'");
    db.run("DELETE FROM combos WHERE workspaceId = 'dest'");
    db.run("DELETE FROM kv WHERE key LIKE 'ws:dest/%'");
    const document = await exportWorkspace(ctx, "source", { passphrase: "workspace passphrase" });
    const before = JSON.stringify(document);
    expect(before).not.toContain("source-secret");
    expect(before).not.toContain("sibling-secret");
    await importWorkspace(ctx, "dest", document, { passphrase: "workspace passphrase" });
    const restored = db.get("SELECT * FROM providerConnections WHERE workspaceId = 'dest'");
    expect(restored.id).not.toBe("connection-source");
    const node = db.get("SELECT * FROM providerNodes WHERE workspaceId = 'dest'");
    expect(node.id).not.toBe("node-source");
    expect(restored.provider).toBe(node.id);
    const combo = db.get("SELECT * FROM combos WHERE workspaceId = 'dest'");
    expect(JSON.parse(combo.models)).toEqual([`${node.id}/model`]);
    expect(JSON.parse(restored.data).apiKey).toBe("source-secret");
    expect(JSON.stringify(document)).toBe(before);
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'ws:dest/test'").value,
    ).toBe('"openai/gpt-4o"');
    expect(
      db.get(
        "SELECT value FROM kv WHERE scope = 'customModels' AND key = 'ws:dest/exact-key-not-reconstructed'",
      ).value,
    ).toBe('{"id":"m"}');
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'ws:dest/custom-node'")
        .value,
    ).toBe(JSON.stringify(`${node.id}/model`));
    expect(
      db.get("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?", [
        `ws:dest/${node.id}`,
      ]).value,
    ).toBe('["old"]');
  });
});
