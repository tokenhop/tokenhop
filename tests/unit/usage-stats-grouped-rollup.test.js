// YAN-1227: day-grain usage stats sum usageRollup per attribution dims in SQL
// (readRollupGrouped) instead of loading one row per day × dims and folding in
// JS. The reference fold below is the pre-YAN-1227 semantics: every raw rollup
// row with requests > 0 bumps its buckets, lastUsed = the latest dateKey.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { shiftDateKey } from "@/shared/utils/period.js";

const TODAY = "2026-09-30";
const NOW = new Date(2026, 8, 30, 12).getTime();
const NO_KEY = "local-no-key";
// Display names resolved by getUsageStats: a provider node, a named
// connection and a stored (legacy, raw-key) gateway key. Placeholders in
// COMBOS are swapped for the live ids once they exist.
const NODE_ID = "openai-compatible-gw";
const NODE_NAME = "My Gateway";
const CONN_NAME = "Team OpenAI";
const KEY_NAME = "Key One";
const live = {};

let db;
let adapter;
let rollup;

beforeAll(async () => {
  // Pin the local clock (Date only) so period cutoffs can't roll over mid-test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  rollup = await import("@/lib/db/repos/usageRollupRepo.js");
  await db.createProviderNodeUnscoped({
    id: NODE_ID,
    type: "openai-compatible",
    name: NODE_NAME,
    prefix: "gw",
    apiType: "chat",
    baseUrl: "https://gw.test",
  });
  const conn = await db.createProviderConnectionUnscoped({
    provider: "openai",
    authType: "apikey",
    name: CONN_NAME,
    apiKey: "sk-test-grouped-rollup",
  });
  const key = await db.createApiKey(KEY_NAME, "machine01");
  live["@conn"] = conn.id;
  live["@key"] = key.id;
  live.keyMasked = `${key.key.slice(0, 8)}***`;
});

afterAll(() => vi.useRealTimers());

beforeEach(() => {
  adapter.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
});

/** Combo with its `@placeholder` dims swapped for live ids. */
const resolve = (combo) =>
  Object.fromEntries(Object.entries(combo).map(([k, v]) => [k, live[v] ?? v]));

// Attribution combos covering every bucket rule: no provider (not in
// byProvider), no connection (not in byAccount), no endpoint ("Unknown"), no
// key (sentinel), unknown key/connection ids (fallback labels), a provider
// node (display name), two users sharing dims (merged), and a second workspace.
const SHARED = {
  provider: "openai",
  model: "gpt-4o",
  connectionId: "@conn",
  apiKeyId: "@key",
  endpoint: "/v1/chat/completions",
};
const ORPHAN = { workspaceId: "ws-a", userId: "u1", model: "orphan-model", apiKeyId: "key-2" };
const COMBOS = [
  { workspaceId: "ws-a", userId: "u1", ...SHARED },
  { workspaceId: "ws-a", userId: "u2", ...SHARED },
  {
    workspaceId: "ws-a",
    userId: "u1",
    provider: "openai",
    model: "gpt-4o-mini",
    connectionId: "conn-bbbbbbbb2",
    apiKeyId: "key-2",
    endpoint: "/v1/responses",
  },
  {
    workspaceId: "ws-a",
    userId: "u1",
    provider: "anthropic",
    model: "claude-x",
    connectionId: "conn-cccccccc3",
    endpoint: "/v1/messages",
  },
  {
    workspaceId: "ws-a",
    userId: "u1",
    provider: "anthropic",
    model: "claude-x",
    connectionId: "conn-dddddddd4",
    apiKeyId: "@key",
    endpoint: "completions",
  },
  {
    workspaceId: "ws-a",
    userId: "u1",
    provider: NODE_ID,
    model: "gw-model",
    apiKeyId: "@key",
    endpoint: "/v1/chat/completions",
  },
  ORPHAN,
  { workspaceId: "ws-a", userId: "u2", provider: "gemini", model: "g-pro", endpoint: "" },
  { workspaceId: "ws-b", userId: "u9", ...SHARED },
  {
    workspaceId: "ws-b",
    userId: "u9",
    provider: "mistral",
    model: "m-large",
    connectionId: "conn-eeeeeeee5",
    apiKeyId: "key-3",
    endpoint: "/v1/chat/completions",
  },
];

// Deterministic LCG so the seed is identical on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Days `newest`..`oldest` ago (inclusive); each combo is active on a random
 * subset of days.
 */
