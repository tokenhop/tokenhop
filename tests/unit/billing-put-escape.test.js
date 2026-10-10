// YAN-1041: PUT /api/providers/[id] recovery escapes. A NEW api key or a
// disabled → enabled flip clears ONLY billing-owned state (transactional and
// conditional on the live row); model locks and auth state survive. Unrelated
// edits leave the lock alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-billing-put-"));
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

const lock = {
  reason: "credit_exhausted",
  code: "http_400",
  message: "Upstream reported exhausted credit or spend limit",
  lockedAt: "2026-01-01T00:00:00.000Z",
  nextProbeAt: "2026-01-01T03:00:00.000Z",
  lastProbeAt: null,
  lastProbeError: null,
  generation: 11,
};

async function put(id, body) {
  const route = await import("../../src/app/api/providers/[id]/route.js");
  const res = await route.PUT(
    new Request(`http://localhost/api/providers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

async function seed(extra = {}) {
  const conn = await db.createProviderConnectionUnscoped({
    provider: "anthropic",
    authType: "apikey",
    name: `escape-${Math.random().toString(36).slice(2, 8)}`,
    apiKey: "sk-old-key",
  });
  await db.updateProviderConnectionUnscoped(conn.id, {
    billingLock: lock,
    billingLockGeneration: 11,
    "modelLock_claude-x": new Date(Date.now() + 600_000).toISOString(),
    lastError: "auth failed earlier",
    errorCode: 401,
    ...extra,
  });
  return conn.id;
}

describe("PUT recovery escapes", () => {
  it("a new apiKey clears the billing lock, keeps model locks and auth state", async () => {
    const id = await seed();
    const { status, body } = await put(id, { apiKey: "sk-brand-new-key" });
    expect(status).toBe(200);
    expect(body.connection.billingLock ?? null).toBeNull();
    const after = await db.getProviderConnectionByIdUnscoped(id);
    expect(after.billingLock ?? null).toBeNull();
    expect(after["modelLock_claude-x"]).toBeTruthy();
    expect(after.lastError).toBe("auth failed earlier");
    expect(after.errorCode).toBe(401);
    expect(after.apiKey).toBe("sk-brand-new-key");
  });

  it("re-enabling a disabled connection clears the billing lock", async () => {
    const id = await seed();
    await db.updateProviderConnectionUnscoped(id, { isActive: false });
    const { status, body } = await put(id, { isActive: true });
    expect(status).toBe(200);
    expect(body.connection.billingLock ?? null).toBeNull();
    const after = await db.getProviderConnectionByIdUnscoped(id);
    expect(after.isActive).toBe(true);
    expect(after.billingLock ?? null).toBeNull();
    expect(after["modelLock_claude-x"]).toBeTruthy();
  });

  it("unrelated edits leave the lock in place", async () => {
    const id = await seed();
    const { status } = await put(id, { name: "renamed" });
    expect(status).toBe(200);
    const after = await db.getProviderConnectionByIdUnscoped(id);
    expect(after.billingLock?.reason).toBe("credit_exhausted");
  });

  it("the same apiKey does not clear the lock", async () => {
    const id = await seed();
    const { status } = await put(id, { apiKey: "sk-old-key" });
    expect(status).toBe(200);
    expect((await db.getProviderConnectionByIdUnscoped(id)).billingLock?.reason).toBe(
      "credit_exhausted",
    );
  });
});
