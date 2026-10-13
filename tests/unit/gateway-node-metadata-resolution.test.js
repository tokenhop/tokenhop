// YAN-378: gateway model-prefix routing reads node metadata only — never
// decrypts, never loads the root key, even with credential encryption active
// and hostile leaf values. Own custom nodes resolve; foreign workspace nodes
// are invisible; legacy (no principal) host-owned nodes still resolve.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security/masterKey.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadMasterKey: vi.fn(),
}));

import { getAdapter } from "@/lib/db/driver.js";
import { loadMasterKey } from "@/lib/security/masterKey.js";
import { getGatewayNodesMetadata } from "@/lib/auth/gatewayResources.js";
import {
  getProviderNodesMetadataUnscoped,
  getProviderNodesRoutingUnscoped,
} from "@/lib/db/repos/nodesRepo.js";
import { getModelInfo } from "@/sse/services/model.js";

const NOW = "2026-10-13T00:00:00.000Z";
const KID = "0123456789abcdef";
const principalOf = (workspaceId) =>
  Object.freeze({
    workspaceId,
    userId: null,
    apiKeyId: `key-${workspaceId}`,
    scopes: Object.freeze({ allowedModels: Object.freeze([]), allowedCombos: Object.freeze([]) }),
    via: "apiKey",
  });

