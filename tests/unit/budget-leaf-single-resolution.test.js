// YAN-372/378: a budgeted leaf resolves model and pricing once, checks disabled
// models before and after reservation, and reserves BEFORE dispatch without
// restarting the handler. A denied budget never reaches the upstream executor.
import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, counts, pricingHook } = vi.hoisted(() => {
  process.env.TOKENHOP_MULTI_USER = "on";
  return {
    executeMock: vi.fn(),
    counts: { model: 0, disabled: 0, pricing: 0 },
    pricingHook: { fn: null },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  notifyRequestLogsEnabled: vi.fn(),
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/model.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getModelInfo: (...a) => {
      counts.model++;
      return actual.getModelInfo(...a);
    },
  };
});
vi.mock("@/lib/auth/gatewayResources.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGatewayDisabled: (...a) => {
      counts.disabled++;
      return actual.getGatewayDisabled(...a);
    },
  };
});
vi.mock("@/lib/db/repos/pricingRepo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPricingForModel: async (...a) => {
      counts.pricing++;
      if (pricingHook.fn) await pricingHook.fn();
      return actual.getPricingForModel(...a);
    },
  };
});

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { bumpBudgetsGeneration } from "@/lib/users/budgets.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { inBudgetScope, withBudgetScope } from "@/sse/services/budgetGuard.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

const NOW = "2026-10-04T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"B".repeat(32)}`;

let db;

const ok = () => ({
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

const chat = (model = "openai/gpt-4o", { token = TOKEN, headers = {} } = {}) =>
  handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

let seq = 0;
function addBudget(scopeType, scopeId, limits) {
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES(?, ?, ?, ?, 'day', ?, NULL, ?, NULL, NULL, NULL, ?)`,
    [
      `bl${++seq}`,
      scopeType === "user" ? null : "w1",
      scopeType,
      scopeId,
      limits.usd ?? null,
      limits.requests ?? null,
      NOW,
    ],
  );
  bumpBudgetsGeneration();
}
// Single workspace budget (replaces any previous rows).
function budget(limits) {
  db.run("DELETE FROM budgets");
  addBudget("workspace", "w1", limits);
}
const who = (patch = {}) => ({
  via: "apiKey",
  workspaceId: "w1",
  userId: "u1",
  apiKeyId: "key1",
  ...patch,
});
const restoreKey = () =>
  db.run("UPDATE apiKeys SET revokedAt = NULL, allowedModels = '[]' WHERE id = 'key1'");

const hashedKeysDdl = `CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: hashApiKey(TOKEN, deriveApiKeyHashKey(MASTER)),
    hashKid: KID,
    prefix: "th_BBBB…BBBB",
    name: "k",
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

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  // An old settings row survives tests (INSERT OR REPLACE merges nothing).
  db.exec("DELETE FROM settings");
  db.run("INSERT INTO settings(id,data) VALUES (1, ?)", [JSON.stringify({ requireApiKey: true })]);
  db.exec("DROP TABLE apiKeys");
  db.exec(hashedKeysDdl);
  db.exec(
    "DELETE FROM budgets; DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM combos; DELETE FROM workspaceSettings; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('u1', 'user', 'active', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('w1', 'w1', 'shared', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES ('w1', 'u1', 'member', ?)",
    [NOW],
  );
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
  insertHashedApiKeySync(db, hashedKeyRow());
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-w1', 'openai', 'apikey', 'c', NULL, 1, 1, ?, ?, ?, 'w1', NULL)`,
    [JSON.stringify({ apiKey: "sk-w1" }), NOW, NOW],
  );
  bumpBudgetsGeneration(); // budgets table wiped above: drop cached rows/holds
  executeMock.mockReset();
  executeMock.mockImplementation(async () => ok());
  counts.model = 0;
  counts.disabled = 0;
  counts.pricing = 0;
  pricingHook.fn = null;
});

afterAll(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
  delete process.env.TOKENHOP_MULTI_USER;
});

