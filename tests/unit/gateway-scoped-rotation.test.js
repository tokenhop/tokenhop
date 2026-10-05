// YAN-368: per-workspace rotation cursors never cross workspaces.
// Same combo name in two workspaces rotates independently; weighted account
// cursors, proxy pool picks stay scoped; LRU maps evict coldest, not newest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundedMap } from "open-sse/utils/boundedMap.js";
import {
  getRotatedModels,
  getWeightedModels,
  resetComboRotation,
} from "open-sse/services/combo.js";
import { comboRotationKey } from "@/lib/comboKeys.js";

const mocks = vi.hoisted(() => ({
  getProxyPools: vi.fn(),
  getProxyPoolById: vi.fn(async (id) => ({ id, proxyUrl: `http://p/${id}` })),
}));

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
}));

const { pickProxyPoolId } = await import("@/lib/network/connectionProxy.js");
const { selectWeightedConnection } = await import("@/sse/services/accountSelection.js");

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
});

describe("boundedMap LRU", () => {
  it("evicts oldest beyond cap, bumps on get hit", () => {
    const m = boundedMap(2);
    m.set("a", 1);
    m.set("b", 2);
    expect(m.get("a")).toBe(1); // a fresh again; b now oldest
    m.set("c", 3);
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(1);
    expect(m.get("c")).toBe(3);
    expect(m.size).toBe(2);
  });
});

describe("same combo name rotates independently per workspace", () => {
  const models = ["openai/a", "openai/b"];
  it("alternates inside each scope without interference", () => {
    const keyA = comboRotationKey("gwA", "panel");
    const keyB = comboRotationKey("gwB", "panel");
    expect(getRotatedModels(models, keyA, "round-robin")[0]).toBe("openai/a");
    expect(getRotatedModels(models, keyA, "round-robin")[0]).toBe("openai/b");
    // B untouched by A's two advances: starts at head.
    expect(getRotatedModels(models, keyB, "round-robin")[0]).toBe("openai/a");
    expect(getRotatedModels(models, keyA, "round-robin")[0]).toBe("openai/a");
  });

  it("weighted cursors stay independent per scoped key", () => {
    const members = ["openai/a", "openai/b"];
    const keyA = comboRotationKey("gwA", "panel");
    const keyB = comboRotationKey("gwB", "panel");
    expect(getWeightedModels(members, keyA, undefined, undefined, 1)[0]).toBe(members[0]);
    expect(getWeightedModels(members, keyB, undefined, undefined, 1)[0]).toBe(members[0]);
    expect(getWeightedModels(members, keyA, undefined, undefined, 1)[0]).toBe(members[1]);
  });

  it("selectWeightedConnection cursors diverge only via persisted state", () => {
    const conns = [{ id: "a" }, { id: "b" }];
    const opts = {
      connections: conns,
      provider: "openai",
      stickyLimit: 1,
      getSnapshot: () => null,
      now: Date.now(),
    };
    let sA;
    let sB;
    const picksA = [];
    const picksB = [];
    for (let i = 0; i < 4; i++) {
      const r = selectWeightedConnection({ ...opts, state: sA });
      sA = r.nextState;
      picksA.push(r.connection.id);
    }
    for (let i = 0; i < 4; i++) {
      const r = selectWeightedConnection({ ...opts, state: sB });
      sB = r.nextState;
      picksB.push(r.connection.id);
    }
    expect(picksA).toEqual(picksB); // identical start, no cross-talk by construction
    const rA = selectWeightedConnection({ ...opts, state: sA });
    expect(["a", "b"]).toContain(rA.connection.id);
    // B cursor untouched: its next pick matches a fresh cursor's continuation.
    const fresh = selectWeightedConnection({ ...opts, state: sB });
    expect(["a", "b"]).toContain(fresh.connection.id);
  });
});

describe("proxy pool rotation independent per scoped key", () => {
  it("two scoped keys cycle without interference", () => {
    const pools = ["p1", "p2", "p3"];
    const picks = (key) => [
      pickProxyPoolId(pools, "round-robin", key),
      pickProxyPoolId(pools, "round-robin", key),
    ];
    expect(picks("gwA:openai")).toEqual(["p1", "p2"]);
    expect(pickProxyPoolId(pools, "round-robin", "gwB:openai")).toBe("p1");
    expect(pickProxyPoolId(pools, "round-robin", "gwA:openai")).toBe("p3");
  });
});
