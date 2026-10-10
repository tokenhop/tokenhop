// YAN-1041: transactional billingLock writes against the real SQLite layer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-billing-lock-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const lock = (generation) => ({
  reason: "credit_exhausted",
  code: "http_400",
  message: "credit balance is too low",
  lockedAt: new Date().toISOString(),
  nextProbeAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeError: null,
  generation,
});

describe("mutateBillingLockUnscoped", () => {
  it("clears only billing state: model locks and auth failure survive", async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "anthropic",
      authType: "apikey",
      name: "billing-a",
      apiKey: "sk-test-123456",
    });
    const future = new Date(Date.now() + 600_000).toISOString();
    await db.updateProviderConnectionUnscoped(conn.id, {
      "modelLock_claude-x": future,
      testStatus: "unavailable",
      lastError: "auth failed",
      errorCode: 401,
      billingLock: lock(5),
      billingLockGeneration: 5,
    });

    const r = await db.mutateBillingLockUnscoped(conn.id, (live) =>
      live.billingLock?.generation === 5 ? { billingLock: null } : null,
    );
    expect(r).toMatchObject({ applied: true, billingLock: null });

    const after = await db.getProviderConnectionByIdUnscoped(conn.id);
    expect(after.billingLock ?? null).toBeNull();
    expect(after["modelLock_claude-x"]).toBe(future);
    expect(after.testStatus).toBe("unavailable");
    expect(after.errorCode).toBe(401);
    expect(after.billingLockGeneration).toBe(5);
  });

  it("is conditional: a newer generation or a missing row is not overwritten", async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "anthropic",
      authType: "apikey",
      name: "billing-b",
      apiKey: "sk-test-654321",
    });
    await db.updateProviderConnectionUnscoped(conn.id, {
      billingLock: lock(9),
      billingLockGeneration: 9,
    });
    const stale = await db.mutateBillingLockUnscoped(conn.id, (live) =>
      live.billingLock?.generation === 8 ? { billingLock: null } : null,
    );
    expect(stale.applied).toBe(false);
    expect(stale.billingLock.generation).toBe(9);

    const missing = await db.mutateBillingLockUnscoped("nope", () => ({ billingLock: null }));
    expect(missing).toMatchObject({ applied: false, missing: true });
  });
});

// Standalone discovery + reboot survival, against the real SQLite layer and the
// real auth.js (default non-weighted fill-first strategy, no quota snapshot, no
// OAuth/weighted poller involved).
describe("discovery and restart", () => {
  const CREDIT_400 = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API.",
    },
  });

  // Seeded once for the whole describe; the reboot test runs LAST and its
  // vi.resetModules() therefore never invalidates handles other tests still use.
  let connId;
  beforeAll(async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "anthropic",
      authType: "apikey",
      name: "standalone-a",
      apiKey: "sk-test-standalone",
    });
    connId = conn.id;
  });

  it("discovers exhaustion standalone (no snapshot/poller involved)", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    const r = await auth.markAccountUnavailable(
      connId,
      400,
      CREDIT_400,
      "anthropic",
      "claude-haiku-4-5-20251001",
    );
    expect(r.shouldFallback).toBe(true);

    // No model lock or error status: the lock is connection-wide billing state.
    const locked = await db.getProviderConnectionByIdUnscoped(connId);
    expect(locked.billingLock).toMatchObject({ reason: "credit_exhausted" });
    expect(Object.keys(locked).filter((k) => k.startsWith("modelLock_"))).toEqual([]);

    // Same-ms re-lock attempt on an already-locked key does not re-stamp it.
    const gen = locked.billingLock.generation;
    await auth.markAccountUnavailable(connId, 400, CREDIT_400, "anthropic", "claude-x");
    expect((await db.getProviderConnectionByIdUnscoped(connId)).billingLock.generation).toBe(gen);
  }, 15000); // first auth.js import pulls the real module graph; bounded headroom under load

  it("unrelated successful traffic on the same key never clears the lock", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    const before = await db.getProviderConnectionByIdUnscoped(connId);
    await auth.clearAccountError(connId, before, "claude-x");
    expect((await db.getProviderConnectionByIdUnscoped(connId)).billingLock?.generation).toBe(
      before.billingLock.generation,
    );
  });

  it("scope guard: OAuth connections are never billing-locked", async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      email: "oauth@example.com",
      accessToken: "tok",
    });
    const auth = await import("../../src/sse/services/auth.js");
    await auth.markAccountUnavailable(conn.id, 400, CREDIT_400, "claude", "claude-x");
    expect((await db.getProviderConnectionByIdUnscoped(conn.id)).billingLock ?? null).toBeNull();
  });

  it("survives a reboot and probes by persisted due time (no burst)", async () => {
    const before = await db.getProviderConnectionByIdUnscoped(connId);
    const gen = before.billingLock.generation;

    // "Reboot": fresh module graph + DB handle over the same DATA_DIR.
    vi.resetModules();
    const db2 = await import("@/lib/db/index.js");
    await db2.initDb();
    const survived = await db2.getProviderConnectionByIdUnscoped(connId);
    expect(survived.billingLock?.generation).toBe(gen);

    // Scheduler after restart reads the PERSISTED nextProbeAt: not due -> no
    // probe burst; due -> probed. Uses the real repo, fake upstream.
    const { runBillingProbeTick } = await import("../../src/shared/services/billingProbe.js");
    const probed = [];
    const exec = vi.fn(async (args) => {
      probed.push(args.credentials.connectionId);
      return {
        response: new Response(
          JSON.stringify({
            type: "message",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 8, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      };
    });
    const deps = {
      getConnection: db2.getProviderConnectionByIdUnscoped,
      getMetadata: db2.getProviderConnectionByIdUnscoped,
      listActive: () => db2.getProviderConnectionsUnscoped({ isActive: true }),
      mutate: db2.mutateBillingLockUnscoped,
      getPricing: async () => ({ input: 1, output: 5 }),
      getExecutor: () => ({ execute: exec }),
      resolveConnectionProxyConfig: async () => ({}),
      saveDetail: async () => {},
    };
    await runBillingProbeTick(deps, { running: false });
    // nextProbeAt is ~3h out: this connection is not probed (other fixtures in
    // this DB with an already-due lock may be, so assert per connection).
    expect(probed).not.toContain(connId);

    // Make it due (as if the process was down past the probe time).
    await db2.mutateBillingLockUnscoped(connId, (live) => ({
      billingLock: {
        ...live.billingLock,
        nextProbeAt: new Date(Date.now() - 1000).toISOString(),
      },
    }));
    await runBillingProbeTick(deps, { running: false });
    expect(probed).toContain(connId);
    expect((await db2.getProviderConnectionByIdUnscoped(connId)).billingLock ?? null).toBeNull();
  }, 20000); // module reset + fresh adapter + migrations re-run are inherent work
});
