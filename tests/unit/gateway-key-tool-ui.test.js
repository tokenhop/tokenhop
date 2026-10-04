// YAN-363 gateway key tool UI: hashed vs legacy key helper behavior for the
// CLI-tool setup cards (Claude/Codex/OpenCode).
//
// Contract under test:
// - Legacy calls keep exact old results (no opts arg).
// - Hashed mode: no raw is ever recovered from a keyId, prefix, or the brand
//   default. Only an explicitly pasted/typed key is sent; omission lets the
//   server preserve the stored disk credential for the same destination.
// - Manual snippets show only an explicitly pasted key, else the placeholder —
//   never a prefix or default pretending to be a key.
// - Preset refs ({ name, apiKeyId }) and the external marker
//   ({ name, external: true, externalRef }) are display metadata only — they
//   never produce a usable credential.
// - Ambiguous server rejections keep browser data; nothing is deleted.
// - Every remaining card callsite passes the authoritative hashed flag
//   (route status storage or the shared key context) — no card falls back
//   to the brand default or a prefix under hashed storage.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  API_KEY_PLACEHOLDER,
  resolveApiKey,
  manualApiKey,
} from "../../src/lib/cliToolConfigs/shared.js";
import { ACTIVE } from "../../src/shared/brand/index.js";

const LEGACY_KEYS = [
  { id: "a", key: "sk-a" },
  { id: "b", key: "sk-b" },
];
// Hashed-mode rows: metadata only (prefix/id), no raw `key` field.
const HASHED_KEYS = [
  { id: "a", name: "alpha", prefix: "th_aaa…zzz" },
  { id: "b", name: "beta", prefix: "th_bbb…yyy" },
];
const REF_PRESETS = [{ name: "mine", apiKeyId: "a" }];
const EXTERNAL_MARKER = {
  name: "External credential",
  external: true,
  externalRef: "0".repeat(64),
};

// ponytail: source-level guards until a component renderer lands; all cards
// funnel through the meaningful helper tests below for output behavior.
const cardRoot = resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/cli-tools/components",
);
const readCard = (name) => readFileSync(resolve(cardRoot, `${name}ToolCard.js`), "utf8");
const REMAINING = [
  "Copilot",
  "Cowork",
  "Cline",
  "Kilo",
  "Droid",
  "Hermes",
  "OpenClaw",
  "DeepSeekTui",
  "Jcode",
  "GrokBuild",
  "Default",
];

describe("remaining card hashed-key callsites", () => {
  it.each(REMAINING)("%s passes hashed behavior to every helper call", (name) => {
    const source = readCard(name);
    const calls = [
      ...source.matchAll(
        /(?:resolveApiKey|manualApiKey)\(setup\.selectedApiKey, apiKeys, cloudEnabled([^)]*)\)/g,
      ),
    ];
    expect(calls.length, `${name}: expected key helper callsites`).toBeGreaterThan(0);
    for (const call of calls) expect(call[1]).toMatch(/, \{ hashed \}/);
    expect(source).not.toContain("ACTIVE.defaultApiKey");
    expect(source).toContain("hashedContext = false");
    expect(source).toContain("hashed={hashed}");
    expect(source).toContain("onChange={setup.onApiKeyChange}");
    expect(source).not.toMatch(/setField\("apiKey"/);
  });

  it("setup panel threads shared authoritative key context into every card", () => {
    const source = readFileSync(resolve(cardRoot, "ToolSetupPanel.js"), "utf8");
    expect(source).toContain('data.keyContext?.storage === "hashed"');
    expect(source).toContain("hashedContext={hashedContext}");
  });

  it.each(["Cline", "Kilo", "Default"])(
    "%s uses shared context rather than guessing legacy",
    (name) => {
      expect(readCard(name)).toContain("const hashed = hashedContext");
    },
  );

  it.each([
    "Copilot",
    "Cowork",
    "Droid",
    "Hermes",
    "OpenClaw",
    "DeepSeekTui",
    "Jcode",
    "GrokBuild",
  ])("%s uses route storage plus authoritative context fallback", (name) => {
    const source = readCard(name);
    expect(source).toContain('status?.storage === "hashed" || hashedContext');
    expect(source).toContain("status?.credentialConfigured");
  });

  it("undefined key is absent from JSON, so same-destination server preserve is reachable", () => {
    const body = JSON.parse(
      JSON.stringify({
        baseUrl: "http://localhost:20128/v1",
        apiKey: resolveApiKey("", HASHED_KEYS, false, { hashed: true }),
        model: "provider/model",
      }),
    );
    expect(body).not.toHaveProperty("apiKey");
  });
});

