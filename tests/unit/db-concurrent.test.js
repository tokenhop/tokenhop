// Concurrency stress test — simulate many parallel saveRequestUsage / saveRequestDetail
// to verify atomic counter, no data loss, no race conditions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-concurrent-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB Concurrency — atomic safety", () => {
  it("100 parallel saveRequestUsage → no count loss", async () => {
    const N = 100;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        db.saveRequestUsage({
          provider: "openai",
          model: "gpt-4",
          connectionId: "c1",
          tokens: { prompt_tokens: 10, completion_tokens: 5 },
          endpoint: "/v1/chat",
          status: "ok",
        }),
      );
    }
    await Promise.all(promises);

    const stats = await db.getUsageStatsUnscoped("24h");
    expect(stats.totalRequests).toBe(N);
    expect(stats.byProvider.openai.requests).toBe(N);
    expect(stats.byProvider.openai.promptTokens).toBe(N * 10);

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBe(N);
  });

  it("same-millisecond identical requests are all recorded", async () => {
    const N = 5;
    const timestamp = new Date().toISOString();
    await Promise.all(
      Array.from({ length: N }, () =>
        db.saveRequestUsage({
          timestamp,
          provider: "same-ms",
          model: "m",
          connectionId: "c-same",
          apiKey: "sk-same",
          tokens: { prompt_tokens: 7, completion_tokens: 3 },
          endpoint: "/v1/chat",
        }),
      ),
    );

    expect((await db.getUsageHistory({ provider: "same-ms" })).length).toBe(N);
    const stats = await db.getUsageStatsUnscoped("7d");
    expect(stats.byProvider["same-ms"].requests).toBe(N);
    expect(stats.byProvider["same-ms"].promptTokens).toBe(N * 7);
  });

  it("200 parallel saveRequestDetail → all flushed", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 10 });

    const N = 200;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        db.saveRequestDetail({
          id: `det-${i}`,
          provider: "openai",
          model: "gpt-4",
          connectionId: "c1",
          status: "ok",
          tokens: { prompt_tokens: 1 },
          request: { i },
          response: { ok: true },
        }),
      );
    }
    await Promise.all(promises);

    // Wait for any timer-based flush
    await new Promise((r) => setTimeout(r, 6000));

    const list = await db.getRequestDetails({ provider: "openai", pageSize: 500 });
    expect(list.pagination.totalItems).toBeGreaterThanOrEqual(N);
  }, 15000);

  it("mixed concurrent: usage + details + connections + aliases", async () => {
    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push(
        db.saveRequestUsage({
          provider: "anthropic",
          model: `m-${i % 3}`,
          connectionId: "c2",
          tokens: { prompt_tokens: 20 },
          status: "ok",
        }),
      );
      ops.push(db.setModelAliasUnscoped(`a-${i}`, `target-${i}`));
      ops.push(db.disableModelsUnscoped("openai", [`d-${i}`]));
    }
    await Promise.all(ops);

    const aliases = await db.getModelAliasesUnscoped();
    expect(Object.keys(aliases).filter((k) => k.startsWith("a-")).length).toBe(50);

    const disabled = await db.getDisabledByProviderUnscoped("openai");
    expect(disabled.length).toBeGreaterThanOrEqual(50);

    const stats = await db.getUsageStatsUnscoped("24h");
    expect(stats.byProvider.anthropic.requests).toBe(50);
  }, 30000);

  it("updateSettings parallel → no merge loss", async () => {
    const N = 50;
    await db.updateSettings({ counter: 0 });
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateSettings({ [`field${i}`]: `v${i}` }));
    }
    await Promise.all(promises);
    const s = await db.getSettings();
    for (let i = 0; i < N; i++) {
      expect(s[`field${i}`]).toBe(`v${i}`); // all updates preserved
    }
  });

  it("OAuth refresh race: parallel updateProviderConnectionUnscoped on same id", async () => {
    const conn = await db.createProviderConnectionUnscoped({
      provider: "oauth-test",
      authType: "oauth",
      email: "x@y.com",
      accessToken: "initial",
      refreshToken: "rt-initial",
    });

    // 20 parallel updates each with a unique field
    const N = 20;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateProviderConnectionUnscoped(conn.id, { [`marker${i}`]: i }));
    }
    await Promise.all(promises);

    const after = await db.getProviderConnectionByIdUnscoped(conn.id);
    for (let i = 0; i < N; i++) {
      expect(after[`marker${i}`]).toBe(i); // no field lost
    }
    expect(after.refreshToken).toBe("rt-initial"); // base preserved
  });

  it("addCustomModelUnscoped race: parallel duplicate adds → only 1 inserted", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        db.addCustomModelUnscoped({
          providerAlias: "racep",
          id: "racemodel",
          type: "llm",
          name: "r",
        }),
      );
    }
    const results = await Promise.all(promises);
    const trueCount = results.filter((r) => r === true).length;
    expect(trueCount).toBe(1); // exactly one wins
    const all = await db.getCustomModelsUnscoped();
    expect(all.filter((m) => m.providerAlias === "racep" && m.id === "racemodel").length).toBe(1);
  });

  it("updatePricing race: parallel adds different models → all merged", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updatePricing({ "race-prov": { [`m${i}`]: { input: i, output: i * 2 } } }));
    }
    await Promise.all(promises);
    const p = await db.getPricing();
    for (let i = 0; i < N; i++) {
      expect(p["race-prov"][`m${i}`]).toEqual({ input: i, output: i * 2 });
    }
  });

  it("daily summary aggregates correctly under parallel writes", async () => {
    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        db.saveRequestUsage({
          provider: "google",
          model: "gemini-pro",
          connectionId: "cG",
          tokens: { prompt_tokens: 100, completion_tokens: 50 },
          status: "ok",
        }),
      );
    }
    await Promise.all(promises);

    const stats = await db.getUsageStatsUnscoped("7d");
    const g = stats.byProvider.google;
    expect(g).toBeDefined();
    expect(g.requests).toBe(N);
    expect(g.promptTokens).toBe(N * 100);
    expect(g.completionTokens).toBe(N * 50);
  });
});
