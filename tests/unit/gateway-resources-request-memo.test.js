// YAN-1106 round 2: scoped gateway reads (nodes metadata, combos, aliases,
// custom models, disabled map) run once per MINTED principal's request scope and
// never cross requests/principals. Unminted (forged/plain) principals, `live`
// rechecks and connection grants stay live.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { mintGatewayPrincipal } from "@/lib/security/requestCredentialScope.js";
import {
  getGatewayAliases,
  getGatewayCombos,
  getGatewayCustomModels,
  getGatewayDisabled,
  getGatewayNodesMetadata,
} from "@/lib/auth/gatewayResources.js";
import { isModelDisabled, isModelDisabledLive } from "@/sse/services/modelDisabled.js";

const NOW = "2026-10-13T00:00:00.000Z";
const FIELDS = {
  workspaceId: "w1",
  userId: null,
  apiKeyId: "key-w1",
  scopes: { allowedModels: [], allowedCombos: [] },
  via: "apiKey",
};

let db;
const mint = () => mintGatewayPrincipal({ ...FIELDS }, db);
const forged = () => Object.freeze({ ...FIELDS });
const reads = (spy, re) => spy.mock.calls.filter(([sql]) => re.test(String(sql))).length;

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DELETE FROM combos; DELETE FROM providerNodes; DELETE FROM workspaces");
  db.run(
    "DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','credentialsCleanupPending','credentialsPendingRotation','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid')",
  );
  db.run("DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels')");
  db.run(
    "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('w1','w1','shared',?,?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO combos(id,name,kind,models,workspaceId,createdAt,updatedAt) VALUES ('c1','mine','llm','[\"openai/gpt-4o\"]','w1',?,?)",
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO providerNodes(id,type,name,data,createdAt,updatedAt,workspaceId,createdByUserId)
     VALUES('n1','openai-compatible','n1',?,?,?,'w1',NULL)`,
    [JSON.stringify({ prefix: "pfx", baseUrl: "http://node.test" }), NOW, NOW],
  );
  db.run(
    `INSERT INTO kv(scope,key,value) VALUES('modelAliases','ws:w1/fast','"openai/gpt-4o"'),
       ('customModels','ws:w1/m1','{"id":"m1"}'),('disabledModels','ws:w1/openai','["gpt-4o"]')`,
  );
});

describe("per-request memo on a minted principal", () => {
  it("each scoped read hits storage once per request, repeats share the result", async () => {
    const principal = mint();
    const all = vi.spyOn(db, "all");
    try {
      for (let i = 0; i < 3; i++) {
        expect((await getGatewayCombos(principal)).map((c) => c.name)).toEqual(["mine"]);
        expect(await getGatewayAliases(principal)).toEqual({ fast: "openai/gpt-4o" });
        expect(await getGatewayCustomModels(principal)).toEqual([{ id: "m1" }]);
        expect(await getGatewayDisabled(principal)).toEqual({ openai: ["gpt-4o"] });
        const nodes = await getGatewayNodesMetadata(principal, { types: ["openai-compatible"] });
        expect(nodes.map((n) => n.id)).toEqual(["n1"]);
      }
      expect(reads(all, /FROM combos WHERE workspaceId/)).toBe(1);
      expect(reads(all, /FROM kv/)).toBe(3); // aliases, custom models, disabled: once each
    } finally {
      all.mockRestore();
    }
  });

  it("a new principal (next request) reads storage again and sees changes", async () => {
    const first = mint();
    expect(await getGatewayDisabled(first)).toEqual({ openai: ["gpt-4o"] });
    db.run(`UPDATE kv SET value = '[]' WHERE scope = 'disabledModels' AND key = 'ws:w1/openai'`);
    expect(await getGatewayDisabled(first)).toEqual({ openai: ["gpt-4o"] }); // same request: stable
    expect(await getGatewayDisabled(mint())).toEqual({ openai: [] });
  });

  it("memo entries are isolated per principal and per node-type filter", async () => {
    const a = mint();
    const b = mint();
    expect(await getGatewayCombos(a)).not.toBe(await getGatewayCombos(b));
    const typed = await getGatewayNodesMetadata(a, { types: ["openai-compatible"] });
    const other = await getGatewayNodesMetadata(a, { types: ["anthropic-compatible"] });
    expect(typed.map((n) => n.id)).toEqual(["n1"]);
    expect(other).toEqual([]);
  });

  it("shared results are deep-frozen", async () => {
    const principal = mint();
    const combos = await getGatewayCombos(principal);
    expect(Object.isFrozen(combos)).toBe(true);
    expect(Object.isFrozen(combos[0])).toBe(true);
    expect(Object.isFrozen(combos[0].models)).toBe(true);
    expect(Object.isFrozen(await getGatewayDisabled(principal))).toBe(true);
  });

  it("unminted (forged/plain) principals read live every call", async () => {
    const principal = forged();
    const all = vi.spyOn(db, "all");
    try {
      await getGatewayCombos(principal);
      await getGatewayCombos(principal);
      expect(reads(all, /FROM combos WHERE workspaceId/)).toBe(2);
    } finally {
      all.mockRestore();
    }
  });

  it("legacy (no principal) reads stay unscoped and unmemoized", async () => {
    expect(await getGatewayDisabled(null)).toBeTypeOf("object");
  });
});

describe("disabled-model rechecks", () => {
  it("first pass may use the request memo; the live recheck always sees new state", async () => {
    const principal = mint();
    expect(await isModelDisabled("openai", "gpt-4o", principal)).toBe(true);
    db.run(`UPDATE kv SET value = '[]' WHERE scope = 'disabledModels' AND key = 'ws:w1/openai'`);
    expect(await isModelDisabled("openai", "gpt-4o", principal)).toBe(true); // memoized
    expect(await isModelDisabledLive("openai", "gpt-4o", principal)).toBe(false); // live
  });

  it("disabling mid-request is caught by the live recheck", async () => {
    db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);
    const principal = mint();
    expect(await isModelDisabled("openai", "gpt-4o", principal)).toBe(false);
    db.run(`INSERT INTO kv(scope,key,value) VALUES('disabledModels','ws:w1/openai','["gpt-4o"]')`);
    expect(await isModelDisabledLive("openai", "gpt-4o", principal)).toBe(true);
  });

  it("still fails open on a read error", async () => {
    const principal = mint();
    const all = vi.spyOn(db, "all").mockImplementation(() => {
      throw new Error("db down");
    });
    try {
      expect(await isModelDisabledLive("openai", "gpt-4o", principal)).toBe(false);
    } finally {
      all.mockRestore();
    }
  });
});