describe("resolveApiKey legacy parity (no opts)", () => {
  it("selects, falls back to first key, then brand default", () => {
    expect(resolveApiKey("sk-b", LEGACY_KEYS, false)).toBe("sk-b");
    expect(resolveApiKey("", LEGACY_KEYS, false)).toBe("sk-a");
    expect(resolveApiKey("", [], false)).toBe(ACTIVE.defaultApiKey);
    expect(resolveApiKey("", [], true)).toBeNull();
  });

  it("manualApiKey falls back to the placeholder", () => {
    expect(manualApiKey("", [], true)).toBe(API_KEY_PLACEHOLDER);
  });
});

describe("resolveApiKey hashed mode", () => {
  it("sends only an explicitly pasted key", () => {
    expect(resolveApiKey("sk-pasted", HASHED_KEYS, false, { hashed: true })).toBe("sk-pasted");
  });

  it("recovers no raw from metadata, refs, markers, or the brand default", () => {
    // No browser-held key: omission — the server preserves the disk credential.
    expect(resolveApiKey("", HASHED_KEYS, false, { hashed: true })).toBeUndefined();
    // A keyId is an opaque ref, not a credential lookup.
    expect(resolveApiKey("a", HASHED_KEYS, false, { hashed: true })).toBe("a"); // still opaque, not a secret
    // Metadata rows expose no `.key` to fall back to.
    expect(resolveApiKey("", HASHED_KEYS, true, { hashed: true })).toBeUndefined();
    expect(resolveApiKey("", [], false, { hashed: true })).toBeUndefined();
  });

  it("manualApiKey shows only the pasted key, never a fake credential", () => {
    expect(manualApiKey("sk-pasted", HASHED_KEYS, false, { hashed: true })).toBe("sk-pasted");
    expect(manualApiKey("", HASHED_KEYS, false, { hashed: true })).toBe(API_KEY_PLACEHOLDER);
    expect(manualApiKey(undefined, HASHED_KEYS, true, { hashed: true })).toBe(API_KEY_PLACEHOLDER);
  });
});

describe("preset refs are display-only, never credentials", () => {
  it("resolveSelectedApiKey yields no secret from a ref preset", async () => {
    const { resolveSelectedApiKey } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js"
    );
    expect(
      resolveSelectedApiKey({
        customKey: null,
        apiKeys: HASHED_KEYS,
        keyPresets: REF_PRESETS,
        values: { apiKeyPreset: "mine" },
      }),
    ).toBe("");
  });

  it("external markers never resolve to a key either", async () => {
    const { resolveSelectedApiKey } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js"
    );
    expect(
      resolveSelectedApiKey({
        customKey: null,
        apiKeys: HASHED_KEYS,
        keyPresets: [EXTERNAL_MARKER],
        values: { apiKeyPreset: "External credential" },
      }),
    ).toBe("");
  });

  it("apiKeyPatch keeps a pasted raw out of persisted fields", async () => {
    const { apiKeyPatch } = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js"
    );
    // Legacy: known raw key saves by id — unchanged.
    expect(apiKeyPatch("sk-b", LEGACY_KEYS, [])).toEqual({
      apiKeyId: "b",
      apiKeyPreset: undefined,
    });
    // Hashed: unknown raw matches nothing — memory only (null patch).
    expect(apiKeyPatch("sk-pasted-new", HASHED_KEYS, REF_PRESETS)).toBeNull();
    // A ref never maps back to raw.
    expect(apiKeyPatch("a", HASHED_KEYS, REF_PRESETS)).toBeNull();
  });
});

