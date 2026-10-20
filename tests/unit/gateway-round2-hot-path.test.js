// YAN-1106 round 2: compiled pattern regexes, the budget estimate's output-cap
// memo (catalog invalidation), and the interval-based catalog stat.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-round2-"));
process.env.DATA_DIR = dataDir;
const catalogFile = path.join(dataDir, "model-catalog.json");

let pricing;
let catalog;
let capabilities;
let outputCap;

beforeAll(async () => {
  fs.writeFileSync(catalogFile, JSON.stringify({ v: 2, models: {}, providers: {} }));
  pricing = await import("../../open-sse/providers/pricing.js");
  catalog = await import("../../open-sse/providers/catalogOverride.js");
  capabilities = await import("../../open-sse/providers/capabilities.js");
  outputCap = await import("@/sse/services/modelOutputCap.js");
  await catalog.installCatalogSource();
});
afterAll(() => {
  capabilities.setCatalogSource(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("matchPattern regex cache", () => {
  it("matches exactly as before: case-insensitive, anchored, * wildcard, escaped literals", () => {
    expect(pricing.matchPattern("MiniMax-*", "minimax-m2.5")).toBe(true);
    expect(pricing.matchPattern("qwen*-coder-*", "qwen3-coder-plus")).toBe(true);
    expect(pricing.matchPattern("kimi-k2*", "xkimi-k2")).toBe(false); // anchored
    expect(pricing.matchPattern("gpt-4.1", "gpt-4x1")).toBe(false); // "." is literal
    expect(pricing.matchPattern("a+b(c)", "a+b(c)")).toBe(true);
    expect(pricing.matchPattern("*", "anything")).toBe(true);
  });

  it("compiles each pattern once (repeat lookups build no new RegExp)", () => {
    const RealRegExp = globalThis.RegExp;
    let built = 0;
    const Spy = new Proxy(RealRegExp, {
      construct(target, args) {
        built++;
        return Reflect.construct(target, args);
      },
    });
    globalThis.RegExp = Spy;
    try {
      pricing.matchPattern("unique-pattern-*-x", "unique-pattern-1-x");
      const afterFirst = built;
      for (let i = 0; i < 20; i++)
        pricing.matchPattern("unique-pattern-*-x", `unique-pattern-${i}-x`);
      expect(afterFirst).toBe(1);
      expect(built).toBe(1);
    } finally {
      globalThis.RegExp = RealRegExp;
    }
  });

  it("is a stateless regex (no /g lastIndex carry-over between calls)", () => {
    for (let i = 0; i < 4; i++) expect(pricing.matchPattern("glm-*", "glm-4.6")).toBe(true);
  });

  it("stays bounded for arbitrary exported-API input", () => {
    for (let i = 0; i < 1000; i++) pricing.matchPattern(`p${i}-*`, "x");
    expect(pricing.matchPattern("p999-*", "p999-y")).toBe(true);
    expect(pricing.matchPattern("p0-*", "p0-y")).toBe(true); // evicted, recompiled fine
  });

  it("unknown-model pricing resolves the same through the cached regexes", () => {
    expect(pricing.getPricingForModel("glm", "glm-5.1")).toEqual(
      pricing.getPricingForModel("glm", "glm-5.1"),
    );
    expect(pricing.getPricingForModel(null, "totally-unknown-model-xyz")).toBeNull();
  });
});

describe("output-cap memo for the budget estimate", () => {
  let now;
  let clock;
  let stat;
  const write = (providers, mtimeSec) => {
    const tmp = `${catalogFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, models: {}, providers }));
    fs.utimesSync(tmp, mtimeSec, mtimeSec);
    fs.renameSync(tmp, catalogFile);
  };
  let nextMtime = 50_000;

  beforeEach(() => {
    now = Date.now();
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
    write({}, nextMtime++);
    catalog.invalidateCatalog();
    stat = vi.spyOn(fs, "statSync");
  });
  afterEach(() => {
    stat.mockRestore();
    clock.mockRestore();
    catalog.invalidateCatalog();
  });

  it("returns the same value as the capability table, memoized within the interval", () => {
    const expected = Number(capabilities.getCapabilitiesForModel("gw", "cap-model").maxOutput);
    expect(outputCap.maxOutputFor("gw", "cap-model")).toBe(expected || Infinity);
    stat.mockClear();
    const spy = vi.spyOn(capabilities, "getCapabilitiesForModel");
    for (let i = 0; i < 5; i++) outputCap.maxOutputFor("gw", "cap-model");
    expect(stat).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("drops the memo on invalidateCatalog (in-process catalog sync)", () => {
    const before = outputCap.maxOutputFor("gw", "laguna-9-preview");
    write({ gw: { "laguna-9-preview": { contextWindow: 5000, maxOutput: 700 } } }, nextMtime++);
    expect(outputCap.maxOutputFor("gw", "laguna-9-preview")).toBe(before); // same interval
    catalog.invalidateCatalog();
    expect(outputCap.maxOutputFor("gw", "laguna-9-preview")).toBe(700);
  });

  it("picks up a foreign catalog write after the stat interval", () => {
    write({ gw: { "laguna-9-preview": { contextWindow: 5000, maxOutput: 700 } } }, nextMtime++);
    catalog.invalidateCatalog();
    expect(outputCap.maxOutputFor("gw", "laguna-9-preview")).toBe(700);
    write({ gw: { "laguna-9-preview": { contextWindow: 5000, maxOutput: 900 } } }, nextMtime++);
    now += catalog.STAT_INTERVAL_MS + 1;
    clock.mockReturnValue(now);
    expect(outputCap.maxOutputFor("gw", "laguna-9-preview")).toBe(900);
  });

  it("treats a model with no known limit as unbounded, like before", () => {
    const caps = capabilities.getCapabilitiesForModel("gw", "no-limit-model");
    expect(outputCap.maxOutputFor("gw", "no-limit-model")).toBe(Number(caps.maxOutput) || Infinity);
  });

  it("stays bounded under many distinct client-supplied model ids", () => {
    for (let i = 0; i < 1500; i++) outputCap.maxOutputFor("gw", `junk-${i}`);
    expect(outputCap.maxOutputFor("gw", "junk-1499")).toBe(
      Number(capabilities.getCapabilitiesForModel("gw", "junk-1499").maxOutput) || Infinity,
    );
  });
});

describe("catalog generation shared across bundle copies", () => {
  it("a duplicate module copy sees invalidations made through the other copy", async () => {
    vi.resetModules();
    const copyA = await import("../../open-sse/providers/catalogOverride.js?copy=a");
    const copyB = await import("../../open-sse/providers/catalogOverride.js?copy=b");
    expect(copyA).not.toBe(copyB); // genuinely two evaluations
    const before = copyB.catalogGeneration();
    copyA.invalidateCatalog();
    expect(copyB.catalogGeneration()).toBe(before + 1);
    expect(copyA.catalogGeneration()).toBe(copyB.catalogGeneration());
  });

  it("invalidateCatalog in one copy forces a re-stat in the other copy within the interval", async () => {
    vi.resetModules();
    const copyA = await import("../../open-sse/providers/catalogOverride.js?copy=c");
    const copyB = await import("../../open-sse/providers/catalogOverride.js?copy=d");
    expect(copyA).not.toBe(copyB);
    const write = (limit, mtimeSec) => {
      const tmp = `${catalogFile}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ v: 2, models: {}, providers: { gw: { m: { output: limit } } } }),
      );
      fs.utimesSync(tmp, mtimeSec, mtimeSec);
      fs.renameSync(tmp, catalogFile);
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      write(100, 70_000);
      copyA.invalidateCatalog();
      expect(copyB.getCatalogLimits("gw", "m")).toMatchObject({ output: 100 });
      // Inside the stat interval the other copy would otherwise keep serving 100.
      write(200, 70_001);
      expect(copyB.getCatalogLimits("gw", "m")).toMatchObject({ output: 100 });
      copyA.invalidateCatalog();
      expect(copyB.getCatalogLimits("gw", "m")).toMatchObject({ output: 200 });
      expect(copyA.getCatalogLimits("gw", "m")).toMatchObject({ output: 200 });
    } finally {
      clock.mockRestore();
      catalog.invalidateCatalog();
    }
  });

  it("the counter lives on a Symbol.for slot", () => {
    const slot = globalThis[Symbol.for("tokenhop.catalogGeneration")];
    expect(typeof slot?.n).toBe("number");
    const before = catalog.catalogGeneration();
    catalog.invalidateCatalog();
    expect(slot.n).toBe(before + 1);
  });
});
