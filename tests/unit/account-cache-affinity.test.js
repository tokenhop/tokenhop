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

const { accountPins, accountPinKey, pendingAccountPins } = await import(
  "open-sse/services/cacheAffinity.js"
);
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

// A served turn commits its pin (chat.js does this once the account answered);
// `commit: false` models a selection that never served.
async function turn(conversationKey, { exclude = null, commit = true, ...opts } = {}) {
  const res = await getProviderCredentials("p", exclude, "m", { conversationKey, ...opts });
  if (commit) res?.affinity?.commit();
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
  pendingAccountPins.clear();
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

describe("commit on serve (YAN-1222)", () => {
  const select = (conversationKey = "conv1", opts = {}) =>
    getProviderCredentials("p", null, "m", { conversationKey, ...opts });

  it("selection alone writes no committed pin; commit does", async () => {
    const creds = await select();
    expect(accountPins.size).toBe(0);
    expect(pendingAccountPins.size).toBe(1);
    creds.affinity.commit();
    expect(accountPins.size).toBe(1);
    expect(pendingAccountPins.size).toBe(0);
    expect(await turn("conv1", { commit: false })).toBe(creds.connectionId);
  });

  it("a released selection leaves no pin and the strategy picks again", async () => {
    const first = await select();
    first.affinity.release();
    expect(accountPins.size).toBe(0);
    expect(pendingAccountPins.size).toBe(0);
    const second = await select("conv1", {});
    expect(second.connectionId).not.toBe(first.connectionId); // round-robin advanced
  });

  it("concurrent first turns of one conversation converge on one account", async () => {
    const [a, b] = await Promise.all([select(), select()]);
    expect(b.connectionId).toBe(a.connectionId);
    expect(mocks.update).toHaveBeenCalledTimes(1); // the strategy ran once
    expect(accountPins.size).toBe(0);
  });

  it("a proxy resolution throw never writes a provisional pin", async () => {
    const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy");
    resolveConnectionProxyConfig.mockRejectedValueOnce(new Error("proxy unavailable"));
    await expect(select()).rejects.toThrow("proxy unavailable");
    expect(pendingAccountPins.size).toBe(0);
    expect(accountPins.size).toBe(0);
  });

  it("releasing the follower never drops the leader's provisional pin", async () => {
    const [leader, follower] = await Promise.all([select(), select()]);
    follower.affinity.release();
    expect(pendingAccountPins.size).toBe(1);
    expect((await select()).connectionId).toBe(leader.connectionId);
    leader.affinity.release();
    expect(pendingAccountPins.size).toBe(0);
  });

  it("another conversation or workspace is not affected by a pending pin", async () => {
    mocks.rows = [
      row("a1", 1, { workspaceId: "wsA" }),
      row("a2", 2, { workspaceId: "wsA" }),
      row("b1", 1, { workspaceId: "wsB" }),
    ];
    const a = await select("conv1", { principal: { workspaceId: "wsA" } });
    const other = await select("conv2", { principal: { workspaceId: "wsA" } });
    const b = await select("conv1", { principal: { workspaceId: "wsB" } });
    expect(other.connectionId).not.toBe(a.connectionId);
    expect(b.connectionId).toBe("b1");
  });

  it("returns no affinity handle without a conversation, when disabled, or for fill-first", async () => {
    expect((await select(null)).affinity).toBeUndefined();
    mocks.settings = { providerStrategies: { p: { ...RR, cacheAffinity: false } } };
    expect((await select()).affinity).toBeUndefined();
    mocks.settings = {};
    expect((await select()).affinity).toBeUndefined();
    expect(pendingAccountPins.size).toBe(0);
  });

  it("an explicit x-connection-id selection has no handle and writes nothing", async () => {
    const creds = await select("conv1", { preferredConnectionId: "c2" });
    expect(creds.connectionId).toBe("c2");
    expect(creds.affinity).toBeUndefined();
    expect(pendingAccountPins.size).toBe(0);
  });
});

describe("pinned lastUsedAt throttle (YAN-1224)", () => {
  it("writes lastUsedAt at most once per minute and never the sticky counter", async () => {
    const first = await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(1); // fresh lastUsedAt: no write

    const pinned = mocks.rows.find((r) => r.id === first);
    pinned.lastUsedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    pinned.consecutiveUseCount = 7;
    await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(2);
    const [id, patch] = mocks.update.mock.calls[1];
    expect(id).toBe(first);
    expect(Object.keys(patch)).toEqual(["lastUsedAt"]);
    expect(pinned.consecutiveUseCount).toBe(7);
    await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(2); // refreshed: throttled again
  });

  it("a pinned connection that never had lastUsedAt gets one write", async () => {
    mocks.rows = [row("c1", 1)];
    const first = await turn("conv1");
    delete mocks.rows.find((r) => r.id === first).lastUsedAt;
    mocks.update.mockClear();
    await turn("conv1");
    expect(mocks.update).toHaveBeenCalledTimes(1);
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

  it("resetAccountSelection({ workspaceId }) clears only that workspace", async () => {
    mocks.rows = [row("a1", 1, { workspaceId: "wsA" }), row("b1", 1, { workspaceId: "wsB" })];
    await turn("conv1", { principal: { workspaceId: "wsA" } });
    await turn("conv1", { principal: { workspaceId: "wsB" } });
    expect(accountPins.size).toBe(2);
    resetAccountSelection(undefined, { workspaceId: "wsA" });
    expect(accountPins.size).toBe(1);
    expect(accountPins.get(accountPinKey("wsB", "p", "conv1"))).toBe("b1");
    resetAccountSelection("p", { workspaceId: "wsB" });
    expect(accountPins.size).toBe(0);
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

describe("deferred commit (YAN-1673)", () => {
  const key = () => accountPinKey(null, "p", "conv1");

  it("a late deferred commit never replaces a pin written meanwhile", async () => {
    accountPins.clear();
    const panel = await getProviderCredentials("p", null, "m", { conversationKey: "conv1" });
    const commitLater = panel.affinity.deferredCommit(); // panel served; its outer level decides later
    accountPins.set(key(), "c3"); // the judge failed over to c3 and served
    commitLater();
    expect(accountPins.peek(key())).toBe("c3");
    expect(pendingAccountPins.peek(key())).toBeUndefined(); // the panel's pending pin is released
  });

  it("commits when nothing else pinned the conversation meanwhile", async () => {
    accountPins.clear();
    const panel = await getProviderCredentials("p", null, "m", { conversationKey: "conv1" });
    panel.affinity.deferredCommit()();
    expect(accountPins.peek(key())).toBe(panel.connectionId);
  });

  it("a reset between serve and the deferred commit leaves no pin (YAN-1676)", async () => {
    accountPins.clear();
    const panel = await getProviderCredentials("p", null, "m", { conversationKey: "conv1" });
    const commitLater = panel.affinity.deferredCommit();
    resetAccountSelection("p"); // routing-settings reset lands before the outer level commits
    commitLater();
    expect(accountPins.peek(key())).toBeUndefined();
  });
});