function seedRollup({ newest = 0, oldest = 149 } = {}) {
  const rand = rng(1227);
  for (let n = newest; n <= oldest; n++) {
    const dateKey = shiftDateKey(TODAY, -n);
    for (const combo of COMBOS) {
      if (rand() < 0.35) continue;
      // An occasional zero-request row (savings-only shape) must not count.
      const requests = rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 40);
      rollup.upsertRollupRowUnscoped(
        adapter,
        { dateKey, ...resolve(combo) },
        {
          requests,
          tokensIn: Math.floor(rand() * 50_000),
          tokensOut: Math.floor(rand() * 9_000),
          tokensCached: Math.floor(rand() * 4_000),
          cost: rand() * 0.37,
        },
      );
    }
  }
}

// --- reference fold (old readRollup + aggregate semantics) -------------------

const zero = () => ({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
});

function keyIdentity(raw) {
  if (!raw || raw === NO_KEY) {
    return { apiKeyKey: NO_KEY, keyName: "Local (no API key)", apiKeyMasked: null };
  }
  if (raw === live["@key"])
    return { apiKeyKey: raw, keyName: KEY_NAME, apiKeyMasked: live.keyMasked };
  const tag = createHash("sha256").update(raw).digest("hex").slice(0, 6);
  return { apiKeyKey: raw, keyName: `Unknown key (${tag})`, apiKeyMasked: null };
}

/** Bucket name → [key, labels] for one row, with the old aggregate() rules. */
function bucketsFor(r) {
  const model = r.model || "";
  const provider = r.provider || "";
  const display = provider === NODE_ID ? NODE_NAME : provider;
  const key = keyIdentity(r.apiKeyId);
  const out = {
    byModel: [provider ? `${model} (${provider})` : model, { rawModel: model, provider: display }],
    byApiKey: [
      `${key.apiKeyKey}|${model}|${provider || "unknown"}`,
      { rawModel: model, provider: display, ...key },
    ],
    byEndpoint: [
      `${r.endpoint || "Unknown"}|${model}|${provider || "unknown"}`,
      { endpoint: r.endpoint || "Unknown", rawModel: model, provider: display },
    ],
  };
  if (provider) out.byProvider = [provider, {}];
  if (r.connectionId) {
    const accountName =
      r.connectionId === live["@conn"] ? CONN_NAME : `Account ${r.connectionId.slice(0, 8)}...`;
    out.byAccount = [
      `${model} (${provider} - ${accountName})`,
      { rawModel: model, provider: display, connectionId: r.connectionId, accountName },
    ];
  }
  return out;
}

function referenceStats({ workspaceId = null, from = null, to = null } = {}) {
  const rows = adapter
    .all("SELECT * FROM usageRollup ORDER BY dateKey")
    .filter((r) => r.requests > 0)
    .filter((r) => !workspaceId || r.workspaceId === workspaceId)
    .filter((r) => (!from || r.dateKey >= from) && (!to || r.dateKey <= to));
  const ref = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
  };
  for (const r of rows) {
    ref.totalPromptTokens += r.tokensIn;
    ref.totalCompletionTokens += r.tokensOut;
    ref.totalCachedTokens += r.tokensCached;
    ref.totalCost += r.cost;
    for (const [name, [key, labels]] of Object.entries(bucketsFor(r))) {
      ref[name][key] ||= { ...zero(), ...labels, lastUsed: "" };
      const t = ref[name][key];
      t.requests += r.requests;
      t.promptTokens += r.tokensIn;
      t.completionTokens += r.tokensOut;
      t.cachedTokens += r.tokensCached;
      t.cost += r.cost;
      if (r.dateKey > t.lastUsed) t.lastUsed = r.dateKey;
    }
  }
  for (const b of Object.values(ref.byProvider)) delete b.lastUsed;
  return ref;
}

const BUCKETS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"];