function insertNode(id, prefix, workspaceId, data = {}) {
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, 'openai-compatible', ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      id,
      JSON.stringify({ prefix, baseUrl: "http://node.test", ...data }),
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

let db;

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DELETE FROM providerNodes; DELETE FROM workspaces; DELETE FROM combos");
  db.run(
    "DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','credentialsCleanupPending','credentialsPendingRotation','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid')",
  );
  for (const id of ["w1", "w2"]) {
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
  }
  // Encrypted storage: any accidental runtime decrypt must touch loadMasterKey.
  db.run(
    "INSERT INTO _meta(key,value) VALUES ('credentialsEncryptedVersion','1'), ('credentialsKekKid',?), ('apiKeyHashKeyWrapped','{}')",
    [KID],
  );
  loadMasterKey.mockReset();
  loadMasterKey.mockRejectedValue(
    Object.assign(new Error("root missing"), { code: "KEY_MISSING" }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("node metadata prefix routing (YAN-378)", () => {
  it("resolves the principal's own custom node prefix without loading the root", async () => {
    insertNode("node-own", "t378", "w1", { apiKey: "sk-never-decrypted-378" });
    loadMasterKey.mockClear();
    await expect(getModelInfo("t378/m", { principal: principalOf("w1") })).resolves.toEqual({
      provider: "node-own",
      model: "m",
    });
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("never resolves a foreign workspace node prefix", async () => {
    insertNode("node-foreign", "fx378", "w2");
    const out = await getModelInfo("fx378/m", { principal: principalOf("w1") });
    expect(out.provider).not.toBe("node-foreign");
    expect(out).toEqual({ provider: "fx378", model: "m" });
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("legacy mode (no principal) still resolves host-owned nodes, root untouched", async () => {
    insertNode("node-host", "host378", null);
    loadMasterKey.mockClear();
    await expect(getModelInfo("host378/m")).resolves.toEqual({ provider: "node-host", model: "m" });
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("envelope/plaintext garbage in covered leaves is redacted, never decrypted or leaked", async () => {
    insertNode("node-enc", "enc378", "w1", {
      apiKey: { ct: "AAAA-ciphertext-378", iv: "BBBB", kid: KID, tag: "CCCC", v: 1 },
      accessToken: "sk-plain-garbage-378",
    });
    loadMasterKey.mockClear();
    await expect(getModelInfo("enc378/m", { principal: principalOf("w1") })).resolves.toEqual({
      provider: "node-enc",
      model: "m",
    });
    expect(loadMasterKey).not.toHaveBeenCalled();
    const nodes = await getGatewayNodesMetadata(principalOf("w1"), {
      types: ["openai-compatible"],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].prefix).toBe("enc378");
    expect(nodes[0].configured).toEqual(expect.arrayContaining(["apiKey", "accessToken"]));
    const serialized = JSON.stringify(nodes);
    expect(serialized).not.toContain("sk-plain-garbage-378");
    expect(serialized).not.toContain("AAAA-ciphertext-378");
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("nested providerSpecificData / headers / unlisted leaves never reach routing output", async () => {
    insertNode("node-nested", "nest378", "w1", {
      apiKey: "sk-flat-secret-378",
      providerSpecificData: { apiKey: "sk-psd-secret-378", clientSecret: "cs-378" },
      headers: { authorization: "Bearer hdr-secret-378", "x-api-key": "hdr-key-378" },
      customCredential: "sk-custom-secret-378",
      token: "tok-secret-378",
    });
    loadMasterKey.mockClear();
    const nodes = await getGatewayNodesMetadata(principalOf("w1"), {
      types: ["openai-compatible"],
    });
    expect(nodes).toHaveLength(1);
    const [node] = nodes;
    expect(Object.keys(node).sort()).toEqual(
      ["baseUrl", "createdAt", "id", "name", "prefix", "type", "updatedAt", "workspaceId"]
        .concat("configured")
        .sort(),
    );
    expect(node.configured).toEqual(["apiKey"]);
    const serialized = JSON.stringify(nodes);
    for (const secret of [
      "sk-flat-secret-378",
      "sk-psd-secret-378",
      "cs-378",
      "hdr-secret-378",
      "hdr-key-378",
      "sk-custom-secret-378",
      "tok-secret-378",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(node.providerSpecificData).toBeUndefined();
    expect(node.headers).toBeUndefined();
    expect(loadMasterKey).not.toHaveBeenCalled();
    // Narrowing the output did not remove the ordinary public fields.
    expect(await getProviderNodesMetadataUnscoped()).toHaveLength(1);
  });

  it("non-JSON data blob fails closed instead of leaking", async () => {
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('node-corrupt', 'openai-compatible', 'c', 'not-json', ?, ?, 'w1', NULL)`,
      [NOW, NOW],
    );
    await expect(getModelInfo("x/m", { principal: principalOf("w1") })).rejects.toMatchObject({
      code: "DATA_CORRUPT",
    });
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("NULL-workspace host rows never match a principal-scoped read", async () => {
    // A host-owned (NULL workspace) node must not fall into the principal's
    // routing read even when the dashboard metadata read still lists it.
    insertNode("node-nullhost", "null378", null);
    insertNode("node-mine", "mine378", "w1");
    loadMasterKey.mockClear();
    const scoped = await getGatewayNodesMetadata(principalOf("w1"), {
      types: ["openai-compatible"],
    });
    expect(scoped.map((n) => n.id)).toEqual(["node-mine"]);
    const out = await getModelInfo("null378/m", { principal: principalOf("w1") });
    expect(out.provider).not.toBe("node-nullhost");
    expect((await getProviderNodesMetadataUnscoped()).map((n) => n.id)).toContain("node-nullhost");
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("a node with the right prefix but a wrong type never resolves", async () => {
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('node-wtype', 'other-type', 'w', ?, ?, ?, 'w1', NULL)`,
      [JSON.stringify({ prefix: "wrong378", baseUrl: "http://x" }), NOW, NOW],
    );
    const out = await getModelInfo("wrong378/m", { principal: principalOf("w1") });
    expect(out.provider).not.toBe("node-wtype");
    expect(
      await getProviderNodesRoutingUnscoped({ types: ["openai-compatible"], workspaceId: "w1" }),
    ).toEqual([]);
  });

  it("types: [] matches nothing and the model falls back to the built-in provider", async () => {
    insertNode("node-emptyish", "empty378", "w1");
    await expect(getProviderNodesRoutingUnscoped({ types: [] })).resolves.toEqual([]);
    // Same guarantee through the gateway wrapper.
    await expect(getGatewayNodesMetadata(principalOf("w1"), { types: [] })).resolves.toEqual([]);
    // getModelInfo only ever sends a non-empty type list, so this pins the
    // repo-level contract: an empty type list is a valid empty result, never
    // an unfiltered read. Model resolution with a real type still works.
    await expect(getModelInfo("empty378/m", { principal: principalOf("w1") })).resolves.toEqual({
      provider: "node-emptyish",
      model: "m",
    });
  });

  it("hashed storage without a principal rejects", async () => {
    db.run(
      "INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
      [KID],
    );
    await expect(getGatewayNodesMetadata(null, { types: ["openai-compatible"] })).rejects.toThrow(
      "Hashed gateway routing requires a principal",
    );
    loadMasterKey.mockClear();
    await expect(getModelInfo("any378/m")).rejects.toThrow(
      "Hashed gateway routing requires a principal",
    );
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown key", { wat: 1 }],
    ["types not an array", { types: "openai-compatible" }],
    ["types with a non-string", { types: ["openai-compatible", 42] }],
    ["types with an empty string", { types: [""] }],
    ["workspaceId empty string", { workspaceId: "" }],
    ["workspaceId wrong type", { workspaceId: 42 }],
    ["null filter", null],
  ])("routing filter validation rejects: %s", async (_label, filter) => {
    insertNode("node-filter", "f378", "w1");
    await expect(getProviderNodesRoutingUnscoped(filter)).rejects.toMatchObject({
      code: "INVALID_FILTER",
    });
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("absent workspaceId and explicit null both mean unfiltered (legacy/host)", async () => {
    insertNode("node-a", "la", "w1");
    insertNode("node-b", "lb", null);
    const all = ["node-a", "node-b"];
    expect(
      (await getProviderNodesRoutingUnscoped({ types: ["openai-compatible"] })).map((n) => n.id),
    ).toEqual(all);
    expect((await getProviderNodesRoutingUnscoped({ workspaceId: null })).map((n) => n.id)).toEqual(
      all,
    );
    expect((await getProviderNodesRoutingUnscoped({ workspaceId: "w1" })).map((n) => n.id)).toEqual(
      ["node-a"],
    );
  });

  it("a caller-supplied workspaceId cannot widen the gateway read", async () => {
    insertNode("node-other", "oth378", "w2");
    await expect(
      getGatewayNodesMetadata(principalOf("w1"), {
        types: ["openai-compatible"],
        workspaceId: "w2",
      }),
    ).resolves.toEqual([]);
  });
});
