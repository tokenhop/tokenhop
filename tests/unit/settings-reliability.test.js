import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reliability-api-"));
  process.env.DATA_DIR = tempDir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const settingsPatch = (body) =>
  import("@/app/api/settings/route.js").then(({ PATCH }) =>
    PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    ),
  );

const expect400 = async (body) => {
  const res = await settingsPatch(JSON.parse(JSON.stringify(body)));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
};

const expect200 = async (body, key, value) => {
  const res = await settingsPatch(body);
  expect(res.status).toBe(200);
  if (key !== undefined) expect((await res.json())[key]).toEqual(value);
};

describe("YAN-311 reliability validation", () => {
  it("accepts valid retryPolicy, cooldowns, backoff, streamTimeouts", async () => {
    await expect200(
      { retryPolicy: { 502: { tries: 5, delayMs: 1000 } } },
      "retryPolicy",
      expect.objectContaining({ 502: { tries: 5, delayMs: 1000 } }),
    );
    await expect200(
      { cooldowns: { longMs: 60000 } },
      "cooldowns",
      expect.objectContaining({ longMs: 60000 }),
    );
    await expect200(
      { backoff: { startMs: 500 } },
      "backoff",
      expect.objectContaining({ startMs: 500 }),
    );
    await expect200(
      { streamTimeouts: { stallMs: 60000 } },
      "streamTimeouts",
      expect.objectContaining({ stallMs: 60000 }),
    );
  });

  it("rejects out-of-range tries and delays", async () => {
    await expect400({ retryPolicy: { 502: { tries: 11 } } });
    await expect400({ retryPolicy: { 502: { tries: -1 } } });
    await expect400({ retryPolicy: { 502: { tries: 1.5 } } });
    await expect400({ retryPolicy: { 502: { delayMs: 60001 } } });
    await expect400({ retryPolicy: { 502: { delayMs: -1 } } });
  });

  it("rejects 429 and unknown statuses in retryPolicy", async () => {
    await expect400({ retryPolicy: { 429: { tries: 1 } } });
    await expect400({ retryPolicy: { 500: { tries: 1 } } });
    await expect400({ retryPolicy: { abc: { tries: 1 } } });
  });

  it("rejects out-of-range cooldowns, backoff and timeouts", async () => {
    await expect400({ cooldowns: { longMs: 999 } });
    await expect400({ cooldowns: { longMs: 86400001 } });
    await expect400({ cooldowns: { nope: 5000 } });
    await expect400({ backoff: { startMs: 50 } });
    await expect400({ backoff: { levels: 31 } });
    await expect400({ backoff: { startMs: 5000, maxMs: 1000 } });
    await expect400({ streamTimeouts: { stallMs: 500 } });
    await expect400({ streamTimeouts: { stallMs: 1800001 } });
    await expect400({ retryPolicy: "soon" });
    await expect400({ cooldowns: null });
  });

  it("merges partial patches over current values and restores defaults", async () => {
    const { RELIABILITY_DEFAULTS } = await import("../../open-sse/config/reliabilityPolicy.js");
    const { mergeReliabilityPatch } = await import(
      "@/app/api/settings/validateReliabilitySettings.js"
    );
    expect(mergeReliabilityPatch({ 502: { tries: 3 } }, { 502: { tries: 5 } })).toEqual({
      502: { tries: 5 },
    });
    expect(mergeReliabilityPatch({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeReliabilityPatch(undefined, { stallMs: 1000 })).toEqual({ stallMs: 1000 });
    await expect200({ retryPolicy: RELIABILITY_DEFAULTS.retryPolicy });
    await expect200({ cooldowns: RELIABILITY_DEFAULTS.cooldowns });
    await expect200({ backoff: RELIABILITY_DEFAULTS.backoff });
    await expect200({ streamTimeouts: RELIABILITY_DEFAULTS.streamTimeouts });
    const res = await settingsPatch({ retryPolicy: RELIABILITY_DEFAULTS.retryPolicy });
    expect(res.status).toBe(200);
  });

  it("keeps untouched leaves on partial retryPolicy patches", async () => {
    await settingsPatch({
      retryPolicy: { 502: { tries: 3, delayMs: 3000 } },
    });
    const res = await settingsPatch({ retryPolicy: { 503: { tries: 7, delayMs: 111 } } });
    expect(res.status).toBe(200);
    // DB starts blank (defaults fill every object), so partial patches keep
    // the default 504 leaf too.
    expect((await res.json()).retryPolicy).toEqual(
      expect.objectContaining({
        502: { tries: 3, delayMs: 3000 },
        503: { tries: 7, delayMs: 111 },
        504: { tries: 2, delayMs: 3000 },
      }),
    );
    await settingsPatch({
      retryPolicy: { 503: { tries: 3, delayMs: 2000 } },
    });
  });
});
