// YAN-1213: conversation cache affinity for provider accounts. A pin is honored
// only inside the already-filtered available set and written after reservations.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [],
  settings: {},
  update: vi.fn(),
  reserveBudget: vi.fn(() => null),
  info: vi.fn(),
}));

const rowsFor = (workspaceId) =>
  mocks.rows
    .filter(
      (r) => r.isActive !== false && (workspaceId === undefined || r.workspaceId === workspaceId),
    )
    .map((r) => ({ ...r }));

vi.mock("open-sse/config/runtimeConfig.js", async (importActual) => ({
  ...(await importActual()),
  CACHE_AFFINITY_TTL_MS: 150,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionsUnscoped: vi.fn(async () => rowsFor()),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnectionUnscoped: mocks.update,
}));
vi.mock("@/lib/db/index.js", () => ({
  getEffectivePreferences: vi.fn(async () => mocks.settings),
}));
vi.mock("@/lib/auth/gatewayResources.js", () => ({
  getGatewayConnections: vi.fn(async (principal) => rowsFor(principal.workspaceId)),
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
vi.mock("@/sse/services/budgetGuard.js", () => ({
  budgetLimitedResult: (limit) => ({ allRateLimited: true, budgetLimit: limit }),
  grantBudgetContext: () => null,
  grantBudgetLimit: () => null,
  reserveGrantBudget: mocks.reserveBudget,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: mocks.info, warn: vi.fn() }));

const { accountPins } = await import("open-sse/services/cacheAffinity.js");
const { getProviderCredentials, resetAccountSelection } = await import("@/sse/services/auth.js");

const RR = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 };
const WEIGHTED = { fallbackStrategy: "weighted" };
const row = (id, priority, extra = {}) => ({
  id,
  provider: "p",
  priority,
  isActive: true,
  ...extra,
});
const ids = () => mocks.rows.map((r) => r.id);

// Apply persisted rotation patches so round-robin behaves like the real store.
mocks.update.mockImplementation(async (id, patch) => {
  Object.assign(
    mocks.rows.find((r) => r.id === id),
    patch,
  );
});

async function turn(conversationKey, { exclude = null, ...opts } = {}) {
  const res = await getProviderCredentials("p", exclude, "m", { conversationKey, ...opts });
  return res?.connectionId ?? res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockImplementation(async (id, patch) => {
    Object.assign(
      mocks.rows.find((r) => r.id === id),
      patch,
    );
  });
  mocks.reserveBudget.mockReturnValue(null);
  mocks.rows = [row("c1", 1), row("c2", 2), row("c3", 3)];
  mocks.settings = { providerStrategies: { p: RR } };
  resetAccountSelection();
});

describe.each([
  ["round-robin", RR],
  ["weighted", WEIGHTED],
])("pin precedence (%s)", (_name, strategy) => {
  beforeEach(() => {
    mocks.settings = { providerStrategies: { p: strategy } };
  });

  it("keeps one conversation on one account and persists rotation only on turn 1", async () => {
    const first = await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) expect(await turn("conv1")).toBe(first);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("drops a pinned account whose weight is drained to 0", async () => {
    const first = await turn("conv1");
    const pinned = mocks.rows.find((r) => r.id === first);
    pinned.providerSpecificData = { weight: 0 };
    if (strategy === WEIGHTED) expect(await turn("conv1")).not.toBe(first);
    else expect(await turn("conv1")).toBe(first); // weight only gates weighted
  });
});

describe("conversation isolation", () => {
  it("spreads new conversations across accounts via the strategy", async () => {
    const picks = [await turn("conv1"), await turn("conv2"), await turn("conv3")];
    expect(new Set(picks).size).toBe(3);
    expect(await turn("conv1")).toBe(picks[0]);
    expect(await turn("conv2")).toBe(picks[1]);
  });
});

describe("pin never bypasses availability", () => {
  const futureIso = () => new Date(Date.now() + 600_000).toISOString();
  const cases = [
    [
      "model lock",
      (id) =>
        Object.assign(
          mocks.rows.find((r) => r.id === id),
          { modelLock_m: futureIso() },
        ),
      (id) => delete mocks.rows.find((r) => r.id === id).modelLock_m,
    ],
    [
      "billing lock",
      (id) =>
        Object.assign(
          mocks.rows.find((r) => r.id === id),
          {
            billingLock: { reason: "credit_exhausted", nextProbeAt: futureIso() },
          },
        ),
      (id) => delete mocks.rows.find((r) => r.id === id).billingLock,
    ],
  ];

  it.each(cases)(
    "skips a %s pin, re-pins the replacement, and stays there",
    async (_n, lock, unlock) => {
      const pinned = await turn("conv1");
      lock(pinned);
      const replacement = await turn("conv1");
      expect(replacement).not.toBe(pinned);
      unlock(pinned);
      expect(await turn("conv1")).toBe(replacement);
    },
  );

  it("skips an excluded pin and re-pins the replacement", async () => {
    const pinned = await turn("conv1");
    const replacement = await turn("conv1", { exclude: new Set([pinned]) });
    expect(replacement).not.toBe(pinned);
    expect(await turn("conv1")).toBe(replacement);
  });

  it("skips a pinned grant that went over its rpm and re-pins", async () => {
    mocks.rows = [row("g", 1, { grantId: "g1", grantRpm: 1 }), row("own", 2)];
    expect(await turn("conv1")).toBe("g"); // reserves the only rpm slot
    expect(await turn("conv1")).toBe("own");
    expect(await turn("conv1")).toBe("own");
  });

  it("writes no pin when the grant budget reservation fails", async () => {
    mocks.rows = [row("g", 1, { grantId: "g2" })];
    mocks.reserveBudget.mockReturnValueOnce({ hit: { budget: {} } });
    const res = await getProviderCredentials("p", null, "m", { conversationKey: "conv1" });
    expect(res.allRateLimited).toBe(true);
    expect(accountPins.size).toBe(0);
  });
});

describe("x-connection-id", () => {
  it("wins over the pin and neither writes nor changes it", async () => {
    const pinned = await turn("conv1");
    const other = ids().find((id) => id !== pinned);
    expect(await turn("conv1", { preferredConnectionId: other })).toBe(other);
    expect(accountPins.size).toBe(1);
    expect(await turn("conv1")).toBe(pinned);
  });

  it("writes no pin when it is the first call", async () => {
    await turn("conv1", { preferredConnectionId: "c2" });
    expect(accountPins.size).toBe(0);
  });
});

describe("workspace isolation", () => {
  it("never returns a pin from one workspace to another", async () => {
    mocks.rows = [
      row("a1", 1, { workspaceId: "wsA" }),
      row("a2", 2, { workspaceId: "wsA" }),
      row("b1", 1, { workspaceId: "wsB" }),
    ];
    const a = await turn("conv1", { principal: { workspaceId: "wsA" } });
    const b = await turn("conv1", { principal: { workspaceId: "wsB" } });
    expect(a).toMatch(/^a/);
    expect(b).toBe("b1");
    expect(accountPins.size).toBe(2);
    expect(await turn("conv1", { principal: { workspaceId: "wsA" } })).toBe(a);
    expect(await turn("conv1", { principal: { workspaceId: "wsB" } })).toBe("b1");
  });
});

describe("gating", () => {
  it("fill-first has no pin effect", async () => {
    mocks.settings = {};
    for (let i = 0; i < 3; i++) expect(await turn("conv1")).toBe("c1");
    expect(accountPins.size).toBe(0);
  });

  it("providerStrategies.p.cacheAffinity:false rotates per turn as today", async () => {
    mocks.settings = { providerStrategies: { p: { ...RR, cacheAffinity: false } } };
    expect([await turn("conv1"), await turn("conv1"), await turn("conv1")]).toEqual(ids());
    expect(accountPins.size).toBe(0);
  });

  it("no conversationKey behaves as today", async () => {
    expect([await turn(null), await turn(null), await turn(null)]).toEqual(ids());
    expect(accountPins.size).toBe(0);
  });
});

describe("expiry, reset and logging", () => {
  it("lets the strategy pick again after the pin TTL expires", async () => {
    const first = await turn("conv1");
    await new Promise((r) => setTimeout(r, 260));
    expect(await turn("conv1")).not.toBe(first);
  });

  it("resetAccountSelection('p') clears that provider's pins", async () => {
    await turn("conv1");
    expect(accountPins.size).toBe(1);
    resetAccountSelection("p");
    expect(accountPins.size).toBe(0);
  });

  it("never logs the raw conversation key", async () => {
    await turn("raw-secret-key");
    await turn("raw-secret-key");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("raw-secret-key");
    expect(mocks.info.mock.calls.some(([, msg]) => msg.includes("cache pin"))).toBe(true);
  });
});
