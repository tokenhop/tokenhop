// YAN-407 stream diet: slim payload builder, lifecycle reducer, slim route.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-live-stream-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb?.();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const longModel = "m".repeat(39);
const longAccount = "a".repeat(39);
const worstActive = Array.from({ length: 30 }, (_, i) => ({
  model: `${longModel}${i}`,
  provider: `provider-${i}-with-a-long-name`,
  account: `${longAccount}${i}`,
  count: 3,
}));

const worstRecent = Array.from({ length: 20 }, (_, i) => ({
  timestamp: new Date(Date.now() - i * 1000).toISOString(),
  model: `${longModel}${i}`,
  provider: `provider-${i}-with-a-long-name`,
  promptTokens: 123456,
  completionTokens: 6789,
  status: "ok",
}));

describe("buildLivePayload", () => {
  it("returns exactly {activeRequests, lastProvider, errorProvider}", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    const payload = buildLivePayload({
      activeRequests: [
        { model: "gpt-5", provider: "openai", account: "Work", count: 1 },
        { model: "gpt-5-mini", provider: "openai", account: "Home", count: 2 },
      ],
      recentRequests: [{ provider: "anthropic" }],
      errorProvider: "openai",
    });
    expect(payload).toEqual({
      activeRequests: [{ provider: "openai", count: 3 }],
      lastProvider: "anthropic",
      errorProvider: "openai",
    });
  });

  it("aggregates per provider, caps and orders by count", async () => {
    const { buildLivePayload, LIVE_ACTIVE_CAP } = await import(
      "../../src/lib/usage/livePayload.js"
    );
    const payload = buildLivePayload({
      activeRequests: worstActive.map((a, i) => ({ ...a, count: i + 1 })),
      recentRequests: worstRecent,
    });
    expect(payload.activeRequests).toHaveLength(LIVE_ACTIVE_CAP);
    expect(payload.activeRequests[0].count).toBe(worstActive.length);
    expect(Object.keys(payload.activeRequests[0]).sort()).toEqual(["count", "provider"]);
    expect(payload.lastProvider).toBe(worstRecent[0].provider);
  });

  it("stays under 2048 bytes for the worst case", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    const huge = "p".repeat(500);
    const payload = buildLivePayload({
      activeRequests: Array.from({ length: 500 }, (_, i) => ({
        provider: `${huge}-${i}`,
        model: huge,
        account: huge,
        count: 999999,
      })),
      recentRequests: [{ provider: huge }],
      errorProvider: huge,
    });
    expect(JSON.stringify(payload).length).toBeLessThan(2048);
  });

  it("defaults empty live fields", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    expect(buildLivePayload({})).toEqual({
      activeRequests: [],
      lastProvider: "",
      errorProvider: "",
    });
  });
});

describe("streamReducer", () => {
  const load = async () =>
    await import("../../src/app/(dashboard)/dashboard/usage/lib/streamLifecycle.js");

  it("opens on overview while visible, closed when hidden", async () => {
    const { initialStreamState, streamReducer } = await load();
    expect(initialStreamState({ hidden: false, tab: "overview" })).toEqual({
      hidden: false,
      tab: "overview",
      open: true,
      needsCatchUp: false,
    });
    expect(initialStreamState({ hidden: true, tab: "overview" }).open).toBe(false);
    expect(initialStreamState({ hidden: false, tab: "logs" }).open).toBe(false);

    const hidden = streamReducer(initialStreamState({ hidden: false, tab: "overview" }), {
      type: "visibility",
      hidden: true,
    });
    expect(hidden.open).toBe(false);
    expect(hidden.needsCatchUp).toBe(false);
  });

  it("reopening sets needsCatchUp until caughtUp", async () => {
    const { initialStreamState, streamReducer } = await load();
    const hidden = streamReducer(initialStreamState({ hidden: false, tab: "overview" }), {
      type: "visibility",
      hidden: true,
    });
    const reopened = streamReducer(hidden, { type: "visibility", hidden: false });
    expect(reopened.open).toBe(true);
    expect(reopened.needsCatchUp).toBe(true);
    expect(streamReducer(reopened, { type: "caughtUp" })).toEqual({
      ...reopened,
      needsCatchUp: false,
    });
  });

  it("closes on the logs tab and reopens with catch-up on overview", async () => {
    const { initialStreamState, streamReducer } = await load();
    const logs = streamReducer(initialStreamState({ hidden: false, tab: "overview" }), {
      type: "tab",
      tab: "logs",
    });
    expect(logs.open).toBe(false);
    expect(logs.needsCatchUp).toBe(false);
    const back = streamReducer(logs, { type: "tab", tab: "overview" });
    expect(back.open).toBe(true);
    expect(back.needsCatchUp).toBe(true);
  });

  it("throws on unknown actions", async () => {
    const { initialStreamState, streamReducer } = await load();
    expect(() =>
      streamReducer(initialStreamState({ hidden: false, tab: "overview" }), { type: "bogus" }),
    ).toThrow();
  });
});

describe("/api/usage/stream", () => {
  it("sends exactly one slim frame per event and never calls getUsageStats", async () => {
    const routePath = new URL("../../src/app/api/usage/stream/route.js", import.meta.url);
    // The route must not import the full-history aggregator at all.
    expect(fs.readFileSync(routePath, "utf8")).not.toMatch(/getUsageStats/);

    const { GET } = await import("../../src/app/api/usage/stream/route.js");
    const { statsEmitter } = await import("@/lib/db/index.js");
    const res = await GET(new Request("http://localhost/api/usage/stream"));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const readFrame = async () => {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const text = decoder.decode(value);
      expect(text.startsWith("data: ")).toBe(true);
      return JSON.parse(text.slice("data: ".length));
    };

    try {
      const first = await readFrame();
      expect(Object.keys(first).sort()).toEqual([
        "activeRequests",
        "errorProvider",
        "lastProvider",
      ]);
      expect(first).not.toHaveProperty("totalRequests");

      statsEmitter.emit("pending");
      const second = await readFrame();
      expect(Object.keys(second).sort()).toEqual([
        "activeRequests",
        "errorProvider",
        "lastProvider",
      ]);
      expect(second).not.toHaveProperty("totalRequests");

      // A live pending request shows up in the next frame.
      db.trackPendingRequest("gpt-5", "openai", "conn-live-1", true);
      statsEmitter.emit("pending");
      const third = await readFrame();
      expect(third.activeRequests).toEqual([{ provider: "openai", count: 1 }]);
    } finally {
      db.trackPendingRequest("gpt-5", "openai", "conn-live-1", false);
      await reader.cancel();
    }
  });
});
