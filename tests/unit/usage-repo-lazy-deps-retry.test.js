// YAN-1106: usageRepo resolves its lazy pricing/grants imports once, but a FAILED
// import must not be cached: the next write retries and recovers. Failure is
// injected through a mock factory that throws on its first evaluation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  pricingFails: 0,
  grantsFails: 0,
  pricingLoads: 0,
  grantsLoads: 0,
}));

// vi.doMock (not vi.mock) in beforeEach: a fresh factory run per test, so every
// test starts from "not yet imported" like a cold process.
const registerMocks = () => {
  vi.doMock("@/lib/db/repos/pricingRepo.js", () => {
    gate.pricingLoads++;
    if (gate.pricingFails > 0) {
      gate.pricingFails--;
      throw new Error("pricingRepo import failed");
    }
    return { getPricingForModel: async () => ({ input: 1_000_000, output: 0 }) };
  });
  vi.doMock("@/lib/users/grants.js", () => {
    gate.grantsLoads++;
    if (gate.grantsFails > 0) {
      gate.grantsFails--;
      throw new Error("grants import failed");
    }
    return { resolveSharing: () => "personal" };
  });
};

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let usage;
let db;

beforeEach(async () => {
  gate.pricingFails = 0;
  gate.grantsFails = 0;
  gate.pricingLoads = 0;
  gate.grantsLoads = 0;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-usage-lazy-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  registerMocks();
  // Driver + usageRepo only: the db index would load the (mocked) pricing/grants
  // modules itself, so their first import must come from usageRepo's lazy loaders.
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  usage = await import("@/lib/db/repos/usageRepo.js");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.doUnmock("@/lib/db/repos/pricingRepo.js");
  vi.doUnmock("@/lib/users/grants.js");
  vi.restoreAllMocks();
  db?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const entry = (extra = {}) => ({
  provider: "openai",
  model: "gpt-4o",
  endpoint: "/v1/chat/completions",
  status: "ok",
  tokens: { prompt_tokens: 3, completion_tokens: 1 },
  ...extra,
});
const rows = () => db.get("SELECT COUNT(*) AS n FROM usageHistory").n;

describe("loadPricingDeps failure reset", () => {
  it("a failed import prices 0 once, then the next call retries and prices", async () => {
    gate.pricingFails = 1;
    const first = entry();
    await usage.saveRequestUsageUnscoped(first);
    expect(first.cost).toBe(0); // fail-soft on the failed load
    expect(gate.pricingLoads).toBe(1);

    const second = entry();
    await usage.saveRequestUsageUnscoped(second);
    expect(gate.pricingLoads).toBe(2); // retried, not a cached rejection
    expect(second.cost).toBe(3); // 3 prompt tokens at 1_000_000 per million

    const third = entry();
    await usage.saveRequestUsageUnscoped(third);
    expect(gate.pricingLoads).toBe(2); // success is memoized: no further import
    expect(third.cost).toBe(3);
  });

  it("repeated failures keep retrying (each call re-imports until it succeeds)", async () => {
    gate.pricingFails = 2;
    for (let i = 0; i < 2; i++) {
      const e = entry();
      await usage.saveRequestUsageUnscoped(e);
      expect(e.cost).toBe(0);
    }
    const ok = entry();
    await usage.saveRequestUsageUnscoped(ok);
    expect(ok.cost).toBe(3);
    expect(gate.pricingLoads).toBe(3);
  });
});

describe("loadResolveSharing failure reset", () => {
  const connect = () => {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt)
       VALUES('conn-1', 'openai', 'oauth', 'c', 1, 1, '{}', 'n', 'n')`,
    );
  };

  it("a failed grants import drops that write, the next call retries and marks notional", async () => {
    connect();
    gate.grantsFails = 1;
    await usage.saveRequestUsageUnscoped(entry({ connectionId: "conn-1", cost: 0 }));
    expect(rows()).toBe(0); // logged, not persisted
    expect(gate.grantsLoads).toBe(1);

    await usage.saveRequestUsageUnscoped(entry({ connectionId: "conn-1", cost: 0 }));
    expect(gate.grantsLoads).toBe(2); // retried
    expect(rows()).toBe(1);
    const meta = JSON.parse(db.get("SELECT meta FROM usageHistory").meta);
    expect(meta.notional).toBe(true);

    await usage.saveRequestUsageUnscoped(entry({ connectionId: "conn-1", cost: 0 }));
    expect(gate.grantsLoads).toBe(2); // memoized after success
    expect(rows()).toBe(2);
  });
});
