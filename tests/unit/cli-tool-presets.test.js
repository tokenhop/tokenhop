// CLI tool presets: kv-backed route + backup roundtrip (YAN-642).
import { describe, it, expect, beforeAll } from "vitest";

let db;
let route;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  route = await import("@/app/api/cli-tool-presets/route.js");
});

const url = "http://localhost/api/cli-tool-presets";
const put = (body) =>
  route.PUT(
    new Request(url, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("/api/cli-tool-presets", () => {
  it("PUT then GET roundtrip for both kinds", async () => {
    const endpoints = [{ name: "box", baseUrl: "http://box:20128/v1" }];
    const keys = [{ name: "mine", key: "sk-mine" }];

    const savedEndpoints = await put({ kind: "endpoints", items: endpoints });
    expect(savedEndpoints.status).toBe(200);
    expect((await savedEndpoints.json()).presets.endpoints).toEqual(endpoints);

    const savedKeys = await put({ kind: "apiKeys", items: keys });
    expect(savedKeys.status).toBe(200);

    const got = await route.GET();
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ presets: { endpoints, apiKeys: keys } });
  });

  it("rejects bad bodies with 400", async () => {
    const bad = [
      JSON.stringify({ kind: "nope", items: [] }),
      JSON.stringify({ kind: "__proto__", items: [] }),
      JSON.stringify({ kind: "endpoints", items: [{ name: "x", baseUrl: "ftp://x" }] }),
      JSON.stringify({ kind: "endpoints", items: [{ name: "x", baseUrl: "http://x", extra: 1 }] }),
      JSON.stringify({ kind: "apiKeys", items: [{ name: "x" }] }),
      JSON.stringify({
        kind: "endpoints",
        items: Array.from({ length: 65 }, () => ({ name: "x", baseUrl: "http://x" })),
      }),
      "{nope",
    ];
    for (const body of bad) {
      const res = await put(body);
      expect(res.status, body).toBe(400);
    }
  });

  it("rejects oversize payload with 413 and no write", async () => {
    const res = await put({
      kind: "endpoints",
      items: [{ name: "x", baseUrl: `http://x/${"é".repeat(8500)}` }],
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Presets payload too large" });
  });
});

describe("backup", () => {
  it("exportDb includes cliToolPresets and importDb restores them", async () => {
    const endpoints = [{ name: "backup", baseUrl: "http://backup/v1" }];
    const keys = [{ name: "k", key: "sk-backup" }];
    await put({ kind: "endpoints", items: endpoints });
    await put({ kind: "apiKeys", items: keys });
    const dump = await db.exportDb();
    expect(dump.cliToolPresets).toEqual({ endpoints, apiKeys: keys });

    await put({ kind: "endpoints", items: [] });
    await put({ kind: "apiKeys", items: [] });
    expect((await db.exportDb()).cliToolPresets).toEqual({ endpoints: [], apiKeys: [] });

    await db.importDb({
      ...dump,
      cliToolPresets: { ...dump.cliToolPresets, junk: [1] },
    });
    const got = await route.GET();
    expect(await got.json()).toEqual({ presets: { endpoints, apiKeys: keys } });
  });
});
