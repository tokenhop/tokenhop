// YAN-1106: per-request hot-path savings must not change results or weaken
// invalidation. Covers the JSON cloner behind mergeWithDefaults, the pricing
// memo (writer-side invalidation), and the per-request chat lookups.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignOwnData, cloneJson } from "@/lib/db/helpers/cloneJson.js";
import { DEFAULT_SETTINGS, mergeWithDefaults } from "@/lib/db/repos/settingsRepo.js";
import {
  MODEL_CACHE_MAX,
  getPricingForModel,
  resetPricing,
  updatePricing,
  invalidatePricingCache,
} from "@/lib/db/repos/pricingRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { createChatLookups } from "@/sse/handlers/chatLookups.js";
import { revokedKeyTarget } from "@/sse/handlers/chatRevocation.js";
import { getPricingForModel as resolveDefaults } from "../../open-sse/providers/pricing.js";

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};

describe("cloneJson", () => {
  it("deep-copies plain JSON and keeps shape", () => {
    const src = { a: 1, b: [1, { c: 2 }], d: { e: null, f: "x" } };
    const out = cloneJson(src);
    expect(out).toEqual(src);
    expect(out.b).not.toBe(src.b);
    expect(out.b[1]).not.toBe(src.b[1]);
    expect(out.d).not.toBe(src.d);
  });

  it("delegates non-plain values to structuredClone", () => {
    const when = new Date(0);
    const out = cloneJson({ when });
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when).not.toBe(when);
  });

  it("keeps a stored own __proto__ key as data, never a prototype", () => {
    const src = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const out = cloneJson(src);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect({}.polluted).toBeUndefined();
  });
});

describe("assignOwnData", () => {
  it("copies an own __proto__ key as data and leaves the prototype alone", () => {
    const target = { keep: 1 };
    const source = JSON.parse('{"__proto__":{"polluted":true},"startPage":"/x"}');
    assignOwnData(target, cloneJson(source));
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target.polluted).toBeUndefined();
    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(target).toMatchObject({ keep: 1, startPage: "/x" });
    expect({}.polluted).toBeUndefined();
  });

  it("overrides existing keys like Object.assign", () => {
    expect(assignOwnData({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });
});

describe("mergeWithDefaults isolation", () => {
  it("every call returns independent nested objects (defaults never shared)", () => {
    const defaults = structuredClone(DEFAULT_SETTINGS);
    const a = mergeWithDefaults({ requireApiKey: false });
    const b = mergeWithDefaults({});
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const v = a[key];
      if (v && typeof v === "object") {
        expect(v).not.toBe(DEFAULT_SETTINGS[key]);
        expect(v).not.toBe(b[key]);
      }
    }
    a.retryPolicy[502].tries = 99;
    a.capacityAdapter.vision.models.push("evil");
    a.ssoAllowedGroups.push("evil");
    a.comboStrategies.x = 1;
    expect(DEFAULT_SETTINGS).toEqual(defaults);
    expect(mergeWithDefaults({})).toEqual(defaults);
  });

  it("works on deep-frozen input without mutating or sharing it", () => {
    const input = deepFreeze({
      providerThinking: { claude: { mode: "high" } },
      retryPolicy: { 502: { tries: 5 } },
      cooldowns: { longMs: 7 },
    });
    const out = mergeWithDefaults(input);
    expect(out.providerThinking).toEqual({ claude: { mode: "high" } });
    expect(out.providerThinking).not.toBe(input.providerThinking);
    expect(out.retryPolicy[502]).toEqual({ tries: 5, delayMs: 3000 });
    expect(out.retryPolicy[503]).toEqual(DEFAULT_SETTINGS.retryPolicy[503]);
    expect(out.cooldowns.longMs).toBe(7);
    expect(out.cooldowns.shortMs).toBe(DEFAULT_SETTINGS.cooldowns.shortMs);
    out.providerThinking.claude.mode = "evil";
    expect(input.providerThinking.claude.mode).toBe("high");
  });

  it("is safe when DEFAULT_SETTINGS nested values are frozen copies", () => {
    // Results are mutable even though the source of truth could be frozen.
    const out = mergeWithDefaults(deepFreeze({ startPage: "/x" }));
    expect(Object.isFrozen(out.retryPolicy)).toBe(false);
    out.retryPolicy[503].tries = 1;
    expect(DEFAULT_SETTINGS.retryPolicy[503].tries).toBe(3);
  });

  it("keeps stored values over defaults, including falsy ones", () => {
    const out = mergeWithDefaults({ outboundProxyUrl: "http://p", requireApiKey: false });
    expect(out.outboundProxyUrl).toBe("http://p");
    expect(out.outboundProxyEnabled).toBe(DEFAULT_SETTINGS.outboundProxyEnabled);
    expect(out.requireApiKey).toBe(false);
  });
});

describe("pricing memo", () => {
  beforeEach(async () => {
    const db = await getAdapter();
    db.run("DELETE FROM kv WHERE scope = 'pricing'");
    invalidatePricingCache();
  });

  it("serves repeats from memory (one kv read) and returns equal values", async () => {
    const db = await getAdapter();
    await updatePricing({ openai: { "gpt-4o": { input: 1.5 } } });
    const get = vi.spyOn(db, "get");
    try {
      const first = await getPricingForModel("openai", "gpt-4o");
      const second = await getPricingForModel("openai", "gpt-4o");
      expect(second).toEqual(first);
      expect(first).toEqual({ ...resolveDefaults("openai", "gpt-4o"), input: 1.5 });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
    }
  });

  it("updatePricing / resetPricing / invalidatePricingCache take effect immediately", async () => {
    await updatePricing({ openai: { "gpt-4o": { input: 1 } } });
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(1);
    await updatePricing({ openai: { "gpt-4o": { input: 2 } } });
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(2);
    await resetPricing("openai", "gpt-4o");
    expect(await getPricingForModel("openai", "gpt-4o")).toEqual(
      resolveDefaults("openai", "gpt-4o"),
    );
    // A direct kv edit (restore/import path) is picked up once the hook fires.
    const db = await getAdapter();
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', 'openai', ?)`, [
      JSON.stringify({ "gpt-4o": { input: 9 } }),
    ]);
    invalidatePricingCache();
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(9);
  });

  it("a read that raced a write never caches the stale value", async () => {
    await updatePricing({ openai: { "gpt-4o": { input: 1 } } });
    const db = await getAdapter();
    const realGet = db.get.bind(db);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const get = vi.spyOn(db, "get").mockImplementation((...args) => realGet(...args));
    const pending = (async () => {
      await gate;
      return getPricingForModel("openai", "gpt-4o");
    })();
    // Start the read, then write before it settles.
    release();
    const racing = getPricingForModel("openai", "gpt-4o");
    await updatePricing({ openai: { "gpt-4o": { input: 5 } } });
    await Promise.all([pending, racing]);
    get.mockRestore();
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(5);
  });

  it("keys on provider and model exactly (no alias or prefix folding)", async () => {
    await updatePricing({ openai: { "gpt-4o": { input: 1 } } });
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(1);
    expect(await getPricingForModel("other", "gpt-4o")).toEqual(resolveDefaults("other", "gpt-4o"));
    expect(await getPricingForModel("openai", "")).toBeNull();
  });
});