describe("preset store: refs load, raws never re-stored, rejections keep data", () => {
  let presets;
  let puts;
  let store;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    store = new Map();
    puts = [];
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
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        puts.push(body);
        if (puts[0]?._reject) return { ok: false, status: 400, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({
            presets: { endpoints: [], apiKeys: [{ name: "mine", apiKeyId: "a" }] },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ presets: { endpoints: [], apiKeys: REF_PRESETS } }),
      };
    };
    presets = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js"
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    vi.restoreAllMocks();
  });

  it("loads hashed refs as display-only entries (no key field)", async () => {
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(REF_PRESETS));
    expect(presets.readKeyPresets()[0]).not.toHaveProperty("key");
  });

  it("refuses to re-store a raw once refs exist (no raw localStorage import)", async () => {
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(REF_PRESETS));
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull();
    expect([...store.values()].some((v) => String(v).includes("sk-raw-typed"))).toBe(false);
    expect(puts.filter((p) => !p._reject)).toEqual([]);
  });

  it("keeps local raws on an ambiguous (400) import rejection and reports it", async () => {
    store.set(
      `${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`,
      JSON.stringify([{ name: "kept", key: "sk-kept" }]),
    );
    vi.resetModules();
    puts = [];
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: false, status: 400, json: async () => ({ error: "ambiguous" }) };
      }
      return { ok: true, json: async () => ({ presets: { endpoints: [], apiKeys: [] } }) };
    };
    const fresh = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js"
    );
    fresh.setKeyPresetStorageMode("legacy"); // import path exists only under confirmed legacy
    fresh.readKeyPresets();
    await vi.waitFor(() => expect(puts.length).toBe(1));
    // Browser copy kept, raw localStorage untouched, clear error surfaced.
    expect(fresh.readKeyPresets()).toEqual([{ name: "kept", key: "sk-kept" }]);
    expect(JSON.parse(store.get(`${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`))).toEqual([
      { name: "kept", key: "sk-kept" },
    ]);
    expect(fresh.readKeyImportError()).toMatch(/kept in this browser/);
  });

  it("hashed + empty server list: canonical empty replaces cache; no raw import, no PUT, localStorage kept", async () => {
    store.set(
      `${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`,
      JSON.stringify([{ name: "browser", key: "sk-browser" }]),
    );
    let gets = 0;
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === "PUT") puts.push(JSON.parse(init.body));
      else gets++;
      return { ok: true, json: async () => ({ presets: { endpoints: [], apiKeys: [] } }) };
    };
    presets.setKeyPresetStorageMode("hashed");
    presets.readKeyPresets();
    await vi.waitFor(() => expect(gets).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(presets.readKeyPresets()).toEqual([]); // canonical empty ack replaced the cache
    expect(puts).toEqual([]); // no import PUT of browser raws
    expect(JSON.parse(store.get(`${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`))[0].key).toBe(
      "sk-browser",
    ); // kept, not deleted
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull(); // raw write refused
  });

  it("hashed + external-only list (no refs): raw upsert still refused", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ presets: { endpoints: [], apiKeys: [EXTERNAL_MARKER] } }),
    });
    presets.setKeyPresetStorageMode("hashed");
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual([EXTERNAL_MARKER]));
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull();
    expect([...store.values()].some((v) => String(v).includes("sk-raw-typed"))).toBe(false);
    expect(puts).toEqual([]);
  });

  it("hashed with known refs: refs are display metadata; a typed raw is never stored", async () => {
    presets.setKeyPresetStorageMode("hashed");
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(REF_PRESETS));
    expect(presets.readKeyPresets()[0]).not.toHaveProperty("key");
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull();
  });

  it("unknown mode (context not loaded/failed) fails closed: no raw write, no legacy downgrade", async () => {
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(REF_PRESETS));
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull();
    expect(puts).toEqual([]);
    expect([...store.values()].some((v) => String(v).includes("sk-raw-typed"))).toBe(false);
  });

  it("confirmed legacy keeps raw save behavior", async () => {
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ presets: { endpoints: [], apiKeys: [] } }) };
      }
      // Non-empty endpoints list makes the shared load observable before the
      // legacy key upsert (saves are cache-only until loaded).
      return {
        ok: true,
        json: async () => ({
          presets: { endpoints: [{ name: "e", baseUrl: "http://e" }], apiKeys: [] },
        }),
      };
    };
    presets.setKeyPresetStorageMode("legacy");
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readPresets()).toHaveLength(1));
    expect(presets.upsertKeyPreset("sk-legacy-raw", "mine")).toBe("mine");
    expect(puts).toEqual([{ kind: "apiKeys", items: [{ name: "mine", key: "sk-legacy-raw" }] }]);
  });

  it("treats a malformed acknowledged response as unacknowledged: keeps data, errors, no stash", async () => {
    store.set(
      `${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`,
      JSON.stringify([{ name: "kept", key: "sk-kept" }]),
    );
    vi.resetModules();
    puts = [];
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ presets: {} }) }; // missing apiKeys list
      }
      return { ok: true, json: async () => ({ presets: { endpoints: [], apiKeys: [] } }) };
    };
    const fresh = await import(
      "../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js"
    );
    fresh.setKeyPresetStorageMode("legacy"); // import path exists only under confirmed legacy
    fresh.readKeyPresets();
    await vi.waitFor(() => expect(puts.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    // Not an acknowledgment: localStorage stays, an error is surfaced, and the
    // optimistic browser copy never becomes canonical server truth.
    expect(JSON.parse(store.get(`${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`))).toEqual([
      { name: "kept", key: "sk-kept" },
    ]);
    expect(fresh.readKeyImportError()).toMatch(/kept in this browser/);
  });
});