function expectParity(stats, ref) {
  for (const name of BUCKETS) {
    expect(Object.keys(stats[name]).sort(), name).toEqual(Object.keys(ref[name]).sort());
    for (const [key, want] of Object.entries(ref[name])) {
      const got = stats[name][key];
      const label = `${name}[${key}]`;
      const { cost, ...exact } = want;
      // Measures, lastUsed and every display label match exactly; extra
      // fields (endpoint latency summaries) are out of scope here.
      expect(got, label).toMatchObject(exact);
      expect(got.cost, label).toBeCloseTo(cost, 9);
      if (name === "byProvider") expect(got, label).not.toHaveProperty("lastUsed");
    }
  }
  expect(stats.totalPromptTokens).toBe(ref.totalPromptTokens);
  expect(stats.totalCompletionTokens).toBe(ref.totalCompletionTokens);
  expect(stats.totalCachedTokens).toBe(ref.totalCachedTokens);
  expect(stats.totalCost).toBeCloseTo(ref.totalCost, 9);
  expect(stats.totalRequests).toBe(
    Object.values(ref.byProvider).reduce((s, p) => s + p.requests, 0),
  );
}

// Inclusive first day of a `days`-day window ending TODAY (cutoffDateKey).
const windowStart = (days) => shiftDateKey(TODAY, -(days - 1));