describe("chat lookups (per request)", () => {
  const fresh = () => createChatLookups(null);

  it("instances never share state", async () => {
    const a = fresh();
    const b = fresh();
    expect(a).not.toBe(b);
    const [x, y] = await Promise.all([a.modelInfo("openai/gpt-4o"), b.modelInfo("openai/gpt-4o")]);
    expect(x).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(y).toEqual(x);
  });

  it("memoizes within a request and returns the same resolved object", async () => {
    const l = fresh();
    const p1 = l.modelInfo("openai/gpt-4o");
    const p2 = l.modelInfo("openai/gpt-4o");
    expect(p1).toBe(p2);
    expect(await p1).toBe(await p2);
    expect(await l.comboModels("openai/gpt-4o")).toBeNull();
  });

  it("does not cache a rejected lookup", async () => {
    const l = createChatLookups({ workspaceId: "w" }); // unfrozen: requireGatewayWorkspace rejects
    const first = l.modelInfo("gpt-4o");
    await expect(first).rejects.toThrow();
    const second = l.modelInfo("gpt-4o");
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });
});

describe("pricing memo bound and immutability", () => {
  beforeEach(async () => {
    const db = await getAdapter();
    db.run("DELETE FROM kv WHERE scope = 'pricing'");
    invalidatePricingCache();
  });

  it("caps the memo: attacker-chosen model ids cannot grow it past the limit", async () => {
    const db = await getAdapter();
    const get = vi.spyOn(db, "get");
    try {
      // Distinct ids, none cached twice.
      for (let i = 0; i < MODEL_CACHE_MAX + 50; i++) {
        await getPricingForModel("openai", `junk-model-${i}`);
      }
      get.mockClear();
      // Oldest entries were evicted (re-read hits kv), newest are still memoized.
      await getPricingForModel("openai", "junk-model-0");
      expect(get).toHaveBeenCalledTimes(1);
      get.mockClear();
      await getPricingForModel("openai", `junk-model-${MODEL_CACHE_MAX + 49}`);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it("sweeps expired entries on insert", async () => {
    const db = await getAdapter();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const get = vi.spyOn(db, "get");
    try {
      await getPricingForModel("openai", "gpt-4o");
      clock.mockReturnValue(now + 60_000); // past the TTL
      await getPricingForModel("openai", "other-model"); // insert sweeps gpt-4o
      get.mockClear();
      clock.mockReturnValue(now + 60_001);
      await getPricingForModel("openai", "gpt-4o");
      expect(get).toHaveBeenCalledTimes(1); // re-read: it had expired
    } finally {
      clock.mockRestore();
      get.mockRestore();
    }
  });

  it("returns frozen values so a caller cannot poison later reads", async () => {
    await updatePricing({ openai: { "gpt-4o": { input: 2 } } });
    const first = await getPricingForModel("openai", "gpt-4o");
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first.input = 999;
    }).toThrow();
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(2);
    // The shared default table is never frozen or aliased.
    expect(Object.isFrozen(resolveDefaults("openai", "gpt-4o"))).toBe(false);
  });
});

describe("chat lookups are immutable once shared", () => {
  it("hands out deep-frozen results", async () => {
    const info = await createChatLookups(null).modelInfo("openai/gpt-4o");
    expect(Object.isFrozen(info)).toBe(true);
    expect(info).toEqual({ provider: "openai", model: "gpt-4o" });
  });
});

describe("revokedKeyTarget storage guard", () => {
  it("keyless principals are not checked", async () => {
    expect(await revokedKeyTarget(null, "openai/gpt-4o")).toBeNull();
    expect(await revokedKeyTarget({ apiKeyId: null }, "openai/gpt-4o")).toBeNull();
  });

  it("legacy storage denies (403) without issuing the keyHash query", async () => {
    const db = await getAdapter();
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    try {
      const res = await revokedKeyTarget({ apiKeyId: "some-key" }, "openai/gpt-4o");
      expect(res?.status).toBe(403);
      const sqls = [...get.mock.calls, ...all.mock.calls].map(([sql]) => String(sql));
      expect(sqls.some((sql) => /keyHash/i.test(sql))).toBe(false);
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  });
});
