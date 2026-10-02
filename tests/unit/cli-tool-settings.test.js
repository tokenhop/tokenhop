// CLI tool card settings: kv-backed routes + backup roundtrip.
import { describe, it, expect, beforeAll } from "vitest";

let db;
let list;
let one;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  list = await import("@/app/api/cli-tool-settings/route.js");
  one = await import("@/app/api/cli-tool-settings/[toolId]/route.js");
});

const ctx = (toolId) => ({ params: Promise.resolve({ toolId }) });
const url = (toolId) => `http://localhost/api/cli-tool-settings/${toolId}`;
const get = (toolId) => one.GET(new Request(url(toolId)), ctx(toolId));
const put = (toolId, body) =>
  one.PUT(
    new Request(url(toolId), {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx(toolId),
  );
const del = (toolId) => one.DELETE(new Request(url(toolId), { method: "DELETE" }), ctx(toolId));

describe("/api/cli-tool-settings/[toolId]", () => {
  it.each([
    ["GET", () => get("nope")],
    ["PUT", () => put("nope", {})],
    ["DELETE", () => del("nope")],
    ["GET proto", () => get("__proto__")],
  ])("%s unknown tool -> 400", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown CLI tool" });
  });

  it("PUT then GET roundtrip, GET all, DELETE clears", async () => {
    const settings = {
      endpoint: "http://x",
      oneMContext: true,
      models: { opus: "a/b" },
      list: ["a"],
    };
    const saved = await put("claude", settings);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ settings });

    expect(await (await get("claude")).json()).toEqual({ settings });
    const all = await (await list.GET()).json();
    expect(all.settings.claude).toEqual(settings);

    const removed = await del("claude");
    expect(await removed.json()).toEqual({ success: true });
    expect(await (await get("claude")).json()).toEqual({ settings: {} });
  });

  it("rejects bodies outside the settings shape with 400", async () => {
    const bad = [
      "[1]",
      "null",
      '"s"',
      JSON.stringify({ models: { opus: { deep: "x" } } }),
      JSON.stringify({ list: [["a"]] }),
      JSON.stringify({ list: [{ a: 1 }] }),
      JSON.stringify({ endpoint: "x".repeat(2049) }),
      '{"__proto__":{"a":1}}',
    ];
    for (const body of bad) {
      const res = await put("claude", body);
      expect(res.status, body).toBe(400);
    }
    expect(await (await get("claude")).json()).toEqual({ settings: {} });
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await put("claude", "{nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("rejects oversize payload with 413 and no write", async () => {
    const res = await put("claude", {
      a: "é".repeat(1500),
      b: "é".repeat(1500),
      c: "é".repeat(1500),
      d: "é".repeat(1500),
      e: "é".repeat(1500),
      f: "é".repeat(1500),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Settings payload too large" });
    expect(await (await get("claude")).json()).toEqual({ settings: {} });
  });
});

describe("backup", () => {
  it("exportDb includes cliToolSettings and importDb restores it", async () => {
    await put("claude", { endpoint: "http://backup" });
    const dump = await db.exportDb();
    expect(dump.cliToolSettings).toEqual({ claude: { endpoint: "http://backup" } });

    await del("claude");
    expect((await db.exportDb()).cliToolSettings).toEqual({});

    await db.importDb({ ...dump, cliToolSettings: { ...dump.cliToolSettings, codex: "oops" } });
    expect(await (await get("claude")).json()).toEqual({ settings: { endpoint: "http://backup" } });
    expect(await (await get("codex")).json()).toEqual({ settings: {} });
    await del("claude");
  });
});

describe("toolSettings helpers", () => {
  let mergeToolSettings;
  let diffFromDisk;
  beforeAll(async () => {
    ({ mergeToolSettings, diffFromDisk } = await import("@/lib/cliToolConfigs/toolSettings"));
  });

  it("merges with precedence defaults < disk < saved", () => {
    const merged = mergeToolSettings(
      { endpoint: "http://def", oneMContext: false, apiKeyId: "" },
      { endpoint: "http://disk", oneMContext: true },
      { endpoint: "http://saved" },
    );
    expect(merged).toEqual({ endpoint: "http://saved", oneMContext: true, apiKeyId: "" });
  });

  it("lets undefined disk fields fall through to defaults", () => {
    const merged = mergeToolSettings(
      { endpoint: "http://def", oneMContext: false },
      {
        endpoint: "http://disk",
        oneMContext: undefined,
      },
    );
    expect(merged).toEqual({ endpoint: "http://disk", oneMContext: false });
  });

  it("merges nested models one level deep without dropping default aliases", () => {
    const merged = mergeToolSettings(
      { models: { opus: "cc/opus", sonnet: "cc/sonnet", haiku: "cc/haiku" } },
      { models: { opus: "disk/opus" } },
      { models: { opus: "my/combo" } },
    );
    expect(merged.models).toEqual({ opus: "my/combo", sonnet: "cc/sonnet", haiku: "cc/haiku" });
  });

  it("diffFromDisk lists saved keys that differ from defined disk values", () => {
    expect(
      diffFromDisk(
        { endpoint: "http://saved", oneMContext: true, extra: 1 },
        {
          endpoint: "http://disk",
          oneMContext: true,
          missing: "x",
          dropped: undefined,
        },
      ),
    ).toEqual(["endpoint"]);
  });

  it("diffFromDisk ignores map key order", () => {
    expect(diffFromDisk({ agents: { a: "x", b: "y" } }, { agents: { b: "y", a: "x" } })).toEqual(
      [],
    );
  });

  it("diffFromDisk returns [] when disk is null", () => {
    expect(diffFromDisk({ endpoint: "http://saved" }, null)).toEqual([]);
  });
});

describe("toolSettingsStore saver", () => {
  let store;
  let calls;
  let release;
  beforeAll(async () => {
    store = await import("@/store/toolSettingsStore");
  });

  // fetch stub: PUTs wait on `release` so a save can be held in flight.
  const stubFetch = (getResponse = { ok: true, json: async () => ({ settings: {} }) }) => {
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${url}`);
      if (init.method === "PUT") await new Promise((r) => (release = r));
      return typeof getResponse === "function" ? getResponse(url, init) : getResponse;
    };
  };

  it("reset waits for an in-flight save, so the DELETE lands last", async () => {
    store.__resetToolSettingsStore();
    stubFetch();
    await store.loadToolSettings();
    store.setToolSettings("claude", { endpoint: "http://a" });
    const flushed = store.flushToolSettings("claude");
    await Promise.resolve();
    const reset = store.resetToolSettings("claude");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1)).toBe("PUT /api/cli-tool-settings/claude");
    release();
    await flushed;
    expect(await reset).toBe(true);
    expect(calls.at(-1)).toBe("DELETE /api/cli-tool-settings/claude");
    expect(store.useToolSettingsStore.getState().saved.claude).toBeUndefined();
  });

  it("a failed load blocks autosave instead of overwriting the saved row", async () => {
    store.__resetToolSettingsStore();
    stubFetch({ ok: false, json: async () => ({}) });
    await store.loadToolSettings();
    expect(store.useToolSettingsStore.getState().loadFailed).toBe(true);
    store.setToolSettings("claude", { endpoint: "http://a" });
    await store.flushToolSettings("claude");
    expect(calls).toEqual(["GET /api/cli-tool-settings"]);
    expect(store.useToolSettingsStore.getState().status.claude).toBe("error");
  });
});