describe("getUsageStats day-grain parity with the per-row fold", () => {
  it.each([
    ["30d", windowStart(30)],
    ["90d", windowStart(90)],
    ["all", null],
  ])("unscoped %s", async (period, from) => {
    seedRollup();
    const ref = referenceStats({ from });
    // Non-vacuous: every bucket kind, resolved names and fallbacks are present.
    const accounts = Object.values(ref.byAccount).map((b) => b.accountName);
    expect(accounts).toContain(CONN_NAME);
    expect(accounts).toContain("Account conn-bbb...");
    expect(Object.values(ref.byModel).map((b) => b.provider)).toContain(NODE_NAME);
    const keyNames = Object.values(ref.byApiKey).map((b) => b.keyName);
    expect(keyNames).toContain(KEY_NAME);
    expect(keyNames).toContain("Local (no API key)");
    expect(keyNames.some((n) => n.startsWith("Unknown key ("))).toBe(true);
    expectParity(await db.getUsageStats(null, period), ref);
  });

  it("unscoped custom range (both bounds inclusive)", async () => {
    seedRollup();
    const range = { from: shiftDateKey(TODAY, -100), to: shiftDateKey(TODAY, -40) };
    const ref = referenceStats(range);
    expectParity(await db.getUsageStats(null, "custom", range), ref);
  });

  it.each([
    ["30d", windowStart(30)],
    ["all", null],
  ])("workspace-scoped %s excludes the other workspace", async (period, from) => {
    seedRollup();
    const ref = referenceStats({ workspaceId: "ws-a", from });
    const stats = await db.getUsageStats({ workspaceId: "ws-a" }, period);
    expectParity(stats, ref);
    expect(stats.byProvider).not.toHaveProperty("mistral");
    // Control: unscoped sees ws-b's rows.
    const all = await db.getUsageStats(null, period);
    expect(all.byProvider).toHaveProperty("mistral");
  });

  it("7d overlays history timestamps onto the grouped buckets", async () => {
    // Rollup days 2..10 ago, history today: every overlaid bucket's history
    // timestamp is later than its rollup dateKey in any server time zone.
    seedRollup({ newest: 2, oldest: 10 });
    const latest = new Date(NOW - 3_600_000).toISOString();
    // Unscoped read; the overlay groups by provider/model/connection/key/
    // endpoint only, so history rows need no workspace/user (FK-checked).
    const history = [
      { ...resolve(COMBOS[0]), timestamp: new Date(NOW - 7_200_000).toISOString() },
      { ...resolve(COMBOS[0]), timestamp: latest }, // same dims: MAX wins
      { ...ORPHAN, timestamp: new Date(NOW - 5_400_000).toISOString() },
    ];
    for (const h of history) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, endpoint)
         VALUES(?, ?, ?, ?, ?, ?)`,
        [
          h.timestamp,
          h.provider ?? null,
          h.model,
          h.connectionId ?? null,
          h.apiKeyId,
          h.endpoint ?? null,
        ],
      );
    }

    const ref = referenceStats({ from: windowStart(7) });
    const overlaid = [
      [bucketsFor(resolve(COMBOS[0])), latest],
      [bucketsFor(ORPHAN), history[2].timestamp],
    ];
    let count = 0;
    for (const [buckets, ts] of overlaid) {
      for (const [name, [key]] of Object.entries(buckets)) {
        if (name === "byProvider") continue;
        expect(ref[name][key], `${name}[${key}] seeded in rollup`).toBeDefined();
        expect(ref[name][key].lastUsed < shiftDateKey(TODAY, -1)).toBe(true);
        ref[name][key].lastUsed = ts;
        count++;
      }
    }
    // gpt-4o: byModel/byApiKey/byEndpoint/byAccount; orphan: no account.
    expect(count).toBe(7);
    expectParity(await db.getUsageStats(null, "7d"), ref);
  });
});

describe("readRollupGrouped", () => {
  const dims = [
    {
      provider: "openai",
      model: "gpt-4o",
      connectionId: "c1",
      apiKeyId: "key-1",
      endpoint: "/v1/chat/completions",
    },
    { provider: "anthropic", model: "claude-x", endpoint: "/v1/messages" },
    { model: "orphan" },
  ];

  it("returns one row per distinct dims, not per day", () => {
    for (let n = 0; n < 60; n++) {
      for (const [i, d] of dims.entries()) {
        rollup.upsertRollupRowUnscoped(
          adapter,
          { dateKey: shiftDateKey(TODAY, -n), workspaceId: "ws-a", userId: `u${n % 2}`, ...d },
          { requests: i + 1, tokensIn: 10, tokensOut: 2, tokensCached: 1, cost: 0.5 },
        );
      }
    }
    expect(adapter.get("SELECT COUNT(*) AS n FROM usageRollup").n).toBe(180);

    const rows = rollup.readRollupGrouped(null, adapter);
    expect(rows).toHaveLength(3);
    // Every combo starts on the same day, so ties fall back to the dims order
    // (null provider first).
    expect(rows).toEqual([
      {
        provider: null,
        model: "orphan",
        connectionId: null,
        apiKeyId: NO_KEY,
        endpoint: null,
        requests: 180,
        tokensIn: 600,
        tokensOut: 120,
        tokensCached: 60,
        cost: 30,
        lastUsed: TODAY,
      },
      {
        provider: "anthropic",
        model: "claude-x",
        connectionId: null,
        apiKeyId: NO_KEY,
        endpoint: "/v1/messages",
        requests: 120,
        tokensIn: 600,
        tokensOut: 120,
        tokensCached: 60,
        cost: 30,
        lastUsed: TODAY,
      },
      {
        provider: "openai",
        model: "gpt-4o",
        connectionId: "c1",
        apiKeyId: "key-1",
        endpoint: "/v1/chat/completions",
        requests: 60,
        tokensIn: 600,
        tokensOut: 120,
        tokensCached: 60,
        cost: 30,
        lastUsed: TODAY,
      },
    ]);
  });

  it("applies inclusive bounds, scope and the requests > 0 filter", () => {
    const put = (n, workspaceId, requests, d = dims[0]) =>
      rollup.upsertRollupRowUnscoped(
        adapter,
        { dateKey: shiftDateKey(TODAY, -n), workspaceId, ...d },
        { requests, tokensIn: requests * 10, cost: requests },
      );
    put(10, "ws-a", 1); // before the range
    put(8, "ws-a", 2); // from (inclusive)
    put(6, "ws-a", 0, dims[1]); // zero-request row: dropped
    put(5, "ws-b", 100); // other workspace
    put(3, "ws-a", 4); // to (inclusive)
    put(2, "ws-a", 8, dims[2]); // after the range

    const from = shiftDateKey(TODAY, -8);
    const to = shiftDateKey(TODAY, -3);
    expect(rollup.readRollupGrouped({ workspaceId: "ws-a" }, adapter, from, to)).toEqual([
      expect.objectContaining({
        model: "gpt-4o",
        requests: 6,
        tokensIn: 60,
        cost: 6,
        lastUsed: to,
      }),
    ]);
    // Unscoped, same window: ws-b's row sums in under the same dims.
    expect(rollup.readRollupGrouped(null, adapter, from, to)).toEqual([
      expect.objectContaining({ model: "gpt-4o", requests: 106, lastUsed: to }),
    ]);
  });

  it("orders buckets by first-seen day", () => {
    const put = (n, d) =>
      rollup.upsertRollupRowUnscoped(adapter, { dateKey: shiftDateKey(TODAY, -n), ...d }, {});
    put(1, dims[0]);
    put(20, dims[2]);
    put(3, dims[1]);
    put(2, dims[2]);
    expect(rollup.readRollupGrouped(null, adapter).map((r) => r.model)).toEqual([
      "orphan",
      "claude-x",
      "gpt-4o",
    ]);
  });
});
