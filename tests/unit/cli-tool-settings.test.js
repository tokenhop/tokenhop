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
    const settings = { endpoint: "http://x", oneMContext: true, models: { opus: "a/b" } };
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

  it("rejects non-object bodies with 400", async () => {
    for (const body of ["[1]", "null", "3", '"s"']) {
      const res = await put("claude", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Settings must be a JSON object" });
    }
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await put("claude", "{nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("rejects oversize payload with 413 and no write", async () => {
    const res = await put("claude", { blob: "x".repeat(16384) });
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

    await db.importDb(dump);
    expect(await (await get("claude")).json()).toEqual({ settings: { endpoint: "http://backup" } });
    await del("claude");
  });
});

describe("toolSettings helpers", () => {
  let mergeToolSettings;
  let diffFromDisk;
  beforeAll(async () => {
    ({ mergeToolSettings, diffFromDisk } = await import(
      "@/app/(dashboard)/dashboard/cli-tools/lib/toolSettings"
    ));
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

  it("diffFromDisk returns [] when disk is null", () => {
    expect(diffFromDisk({ endpoint: "http://saved" }, null)).toEqual([]);
  });
});
