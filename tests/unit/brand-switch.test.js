import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const CJS_PATH = require.resolve("../../src/shared/brand/index.cjs");

// The switch resolves at load time, so every case loads a fresh copy.
function loadCjs() {
  delete require.cache[CJS_PATH];
  return require(CJS_PATH);
}

async function loadEsm() {
  delete require.cache[CJS_PATH];
  vi.resetModules();
  return import("../../src/shared/brand/index.js");
}

describe("brand switch", () => {
  let savedBrand;

  beforeEach(() => {
    savedBrand = process.env.NEXT_PUBLIC_BRAND;
    delete process.env.NEXT_PUBLIC_BRAND;
  });

  afterEach(() => {
    if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
    else process.env.NEXT_PUBLIC_BRAND = savedBrand;
    delete require.cache[CJS_PATH];
  });

  it("lists both brands and defaults to 9router", () => {
    const brand = loadCjs();
    expect(brand.BRAND_IDS).toEqual(["9router", "tokenhop"]);
    expect(brand.DEFAULT_BRAND_ID).toBe("9router");
    expect(brand.ACTIVE_BRAND_ID).toBe("9router");
  });

  it("treats an empty NEXT_PUBLIC_BRAND as unset", () => {
    process.env.NEXT_PUBLIC_BRAND = "";
    expect(loadCjs().ACTIVE_BRAND_ID).toBe("9router");
  });

  it("selects tokenhop via NEXT_PUBLIC_BRAND", () => {
    process.env.NEXT_PUBLIC_BRAND = "tokenhop";
    expect(loadCjs().ACTIVE_BRAND_ID).toBe("tokenhop");
  });

  it("accepts 9router explicitly", () => {
    process.env.NEXT_PUBLIC_BRAND = "9router";
    expect(loadCjs().ACTIVE_BRAND_ID).toBe("9router");
  });

  it.each(["TokenHop", "tokenhook", " tokenhop", "9Router"])(
    "throws on unknown value %j and names the allowed values",
    (value) => {
      process.env.NEXT_PUBLIC_BRAND = value;
      expect(() => loadCjs()).toThrow(/NEXT_PUBLIC_BRAND.*"9router", "tokenhop"/);
    },
  );

  it("isActiveBrand matches only the active brand", () => {
    const def = loadCjs();
    expect(def.isActiveBrand("9router")).toBe(true);
    expect(def.isActiveBrand("tokenhop")).toBe(false);

    process.env.NEXT_PUBLIC_BRAND = "tokenhop";
    const th = loadCjs();
    expect(th.isActiveBrand("tokenhop")).toBe(true);
    expect(th.isActiveBrand("9router")).toBe(false);
  });

  it("isActiveBrand rejects unknown ids instead of returning false", () => {
    expect(() => loadCjs().isActiveBrand("tokenhook")).toThrow(
      /isActiveBrand: unknown brand "tokenhook"/,
    );
  });

  it("freezes BRAND_IDS", () => {
    expect(Object.isFrozen(loadCjs().BRAND_IDS)).toBe(true);
  });

  it("loads through import with the same values as require", async () => {
    process.env.NEXT_PUBLIC_BRAND = "tokenhop";
    const esm = await loadEsm();
    expect(esm.BRAND_IDS).toEqual(["9router", "tokenhop"]);
    expect(esm.DEFAULT_BRAND_ID).toBe("9router");
    expect(esm.ACTIVE_BRAND_ID).toBe("tokenhop");
    expect(esm.isActiveBrand("tokenhop")).toBe(true);
  });

  it("import surfaces the load-time error too", async () => {
    process.env.NEXT_PUBLIC_BRAND = "nope";
    await expect(loadEsm()).rejects.toThrow(/NEXT_PUBLIC_BRAND/);
  });
});
