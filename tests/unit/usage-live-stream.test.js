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
      lastProvider: "anthropic",
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
      lastProvider: worstRecent[0].provider,
    });
    expect(payload.activeRequests).toHaveLength(LIVE_ACTIVE_CAP);
    expect(payload.activeRequests[0].count).toBe(worstActive.length);
    expect(Object.keys(payload.activeRequests[0]).sort()).toEqual(["count", "provider"]);
    expect(payload.lastProvider).toBe(worstRecent[0].provider);
  });

  it("stays under 2048 bytes in the true worst case", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    const huge = "p".repeat(500);
    const payload = buildLivePayload({
      activeRequests: Array.from({ length: 500 }, (_, i) => ({
        provider: `${String(i).padStart(3, "0")}${huge}`,
        model: huge,
        account: huge,
        count: 9_999_999,
      })),
      lastProvider: huge,
      errorProvider: huge,
    });
    expect(JSON.stringify(payload).length).toBeLessThan(2048);
  });

  it("keeps providers sharing a long prefix separate (clip happens after aggregation)", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    const prefix = "p".repeat(60);
    const payload = buildLivePayload({
      activeRequests: [
        { provider: `${prefix}-a`, count: 1 },
        { provider: `${prefix}-b`, count: 2 },
      ],
      lastProvider: `${prefix}-a`,
    });
    // Two distinct ids never merge into one count, even though both clip to
    // the same 40-char string on the wire.
    expect(payload.activeRequests).toEqual([
      { provider: "p".repeat(40), count: 2 },
      { provider: "p".repeat(40), count: 1 },
    ]);
  });

  it("skips null or malformed active entries", async () => {
    const { buildLivePayload } = await import("../../src/lib/usage/livePayload.js");
    const payload = buildLivePayload({
      activeRequests: [null, undefined, { count: 7 }, { provider: "openai", count: 1 }],
    });
    expect(payload.activeRequests).toEqual([{ provider: "openai", count: 1 }]);
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

  it("a reconnect after an error asks for one catch-up only while open", async () => {
    const { initialStreamState, streamReducer } = await load();
    const open = initialStreamState({ hidden: false, tab: "overview" });
    const reconnected = streamReducer(open, { type: "reconnected" });
    expect(reconnected.needsCatchUp).toBe(true);
    expect(reconnected.open).toBe(true);
    // Not a catch-up trigger on its own: it can't stack while one is pending.
    expect(streamReducer(reconnected, { type: "reconnected" })).toBe(reconnected);

    // A closed stream (hidden or logs tab) reconnects silently.
    const closed = streamReducer(open, { type: "visibility", hidden: true });
    expect(streamReducer(closed, { type: "reconnected" })).toBe(closed);
  });
});

describe("/api/usage/stream", () => {
  it("sends slim frames built from getLiveSnapshot", async () => {
    vi.resetModules();
    vi.doMock("@/lib/usageDb", async (original) => {
      const actual = await original();
      return { ...actual, getLiveSnapshot: vi.fn() };
    });
    const route = await import("../../src/app/api/usage/stream/route.js");
    const { GET } = route;
    const { statsEmitter } = await import("@/lib/db/index.js");
    const usageDb = await import("@/lib/usageDb");
    usageDb.getLiveSnapshot.mockResolvedValue({
      activeRequests: [{ provider: "openai", count: 1 }],
      lastProvider: "openai",
      errorProvider: "",
    });

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
      // The whole frame comes from getLiveSnapshot alone.
      expect(usageDb.getLiveSnapshot).toHaveBeenCalled();
      expect(first).toEqual({
        activeRequests: [{ provider: "openai", count: 1 }],
        lastProvider: "openai",
        errorProvider: "",
      });

      statsEmitter.emit("pending");
      const second = await readFrame();
      expect(usageDb.getLiveSnapshot.mock.calls.length).toBeGreaterThan(1);
      expect(Object.keys(second).sort()).toEqual([
        "activeRequests",
        "errorProvider",
        "lastProvider",
      ]);
      expect(second).not.toHaveProperty("totalRequests");
    } finally {
      await reader.cancel();
    }
  });

  it("getLiveSnapshot aggregates pending requests and reuses the newest ring entry", async () => {
    db.trackPendingRequest("gpt-5", "openai", "conn-live-1", true);
    try {
      const snapshot = await db.getLiveSnapshot();
      expect(snapshot.activeRequests).toEqual([{ provider: "openai", count: 1 }]);
    } finally {
      db.trackPendingRequest("gpt-5", "openai", "conn-live-1", false);
    }

    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "ringlive",
      model: "ring-live-model",
      tokens: { prompt_tokens: 5 },
      status: "ok",
    });
    expect((await db.getLiveSnapshot()).lastProvider).toBe("ringlive");

    // Zero-token entries are not last usage, only inflight ring padding.
    await db.saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "zeroring",
      model: "zero-ring-model",
      tokens: {},
      status: "ok",
    });
    expect((await db.getLiveSnapshot()).lastProvider).toBe("ringlive");
  });
});
