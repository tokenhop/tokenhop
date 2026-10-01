// YAN-327: CLI-tool preset storage keys follow the brand; a legacy key is copied forward.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const { BRAND, LEGACY } = require(BRAND_CJS);
const MODULE = "@/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js";
const savedBrand = process.env.NEXT_PUBLIC_BRAND;
const PRESETS = [{ name: "box", baseUrl: "http://box:20128" }];

let store;
beforeEach(() => {
  store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
});

afterEach(() => {
  delete globalThis.window;
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
});

async function load(brand) {
  if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = brand;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
  return import(MODULE);
}

describe("cli-tool preset storage", () => {
  // legacy(9router): remove in v2
  it("copies a legacy-key fixture forward and writes only the new key (tokenhop)", async () => {
    const legacyKey = `${LEGACY.storageKeyPrefix}cliToolEndpointPresets`;
    const newKey = `${BRAND.storageKeyPrefix}cliToolEndpointPresets`;
    store.set(legacyKey, JSON.stringify(PRESETS));

    const presets = await load("tokenhop");
    expect(presets.readPresets()).toEqual(PRESETS);
    expect(JSON.parse(store.get(newKey))).toEqual(PRESETS);

    presets.upsertPreset("http://other:1");
    expect(JSON.parse(store.get(legacyKey))).toEqual(PRESETS);
    expect(JSON.parse(store.get(newKey)).map((p) => p.name)).toEqual(["box", "other:1"]);
  });

  it("keeps the shipped key under the default brand", async () => {
    const legacyKey = `${LEGACY.storageKeyPrefix}cliToolApiKeyPresets`;
    const presets = await load(undefined);
    presets.upsertKeyPreset("sk-a", "mine");
    expect([...store.keys()]).toEqual([legacyKey]);
    expect(presets.readKeyPresets()).toEqual([{ name: "mine", key: "sk-a" }]);
  });
});
