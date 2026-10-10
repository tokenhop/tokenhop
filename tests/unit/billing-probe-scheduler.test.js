// YAN-1041 scheduler: due filtering from the PERSISTED nextProbeAt (restart
// safety), concurrency cap, re-entry guard, idempotent start — plus the proxy
// plumbing for provider-specific connection proxies.
import { afterEach, describe, expect, it, vi } from "vitest";

const { CLAUDE_OK, lockOf, makeStore } = await import("./billing-probe-fixtures.js");
const probe = await import("../../src/shared/services/billingProbe.js");

function schedulerDeps(stores) {
  const exec = vi.fn(async (args) => {
    executed.push(args.credentials.connectionId);
    return { response: new Response(JSON.stringify(CLAUDE_OK), { status: 200 }) };
  });
  const executed = [];
  const byId = Object.fromEntries(stores.map((s) => [s.live.id, s]));
  return {
    executed,
    deps: {
      getConnection: async (id) => ({ ...byId[id].live }),
      getMetadata: async (id) => ({ ...byId[id].live }),
      listActive: async () => stores.map((s) => ({ ...s.live })),
      mutate: async (id, decide) => byId[id].mutate(id, decide),
      getPricing: async () => ({ input: 1, output: 5 }),
      getExecutor: () => ({ execute: exec }),
      resolveConnectionProxyConfig: async () => ({}),
      saveDetail: async () => {},
    },
  };
}

const store = (id, extra) => makeStore({ id, billingLock: lockOf(100, extra) });

afterEach(() => probe.stopBillingProbe());

describe("billing probe scheduler", () => {
  it("probes only connections whose persisted nextProbeAt is due (restart-safe)", async () => {
    const due = store("due-1");
    const later = store("later-1", { nextProbeAt: new Date(Date.now() + 3600_000).toISOString() });
    const { deps, executed } = schedulerDeps([due, later]);
    await probe.runBillingProbeTick(deps, { running: false });
    expect(executed).toEqual(["due-1"]);
    expect(due.live.billingLock ?? null).toBeNull(); // cleared
    expect(later.live.billingLock).toBeTruthy();
  });

  it("caps probes per tick at the configured concurrency (2)", async () => {
    const a = store("a");
    const b = store("b");
    const c = store("c");
    const { deps, executed } = schedulerDeps([a, b, c]);
    await probe.runBillingProbeTick(deps, { running: false });
    expect(executed).toHaveLength(2);
  });

  it("re-entry guard: a running tick is not re-entered", async () => {
    const { deps } = schedulerDeps([store("a")]);
    deps.listActive = vi.fn(async () => {
      throw new Error("must not run");
    });
    await probe.runBillingProbeTick(deps, { running: true });
    expect(deps.listActive).not.toHaveBeenCalled();
  });

  it("logs the reason when a probe in the tick rejects", async () => {
    const { deps } = schedulerDeps([store("boom")]);
    deps.getConnection = async () => {
      throw new Error("db exploded");
    };
    const lines = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
    try {
      await probe.runBillingProbeTick(deps, { running: false });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes("probe threw: db exploded"))).toBe(true);
  });

  it("startBillingProbe is idempotent and stop clears the timer", async () => {
    probe.startBillingProbe();
    const timer = global.__billingProbe.interval;
    expect(timer).toBeTruthy();
    probe.startBillingProbe();
    expect(global.__billingProbe.interval).toBe(timer);
    probe.stopBillingProbe();
    expect(global.__billingProbe.interval).toBeNull();
    probe.stopBillingProbe(); // idempotent too
  });
});

describe("provider-specific proxy plumbing", () => {
  it("the connection's resolved proxy config reaches the executor", async () => {
    const st = store("px-1");
    st.live.apiKey = "sk-test-px";
    st.live.providerSpecificData = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
    };
    const proxyCfg = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "https://relay.example.com",
      strictProxy: true,
      proxyPoolId: "pool-7",
    };
    const exec = vi.fn(async () => ({
      response: new Response(JSON.stringify(CLAUDE_OK), { status: 200 }),
    }));
    const deps = {
      getConnection: async () => ({ ...st.live }),
      getMetadata: async () => ({ ...st.live }),
      listActive: async () => [{ ...st.live }],
      mutate: async (id, decide) => st.mutate(id, decide),
      getPricing: async () => ({ input: 1, output: 5 }),
      getExecutor: () => ({ execute: exec }),
      resolveConnectionProxyConfig: async () => proxyCfg,
      saveDetail: async () => {},
    };
    const r = await probe.probeBillingConnection("px-1", { deps });
    expect(r.result).toBe("cleared");
    expect(exec.mock.calls[0][0].proxyOptions).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "https://relay.example.com",
      strictProxy: true,
      connectionProxyPoolId: "pool-7",
    });
    expect(exec.mock.calls[0][0].credentials.apiKey).toBe(st.live.apiKey);
  });
});
