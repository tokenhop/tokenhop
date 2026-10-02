// YAN-642: CLI tool presets load from the DB, importing localStorage once.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const BRAND_CJS = require.resolve("../../src/shared/brand/index.cjs");
const { LEGACY } = require(BRAND_CJS);
const MODULE = "@/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js";
const savedBrand = process.env.NEXT_PUBLIC_BRAND;
const ENDPOINTS = [{ name: "box", baseUrl: "http://box:20128" }];
const KEYS = [{ name: "mine", key: "sk-a" }];

let store;
let puts;
let respond;
const realFetch = globalThis.fetch;

beforeEach(() => {
  store = new Map();
  puts = [];
  respond = { presets: { endpoints: [], apiKeys: [] } };
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.fetch = async (_url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "PUT") {
      puts.push(body);
      return { ok: true, json: async () => ({ presets: {} }) };
    }
    return { ok: true, json: async () => respond };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
  if (savedBrand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = savedBrand;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
});

async function load(brand = "tokenhop") {
  if (brand === undefined) delete process.env.NEXT_PUBLIC_BRAND;
  else process.env.NEXT_PUBLIC_BRAND = brand;
  delete require.cache[BRAND_CJS];
  vi.resetModules();
  return import(MODULE);
}

const endpointsKey = `${LEGACY.storageKeyPrefix}cliToolEndpointPresets`;
const keysKey = `${LEGACY.storageKeyPrefix}cliToolApiKeyPresets`;

describe("cli-tool preset import", () => {
  // legacy(9router): remove in v2
  it("PUTs legacy localStorage presets once when the DB list is empty, then clears both keys", async () => {
    store.set(endpointsKey, JSON.stringify(ENDPOINTS));
    store.set(keysKey, JSON.stringify(KEYS));

    const presets = await load();
    presets.readPresets(); // kicks the shared load
    await vi.waitFor(() => expect(puts.length).toBe(2));

    expect(presets.readPresets()).toEqual(ENDPOINTS);
    expect(presets.readKeyPresets()).toEqual(KEYS);
    expect(puts).toEqual([
      { kind: "endpoints", items: ENDPOINTS },
      { kind: "apiKeys", items: KEYS },
    ]);
    expect([...store.keys()]).toEqual([]);
  });

  it("keeps localStorage untouched when the DB already has presets", async () => {
    store.set(endpointsKey, JSON.stringify(ENDPOINTS));
    respond = { presets: { endpoints: ENDPOINTS, apiKeys: [] } };

    const presets = await load();
    presets.readPresets();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(ENDPOINTS));

    expect(puts).toEqual([]);
    expect(JSON.parse(store.get(endpointsKey))).toEqual(ENDPOINTS);
  });

  it("does not PUT a preset upserted before the load finishes", async () => {
    let release;
    respond = { presets: { endpoints: ENDPOINTS, apiKeys: [] } };
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ presets: {} }) };
      }
      await new Promise((r) => (release = r));
      return { ok: true, json: async () => respond };
    };

    const presets = await load();
    expect(presets.readPresets()).toEqual([]);
    presets.upsertKeyPreset("sk-a", "mine"); // cache-only while loading
    expect(puts).toEqual([]);

    release();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(ENDPOINTS));
    presets.upsertKeyPreset("sk-b", "other"); // saved now that the load ran
    expect(puts).toEqual([
      {
        kind: "apiKeys",
        items: [
          { name: "mine", key: "sk-a" },
          { name: "other", key: "sk-b" },
        ],
      },
    ]);
  });
});