describe("budgeted leaf attempt", () => {
  it("resolves model and pricing once, then dispatches upstream once", async () => {
    budget({ requests: 5 });
    const res = await chat();
    expect(res.status).toBe(200);
    await res.text();
    expect(counts.model).toBe(1);
    // Dispatch-time check + post-reserve recheck: both live, exactly 2 under a budget scope.
    expect(counts.disabled).toBe(2);
    expect(counts.pricing).toBe(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("reads each settings layer and scoped resource once per request (YAN-1106)", async () => {
    budget({ requests: 5 });
    await (await chat()).text(); // warm module-level caches (observability config etc.)
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    try {
      await (await chat()).text();
      const sqls = [...get.mock.calls, ...all.mock.calls].map(([sql]) => String(sql));
      const count = (re) => sqls.filter((sql) => re.test(sql)).length;
      expect(count(/FROM settings WHERE id = 1/)).toBe(1);
      expect(count(/FROM workspaceSettings/)).toBe(1);
      expect(count(/FROM userPreferences/)).toBe(1);
      // Both disabled checks (dispatch-time and post-reserve) read storage live.
      expect(count(/FROM kv WHERE scope = \? AND substr/)).toBe(2);
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  });

  it("without budgets, a model disabled between combo hops is not served on the next hop", async () => {
    const key = `ws:w1/${getProviderAlias("openai")}`;
    const insertCombo = (name, models) =>
      db.run(
        "INSERT INTO combos(id,name,kind,models,workspaceId,createdAt,updatedAt) VALUES (?, ?, 'llm', ?, 'w1', ?, ?)",
        [`combo-${name}`, name, JSON.stringify(models), NOW, NOW],
      );
    insertCombo("hops", ["openai/gpt-4o", "openai/gpt-4o-mini"]);
    // Hop 1 fails upstream; the model of hop 2 is disabled while hop 1 runs.
    executeMock.mockImplementationOnce(async () => {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, '["gpt-4o-mini"]')
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [key],
      );
      return { response: new Response("boom", { status: 500 }), url: "x", headers: {} };
    });
    try {
      const res = await chat("hops");
      await res.text();
      expect(res.status).not.toBe(200);
      // Only hop 1 reached the upstream; the disabled hop-2 model never did.
      expect(executeMock).toHaveBeenCalledTimes(1);
    } finally {
      db.run("DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?", [key]);
    }
  });

  it("without budgets the leaf also resolves once and has no pricing lookup", async () => {
    const res = await chat();
    expect(res.status).toBe(200);
    await res.text();
    expect(counts.model).toBe(1);
    expect(counts.disabled).toBe(1);
    expect(counts.pricing).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("denied budget returns 429 with zero upstream calls", async () => {
    budget({ requests: 0 });
    const res = await chat();
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("budget_exceeded");
    expect(executeMock).not.toHaveBeenCalled();
    expect(counts.model).toBe(1);
    expect(counts.disabled).toBe(1);
  });

  it("holds the reservation while upstream runs (second request denied mid-flight)", async () => {
    budget({ requests: 1 });
    let release;
    executeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok());
        }),
    );
    const first = chat();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = await chat();
    expect(second.status).toBe(429);
    expect(executeMock).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
  });

  it("holds budget before the first upstream call (executor runs inside the scope)", async () => {
    budget({ requests: 1 });
    let scoped = null;
    executeMock.mockImplementationOnce(async () => {
      scoped = inBudgetScope();
      return ok();
    });
    const res = await chat();
    expect(res.status).toBe(200);
    expect(scoped).toBe(true);
    await res.text();
  });

  it("account fallback: two executor calls, one reservation, one pricing lookup", async () => {
    budget({ requests: 1 }); // a second reservation would be impossible to hide
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES('conn-w2', 'openai', 'apikey', 'c2', NULL, 2, 1, ?, ?, ?, 'w1', NULL)`,
      [JSON.stringify({ apiKey: "sk-w2" }), NOW, NOW],
    );
    executeMock.mockImplementationOnce(async () => ({
      response: new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      url: "https://fake.local/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    const res = await chat();
    expect(res.status).toBe(200);
    await res.text();
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(counts.pricing).toBe(1);
    expect(counts.model).toBe(1);
    expect(counts.disabled).toBe(2); // first pass + post-reserve recheck
  });

  it("withBudgetScope runs the callback exactly once for any result", async () => {
    for (const value of [undefined, null, new Response("x", { status: 502 })]) {
      budget({ requests: 5 });
      const run = vi.fn(async () => value);
      expect(await withBudgetScope(who(), { nonToken: true }, run)).toBe(value);
      expect(run).toHaveBeenCalledTimes(1);
    }
    db.run("DELETE FROM budgets"); // no budgets: still exactly once
    bumpBudgetsGeneration();
    const run = vi.fn(async () => undefined);
    await withBudgetScope(who(), { nonToken: true }, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("5xx and thrown attempts release the hold so the next request passes", async () => {
    budget({ requests: 1 });
    const failed = await withBudgetScope(
      who(),
      { nonToken: true },
      async () => new Response("bad", { status: 502 }),
    );
    expect(failed.status).toBe(502);
    await expect(
      withBudgetScope(who(), { nonToken: true }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const next = await withBudgetScope(who(), { nonToken: true }, async () => new Response("ok"));
    expect(next.status).toBe(200);
  });

  it("parallel principals hold isolated budgets", async () => {
    db.run("DELETE FROM budgets");
    addBudget("user", "ua", { requests: 1 });
    addBudget("user", "ub", { requests: 1 });
    const a = who({ userId: "ua", apiKeyId: "ka" });
    const b = who({ userId: "ub", apiKeyId: "kb" });
    let finishA;
    const heldA = withBudgetScope(
      a,
      { nonToken: true },
      () =>
        new Promise((resolve) => {
          finishA = () => resolve(new Response("a"));
        }),
    );
    await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
    const deniedA = await withBudgetScope(a, { nonToken: true }, async () => new Response("no"));
    expect(deniedA.status).toBe(429);
    const okB = await withBudgetScope(b, { nonToken: true }, async () => new Response("b"));
    expect(okB.status).toBe(200);
    finishA();
    expect((await heldA).status).toBe(200);
  });

  it("pricing failure reserves the fallback estimate before upstream", async () => {
    budget({ usd: 0.005 }); // fallback reserve (0.01) exceeds this limit
    pricingHook.fn = async () => {
      throw new Error("pricing down");
    };
    const res = await chat();
    expect(res.status).toBe(429);
    expect(executeMock).not.toHaveBeenCalled();
    budget({ usd: 5 });
    const ok200 = await chat();
    expect(ok200.status).toBe(200);
    await ok200.text();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  describe("authorization recheck after async pricing", () => {
    it("revoked key during pricing: 403, zero upstream, hold released", async () => {
      budget({ requests: 1 });
      pricingHook.fn = async () => {
        db.run("UPDATE apiKeys SET revokedAt = ? WHERE id = 'key1'", [NOW]);
      };
      const res = await chat();
      expect(res.status).toBe(403);
      expect(executeMock).not.toHaveBeenCalled();
      pricingHook.fn = null;
      restoreKey();
      clearApiKeyPrincipalCache();
      const next = await chat(); // would be 429 if the denied attempt kept its hold
      expect(next.status).toBe(200);
      await next.text();
    });

    it("scope narrowed during pricing: 403, zero upstream, hold released", async () => {
      budget({ requests: 1 });
      pricingHook.fn = async () => {
        db.run("UPDATE apiKeys SET allowedModels = ? WHERE id = 'key1'", [
          JSON.stringify(["anthropic/claude-3"]),
        ]);
      };
      const res = await chat();
      expect(res.status).toBe(403);
      expect(executeMock).not.toHaveBeenCalled();
      pricingHook.fn = null;
      restoreKey();
      const next = await chat();
      expect(next.status).toBe(200);
      await next.text();
    });

    it("model disabled during pricing: 404 localError, zero upstream, hold released", async () => {
      budget({ requests: 1 });
      const key = `ws:w1/${getProviderAlias("openai")}`;
      pricingHook.fn = async () => {
        db.run(
          `INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
          [key, JSON.stringify(["gpt-4o"])],
        );
      };
      const res = await chat();
      expect(res.status).toBe(404);
      expect(res.localError).toBe(true);
      expect((await res.json()).error.message).toContain("Model disabled");
      expect(executeMock).not.toHaveBeenCalled();
      pricingHook.fn = null;
      db.run("DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?", [key]);
      const next = await chat();
      expect(next.status).toBe(200);
      await next.text();
    });

    it("key expired during pricing: 403, zero upstream, hold released", async () => {
      budget({ requests: 1 });
      pricingHook.fn = async () => {
        db.run("UPDATE apiKeys SET expiresAt = ? WHERE id = 'key1'", ["2020-01-01T00:00:00.000Z"]);
      };
      const res = await chat();
      expect(res.status).toBe(403);
      expect(executeMock).not.toHaveBeenCalled();
      pricingHook.fn = null;
      db.run("UPDATE apiKeys SET expiresAt = NULL WHERE id = 'key1'");
      clearApiKeyPrincipalCache();
      const next = await chat();
      expect(next.status).toBe(200);
      await next.text();
    });

    it("membership removed during pricing: 403, zero upstream, hold released", async () => {
      budget({ requests: 1 });
      pricingHook.fn = async () => {
        db.run("DELETE FROM memberships WHERE workspaceId = 'w1' AND userId = 'u1'");
      };
      const res = await chat();
      expect(res.status).toBe(403);
      expect(executeMock).not.toHaveBeenCalled();
      pricingHook.fn = null;
      db.run(
        "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES ('w1', 'u1', 'member', ?)",
        [NOW],
      );
      clearApiKeyPrincipalCache();
      const next = await chat();
      expect(next.status).toBe(200);
      await next.text();
    });

    it("service key stays eligible through creator churn", async () => {
      budget({ requests: 5 });
      const serviceToken = `th_${"S".repeat(32)}`;
      insertHashedApiKeySync(
        db,
        hashedKeyRow({
          id: "svc",
          userId: null,
          createdByUserId: null,
          keyHash: hashApiKey(serviceToken, deriveApiKeyHashKey(MASTER)),
          prefix: "th_SSSS…SSSS",
        }),
      );
      // Creator/owner user gone: service keys (userId NULL) never gate on it.
      db.exec("DELETE FROM memberships; DELETE FROM users");
      const res = await chat("openai/gpt-4o", { token: serviceToken });
      expect(res.status).toBe(200);
      await res.text();
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("keyless local owner principal passes (recheck is key-only)", async () => {
      budget({ requests: 5 });
      db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
      db.run("INSERT INTO _meta(key,value) VALUES ('defaultWorkspaceId','w1')");
      db.run("UPDATE users SET instanceRole = 'owner' WHERE id = 'u1'");
      db.run("UPDATE memberships SET role = 'owner' WHERE workspaceId = 'w1' AND userId = 'u1'");
      const res = await chat("openai/gpt-4o", {
        token: null,
        headers: { "x-9r-peer-token": "peer", "x-9r-real-ip": "127.0.0.1" },
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("legacy/malformed storage with a key principal: 403 (never 500), hold released", async () => {
      budget({ requests: 1 });
      pricingHook.fn = async () => {
        db.exec("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
        db.exec("DROP TABLE apiKeys");
        db.exec(
          `CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
           isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`,
        );
      };
      const res = await chat();
      expect(res.status).toBe(403);
      expect(executeMock).not.toHaveBeenCalled();
      // Rebuild hashed storage; the denied attempt's hold must not linger.
      pricingHook.fn = null;
      db.exec("DROP TABLE apiKeys");
      db.exec(hashedKeysDdl);
      db.run(
        "INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
        [KID],
      );
      insertHashedApiKeySync(db, hashedKeyRow());
      clearApiKeyPrincipalCache();
      const next = await chat();
      expect(next.status).toBe(200);
      await next.text();
    });
  });
});
