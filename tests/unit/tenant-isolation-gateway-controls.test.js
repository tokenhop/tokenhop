// YAN-378: real gateway grant/budget/lifecycle gates on a warm key cache.
// LIMIT: reservation + committed spend covered; no timing benchmarks or
// streaming cancel/grace timing assertions (see budgets-gateway.test.js).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, savedEnv } = vi.hoisted(() => {
  const savedEnv = {
    TOKENHOP_MULTI_USER: process.env.TOKENHOP_MULTI_USER,
    TOKENHOP_MASTER_KEY: process.env.TOKENHOP_MASTER_KEY,
  };
  process.env.TOKENHOP_MULTI_USER = "on";
  return { executeMock: vi.fn(), savedEnv };
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
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));

import { POST as chatPost } from "@/app/api/v1/chat/completions/route.js";
import { spentFor } from "@/sse/services/budgetGuard.js";
import {
  assertNoSecrets,
  observeResponse,
  okUpstream,
  past,
  post,
  restoreEnv,
  seedGatewayWorld,
} from "../helpers/tenantIsolation/gatewayWorld.js";

let world;
const chat = (model = "anthropic/claude-3-5-sonnet-20241022", key) =>
  chatPost(
    post(
      "http://localhost/v1/chat/completions",
      { model, messages: [{ role: "user", content: "hi" }] },
      key,
    ),
  );

beforeEach(async () => {
  executeMock.mockReset();
  // Fresh Response per attempt: fallback retries must never reuse a consumed body.
  executeMock.mockImplementation(async () => okUpstream());
  world = await seedGatewayWorld();
});
afterAll(() => restoreEnv(savedEnv));