describe("deferred legacy import (empty GET before key context)", () => {
  const RAW = [{ name: "mine", key: "sk-a" }];
  const E_MARKER = [{ name: "e", baseUrl: "http://e" }];
  const KEYS_LS = `${ACTIVE.storageKeyPrefix}cliToolApiKeyPresets`;
  const realFetch = globalThis.fetch;
  let store;
  let puts;
  let fetchImpl;

  beforeEach(() => {
    vi.resetModules();
    store = new Map();
    puts = [];
    fetchImpl = null;
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
    globalThis.fetch = async (url, init = {}) => fetchImpl(url, init);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    vi.restoreAllMocks();
  });

  const fresh = async () =>
    import("../../src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js");
  const emptyGet = { presets: { endpoints: E_MARKER, apiKeys: [] } };
  const ackRaw = { presets: { endpoints: [], apiKeys: RAW } };

  it("GET-before-context: unknown empty GET defers, later legacy imports exactly once", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    let releaseGet;
    const gate = new Promise((r) => (releaseGet = r));
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ackRaw };
      }
      await gate;
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.readKeyPresets(); // GET in flight under unknown mode
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toEqual([]);
    releaseGet();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(E_MARKER));
    // Deferred: cache untouched (not canonical empty), no PUT, storage kept.
    expect(presets.readKeyPresets()).toEqual([]);
    expect(puts).toEqual([]);
    expect(JSON.parse(store.get(KEYS_LS))).toEqual(RAW);
    presets.setKeyPresetStorageMode("legacy");
    await vi.waitFor(() => expect(puts).toEqual([{ kind: "apiKeys", items: RAW }]));
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(RAW));
    await vi.waitFor(() => expect(store.has(KEYS_LS)).toBe(false));
  });

  it("context-before-GET: legacy confirmed first imports inline during load", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    let releaseGet;
    const gate = new Promise((r) => (releaseGet = r));
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ackRaw };
      }
      await gate;
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.setKeyPresetStorageMode("legacy");
    presets.readKeyPresets();
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toEqual([]);
    releaseGet();
    await vi.waitFor(() => expect(puts).toEqual([{ kind: "apiKeys", items: RAW }]));
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual(RAW));
    await vi.waitFor(() => expect(store.has(KEYS_LS)).toBe(false));
  });

  it("transition to hashed: deferred unknown empty resolves canonical, no PUT, storage kept", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    let gets = 0;
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") puts.push(JSON.parse(init.body));
      else gets += 1;
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(E_MARKER));
    expect(gets).toBe(1);
    expect(presets.readKeyPresets()).toEqual([]); // deferred, not canonical yet
    presets.setKeyPresetStorageMode("hashed");
    await new Promise((r) => setTimeout(r, 20));
    expect(puts).toEqual([]);
    expect(presets.readKeyPresets()).toEqual([]);
    expect(JSON.parse(store.get(KEYS_LS))).toEqual(RAW);
    expect(presets.upsertKeyPreset("sk-raw-typed", "typed")).toBeNull();
  });

  it("concurrent reads before context still PUT exactly once", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    let releaseGet;
    const gate = new Promise((r) => (releaseGet = r));
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ackRaw };
      }
      await gate;
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.readKeyPresets();
    presets.readKeyPresets();
    presets.readPresets();
    releaseGet();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(E_MARKER));
    presets.setKeyPresetStorageMode("legacy");
    await vi.waitFor(() => expect(puts.length).toBe(1));
    // Re-confirming legacy (via an unknown reset) never replays the import.
    presets.setKeyPresetStorageMode(null);
    presets.setKeyPresetStorageMode("legacy");
    await new Promise((r) => setTimeout(r, 30));
    expect(puts).toEqual([{ kind: "apiKeys", items: RAW }]);
  });

  it("rejected deferred import keeps the browser copy and reports it", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: false, status: 400, json: async () => ({ error: "ambiguous" }) };
      }
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(E_MARKER));
    presets.setKeyPresetStorageMode("legacy");
    await vi.waitFor(() => expect(puts.length).toBe(1));
    await vi.waitFor(() => expect(presets.readKeyImportError()).toMatch(/kept in this browser/));
    expect(presets.readKeyPresets()).toEqual(RAW);
    expect(JSON.parse(store.get(KEYS_LS))).toEqual(RAW);
  });

  it("stale in-flight legacy import after a hashed switch applies nothing and deletes nothing", async () => {
    store.set(KEYS_LS, JSON.stringify(RAW));
    let releasePut;
    const putGate = new Promise((r) => (releasePut = r));
    fetchImpl = async (_url, init = {}) => {
      if (init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        await putGate;
        return { ok: true, json: async () => ackRaw };
      }
      return { ok: true, json: async () => emptyGet };
    };
    const presets = await fresh();
    presets.readKeyPresets();
    await vi.waitFor(() => expect(presets.readPresets()).toEqual(E_MARKER));
    presets.setKeyPresetStorageMode("legacy");
    await vi.waitFor(() => expect(puts.length).toBe(1)); // PUT sent under legacy, still in flight
    presets.setKeyPresetStorageMode("hashed");
    releasePut();
    await vi.waitFor(() => expect(presets.readKeyPresets()).toEqual([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(puts.length).toBe(1); // no second PUT under hashed
    expect(JSON.parse(store.get(KEYS_LS))).toEqual(RAW); // stale ack deletes nothing
    expect(presets.readKeyImportError()).toBe("");
  });
});

describe("key-context storage mode threading (useToolSetupData seam)", () => {
  const hookPath = resolve(
    import.meta.dirname,
    "../../src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSetupData.js",
  );
  const hook = readFileSync(hookPath, "utf8");

  it("threads the authoritative context storage into the preset store", () => {
    expect(hook).toContain("setKeyPresetStorageMode(ctx.storage)");
  });

  it("resets to unknown before each load and on context failure — never a silent legacy downgrade", () => {
    expect(hook).toMatch(/fetchData[\s\S]*?setKeyPresetStorageMode\(null\);/);
    expect(hook).toMatch(
      /catch \(err\) \{\s*setKeyPresetStorageMode\(null\);\s*setKeyContext\(null\);\s*console\.error\("Error loading API keys/,
    );
  });
});
