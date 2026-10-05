// YAN-368: account selection serializes per workspace:provider, not globally.
// Two workspaces' selections overlap; same workspace:provider and the legacy
// (no-principal) path still run one at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";

const DELAY_MS = 20;
const mocks = vi.hoisted(() => ({ active: 0, maxActive: 0 }));

async function slowRead(id) {
  mocks.active++;
  mocks.maxActive = Math.max(mocks.maxActive, mocks.active);
  await new Promise((r) => setTimeout(r, DELAY_MS));
  mocks.active--;
  return [{ id, provider: "openai", isActive: true, priority: 1 }];
}

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionsUnscoped: vi.fn(() => slowRead("legacy")),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({ getEffectivePreferences: vi.fn(async () => ({})) }));
vi.mock("@/lib/auth/gatewayResources.js", () => ({
  getGatewayConnections: vi.fn((principal) => slowRead(`${principal.workspaceId}-conn`)),
  requireGatewayWorkspace: vi.fn(async () => {}),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const principal = (workspaceId) => ({ workspaceId });

async function run(calls) {
  mocks.active = 0;
  mocks.maxActive = 0;
  const start = performance.now();
  const results = await Promise.all(calls.map((fn) => fn()));
  return { results, ms: performance.now() - start, maxActive: mocks.maxActive };
}

beforeEach(() => vi.clearAllMocks());

describe("per-workspace selection mutex", () => {
  it("two workspaces overlap and each gets its own connection", async () => {
    const N = 20;
    const calls = Array.from({ length: N }, (_, i) => {
      const ws = i % 2 ? "wsB" : "wsA";
      return () => getProviderCredentials("openai", null, null, { principal: principal(ws) });
    });
    const { results, ms, maxActive } = await run(calls);
    results.forEach((r, i) => {
      expect(r.connectionId ?? r.id).toBe(`${i % 2 ? "wsB" : "wsA"}-conn`);
    });
    expect(maxActive).toBe(2);
    const serialized = N * DELAY_MS;
    console.log(
      `[bench] ${N} alternating selections: ${ms.toFixed(0)}ms vs ~${serialized}ms serialized`,
    );
    expect(serialized / ms).toBeGreaterThanOrEqual(1.5);
  });

  it("same workspace:provider still serializes", async () => {
    const calls = Array.from(
      { length: 4 },
      () => () => getProviderCredentials("openai", null, null, { principal: principal("wsA") }),
    );
    expect((await run(calls)).maxActive).toBe(1);
  });

  it("legacy no-principal path keeps one global chain", async () => {
    const calls = Array.from({ length: 4 }, () => () => getProviderCredentials("openai"));
    expect((await run(calls)).maxActive).toBe(1);
  });
});