describe("workspace-scoped connection grants", () => {
  it("granted model serves; non-granted model on the same connection is denied", async () => {
    world.grant("g1", "conn-a", "wB", { allowedModels: ["openai/gpt-5"] });
    const ok = await chat("openai/gpt-5");
    expect(ok.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].credentials).toMatchObject({
      connectionId: "conn-a",
      grantId: "g1",
    });
    const denied = await chat("openai/gpt-4o");
    expect(denied.status).toBe(404);
    assertNoSecrets(await (await observeResponse(denied)).text());
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("revoked grant is denied on the next request with a warm cache", async () => {
    world.grant("g1", "conn-a", "wB", { allowedModels: ["openai/gpt-5"] });
    expect((await chat("openai/gpt-5")).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    world.db.run("UPDATE connectionGrants SET revokedAt = ? WHERE id = 'g1'", [Date.now() - 1000]);
    expect((await chat("openai/gpt-5")).status).toBe(404);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("warm-cache connection changes", () => {
  it("deactivating the key's own connection after a successful request denies the next one", async () => {
    expect((await chat()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    world.db.run("UPDATE providerConnections SET isActive = 0 WHERE id = 'conn-b'");
    const res = await chat();
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("No active credentials for provider: anthropic");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("a request denied before a grant exists is served once the grant is created", async () => {
    expect((await chat("openai/gpt-5")).status).toBe(404);
    expect(executeMock).not.toHaveBeenCalled();
    world.grant("g-late", "conn-a", "wB", { allowedModels: ["openai/gpt-5"] });
    expect((await chat("openai/gpt-5")).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].credentials).toMatchObject({ grantId: "g-late" });
  });
});

describe("budget enforcement before upstream", () => {
  it("sanity: without budget rows the request routes upstream", async () => {
    expect((await chat()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it.each(["key", "user", "membership", "workspace"])(
    "%s budget exhausted returns 429 before upstream",
    async (level) => {
      const scopeId = {
        key: "keyB",
        user: "uB",
        membership: world.membershipScopeId,
        workspace: "wB",
      }[level];
      world.budget(level, scopeId, { workspaceId: "wB" });
      const res = await chat();
      expect(res.status).toBe(429);
      expect((await res.json()).error).toMatchObject({
        type: "insufficient_quota",
        code: "budget_exceeded",
        level,
      });
      expect(executeMock).not.toHaveBeenCalled();
    },
  );

  it("grant budget exhausted returns 429 before upstream", async () => {
    world.grant("g1", "conn-a", "wB", { allowedModels: ["openai/gpt-5"] });
    world.budget("grant", "g1", { workspaceId: "wA" });
    const res = await chat("openai/gpt-5");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({
      type: "insufficient_quota",
      code: "budget_exceeded",
      level: "grant",
    });
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("budget settle path", () => {
  it("limitRequests 1: first settled request is served, the second is denied before upstream", async () => {
    world.budget("workspace", "wB", { workspaceId: "wB", limitRequests: 1 });
    const first = await chat();
    expect(first.status).toBe(200);
    await first.text();
    expect(executeMock).toHaveBeenCalledTimes(1);
    // Real saveRequestUsageUnscoped writes usageHistory and emits the settle hook.
    await vi.waitFor(() =>
      expect(
        world.db.get("SELECT COUNT(*) AS n FROM usageHistory WHERE workspaceId = 'wB'").n,
      ).toBeGreaterThanOrEqual(1),
    );
    const budget = world.db.get("SELECT * FROM budgets WHERE scopeType = 'workspace'");
    expect(spentFor(world.db, budget).requests).toBe(1);
    const second = await chat();
    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatchObject({
      code: "budget_exceeded",
      level: "workspace",
      // Gate alone is confounded by reservation grace. Hook-broken state says
      // spent 0 requests; this assertion requires the enforcement counter update.
      message: expect.stringContaining("spent 1 requests"),
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("key scope pins stay workspace-bound", () => {
  it("allowedModels pinning a model served only by another workspace still denies, identically to an unpinned key", async () => {
    const pinned = world.insertKey("keyB-pinned", { allowedModels: ["openai/gpt-4o"] });
    const scoped = await chat("openai/gpt-4o", pinned);
    const unscoped = await chat("openai/gpt-4o");
    const scopedBody = await (await observeResponse(scoped)).json();
    expect(scoped.status).toBe(404);
    expect(scoped.status).toBe(unscoped.status);
    expect(scopedBody).toEqual(await (await observeResponse(unscoped)).json()); // pin grants no access oracle
    expect(scopedBody.error.message).toBe("No active credentials for provider: openai");
    assertNoSecrets(scopedBody);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("allowedCombos naming another workspace's combo never resolves it; parity with an unknown name", async () => {
    const pinned = world.insertKey("keyB-combo", { allowedCombos: ["combo-a"] });
    const scoped = await chat("combo-w1", pinned);
    const unknown = await chat("unknown-w1", pinned);
    const scopedBody = await (await observeResponse(scoped)).json();
    expect(scoped.status).toBe(unknown.status);
    expect(scopedBody).toEqual(await (await observeResponse(unknown)).json());
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("control: own pinned model and own allowed combo both serve (pins are exercised, not vacuous)", async () => {
    world.db.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId)
       VALUES('combo-b-id', 'combo-b', NULL, ?, ?, ?, 'wB')`,
      [
        JSON.stringify(["anthropic/claude-3-5-sonnet-20241022"]),
        "2026-10-04T00:00:00.000Z",
        "2026-10-04T00:00:00.000Z",
      ],
    );
    const token = world.insertKey("keyB-own", {
      allowedModels: ["anthropic/claude-3-5-sonnet-20241022"],
      allowedCombos: ["combo-b-id"],
    });
    const model = await chat("anthropic/claude-3-5-sonnet-20241022", token);
    expect(model.status).toBe(200);
    assertNoSecrets(await (await observeResponse(model)).text());
    const combo = await chat("combo-b", token);
    expect(combo.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});

describe("key lifecycle with a warm cache", () => {
  it.each([
    ["paused key", () => world.db.run("UPDATE apiKeys SET isActive = 0 WHERE id = 'keyB'")],
    [
      "revoked key",
      () => world.db.run("UPDATE apiKeys SET revokedAt = ? WHERE id = 'keyB'", [past()]),
    ],
    [
      "expired key",
      () => world.db.run("UPDATE apiKeys SET expiresAt = ? WHERE id = 'keyB'", [past()]),
    ],
    [
      "user removed from workspace",
      () => world.db.run("DELETE FROM memberships WHERE workspaceId = 'wB' AND userId = 'uB'"),
    ],
  ])("%s returns 401 with no upstream call", async (_name, change) => {
    expect((await chat()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
    change();
    expect((await chat()).status).toBe(401);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
