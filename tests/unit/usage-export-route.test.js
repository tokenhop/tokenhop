// YAN-425: GET /api/usage/export — validation (400s), auth (via the shared
// usageScope principal check), scoping, and streamed CSV/JSON bodies whose
// totals match the on-screen readers for the same window.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

// Same cookie-jar mirror as usage-scope-filter.test.js: getPrincipal reads
// cookies() from next/headers.
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const m = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return m ? { name: n, value: m[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let t;
let GET;
let makeStream;
let parseExportParams;

const NOW = "2026-10-09T00:00:00.000Z";
const seedKey = (a, { id, workspaceId, userId = null }) =>
  a.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, keyHash, hashKid, prefix, name, revokedAt, createdAt)
     VALUES (?, ?, ?, ?, 'kid', 'sk-', ?, NULL, ?)`,
    [id, workspaceId, userId, `hash-${id}`, `Key ${id}`, NOW],
  );

const adapter = () => import("@/lib/db/driver.js").then((m) => m.getAdapter());

async function load(state) {
  jar.cookie = "";
  vi.resetModules();
  process.env[ENV] = state;
  ({ GET, makeStream, parseExportParams } = await import("@/app/api/usage/export/route.js"));
}

async function as(seeded, path) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await GET(new Request(new URL(path, "http://localhost")));
  } finally {
    jar.cookie = "";
  }
}

const csvLines = async (res) => (await res.text()).trimEnd().split("\r\n");

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});
afterEach(() => vi.useRealTimers());
const freezeNoon = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  vi.setSystemTime(noon);
};

// Direct SQL seeding (history + rollup in one go) so the fixture carries the
// same attribution the gateway writer would persist.
async function seedUsage() {
  const a = await adapter();
  const { upsertRollupRowUnscoped, localDateKey } = await import(
    "@/lib/db/repos/usageRollupRepo.js"
  );
  const today = new Date();
  const iso = (h) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate(), h).toISOString();
  const insert = ({ ts, workspaceId, userId, apiKeyId, prompt, completion, cached = 0 }) => {
    a.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId)
       VALUES (?, 'openai', 'gpt-4o', NULL, NULL, '/v1/chat/completions', ?, ?, 0.5, 'ok', ?, '{}', ?, ?, ?)`,
      [
        ts,
        prompt,
        completion,
        JSON.stringify({
          prompt_tokens: prompt,
          completion_tokens: completion,
          cached_tokens: cached,
        }),
        workspaceId,
        userId,
        apiKeyId,
      ],
    );
    upsertRollupRowUnscoped(
      a,
      {
        dateKey: localDateKey(ts),
        workspaceId,
        userId,
        apiKeyId,
        provider: "openai",
        model: "gpt-4o",
        endpoint: "/v1/chat/completions",
      },
      { tokensIn: prompt, tokensOut: completion, tokensCached: cached, cost: 0.5 },
    );
  };
  // Owner key twice + member key once in the shared workspace; one row in a
  // workspace the filter never names, which must not leak into the export.
  insert({
    ts: iso(1),
    workspaceId: t.shared.id,
    userId: t.a.user.id,
    apiKeyId: "k-a",
    prompt: 10,
    completion: 5,
    cached: 2,
  });
  insert({
    ts: iso(2),
    workspaceId: t.shared.id,
    userId: t.a.user.id,
    apiKeyId: "k-a",
    prompt: 20,
    completion: 7,
  });
  insert({
    ts: iso(3),
    workspaceId: t.shared.id,
    userId: t.b.user.id,
    apiKeyId: "k-b",
    prompt: 100,
    completion: 50,
  });
  insert({
    ts: iso(4),
    workspaceId: t.b.personal,
    userId: t.b.user.id,
    apiKeyId: "k-b",
    prompt: 999,
    completion: 999,
  });
}

describe("parseExportParams validation", () => {
  beforeEach(() => load("on"));
  const params = (qs) => parseExportParams(new URL(`http://x/?${qs}`).searchParams);

  it("defaults to csv/daily for 7d and rejects bad format/granularity/period", () => {
    expect(params("")).toMatchObject({ format: "csv", granularity: "day", period: "7d" });
    expect(params("format=xml").error).toMatch(/format/i);
    expect(params("granularity=hour").error).toMatch(/granularity/i);
    expect(params("period=1y").error).toMatch(/period/i);
  });

  it("rejects custom ranges that are inverted, malformed or over the cap", () => {
    expect(params("period=custom&from=2026-10-02&to=2026-10-01").error).toBeTruthy();
    expect(params("period=custom&from=2026-02-30&to=2026-03-01").error).toBeTruthy();
    expect(params("period=custom&from=2024-01-01&to=2026-01-01").error).toBeTruthy();
    expect(params("period=custom&from=2026-10-01").error).toBeTruthy();
  });

  it("accepts request granularity for every period and resolves history windows", () => {
    expect(params("period=90d&granularity=request").error).toBeUndefined();
    expect(params("period=90d&granularity=request").window.history.startMs).toEqual(
      expect.any(Number),
    );
    expect(params("period=all&granularity=request").window.history.startMs).toBeNull();
    const custom = params("period=custom&from=2026-10-01&to=2026-10-02&granularity=request");
    expect(custom.error).toBeUndefined();
    expect(custom.window.history.startMs).toBeLessThan(custom.window.history.nowMs);
    expect(params("period=24h&granularity=request").error).toBeUndefined();
    expect(params("period=today&granularity=request").error).toBeUndefined();
  });
});

describe("GET /api/usage/export", () => {
  beforeEach(async () => {
    freezeNoon();
    await load("on");
    const a = await adapter();
    // Hashed key schema fixture, same as usage-scope-filter.test.js.
    a.exec("DROP TABLE IF EXISTS apiKeys");
    a.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    t = await seedTenancy();
    seedKey(a, { id: "k-a", workspaceId: t.shared.id, userId: t.a.user.id });
    seedKey(a, { id: "k-b", workspaceId: t.shared.id, userId: t.b.user.id });
    await seedUsage();
  });

  it("returns 400 for bad format, granularity, period and inverted range", async () => {
    for (const path of [
      "/api/usage/export?format=xml",
      "/api/usage/export?granularity=hour",
      "/api/usage/export?period=1y",
      "/api/usage/export?period=custom&from=2026-10-02&to=2026-10-01",
    ]) {
      jar.cookie = "";
      const res = await GET(new Request(new URL(path, "http://localhost")));
      expect(res.status, path).toBe(400);
    }
  });

  it("requires auth when the multi-user switch is on (401 from usageScope)", async () => {
    jar.cookie = "";
    const res = await GET(new Request("http://localhost/api/usage/export?period=today"));
    expect(res.status).toBe(401);
  });

  it("member asking for the workspace view gets 403 from usageScope", async () => {
    const res = await as(
      t.b,
      `/api/usage/export?period=today&workspaceId=${t.shared.id}&view=workspace`,
    );
    expect(res.status).toBe(403);
  });

  it("exports today's requests for the workspace view without leaking the foreign workspace or raw keys", async () => {
    const res = await as(
      t.a,
      `/api/usage/export?period=today&granularity=request&format=csv&workspaceId=${t.shared.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tokenhop-usage-today-request.csv"',
    );
    const body = await res.text();
    expect(body).not.toContain("sk-");
    expect(body).not.toContain("hash-");
    const lines = body.trimEnd().split("\r\n");
    expect(lines[0]).toContain("timestamp,provider,model");
    expect(lines).toHaveLength(1 + 3);
    const prompts = lines.slice(1).map((l) => Number(l.split(",")[8]));
    expect(prompts.reduce((x, y) => x + y, 0)).toBe(130);
  });

  it("scopes a member to their own rows by default", async () => {
    const lines = await csvLines(
      await as(
        t.b,
        `/api/usage/export?period=today&granularity=request&workspaceId=${t.shared.id}`,
      ),
    );
    expect(lines).toHaveLength(1 + 1);
    expect(lines[1]).toContain(",100,");
  });

  it("applies the apiKeyId filter", async () => {
    const lines = await csvLines(
      await as(
        t.a,
        `/api/usage/export?period=today&granularity=request&workspaceId=${t.shared.id}&apiKeyId=k-a`,
      ),
    );
    expect(lines).toHaveLength(1 + 2);
  });

  it("daily JSON export for today sums to the request-level totals", async () => {
    const res = await as(
      t.a,
      `/api/usage/export?period=today&granularity=day&format=json&workspaceId=${t.shared.id}`,
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tokenhop-usage-today-day.json"',
    );
    const rows = JSON.parse(await res.text());
    const totals = rows.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        prompt: acc.prompt + r.prompt_tokens,
        completion: acc.completion + r.completion_tokens,
      }),
      { requests: 0, prompt: 0, completion: 0 },
    );
    expect(totals).toEqual({ requests: 3, prompt: 130, completion: 62 });
  });

  it("request export for 7d and custom ranges streams history; nosniff is set", async () => {
    const { localDateKey } = await import("@/lib/db/repos/usageRollupRepo.js");
    const todayKey = localDateKey(new Date().toISOString());
    for (const q of ["period=7d", `period=custom&from=${todayKey}&to=${todayKey}`, "period=all"]) {
      const res = await as(
        t.a,
        `/api/usage/export?${q}&granularity=request&format=json&workspaceId=${t.shared.id}`,
      );
      expect(res.status, q).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(JSON.parse(await res.text())).toHaveLength(3);
    }
  });

  it("neutralizes a formula-leading model in CSV at route level", async () => {
    const a = await adapter();
    const ts = new Date();
    ts.setHours(7, 0, 0, 0);
    a.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId)
       VALUES (?, 'openai', '=cmd', NULL, NULL, '/v1/chat', 1, 1, 0, 'ok', '{}', '{}', ?, ?, 'k-a')`,
      [ts.toISOString(), t.shared.id, t.a.user.id],
    );
    const body = await (
      await as(
        t.a,
        `/api/usage/export?period=today&granularity=request&format=csv&workspaceId=${t.shared.id}`,
      )
    ).text();
    expect(body).toContain("'=cmd");
    expect(body).not.toContain(",=cmd,");
  });

  it("cancelling the stream calls iterator return without logging a stream failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let returned = false;
    async function* rows() {
      try {
        yield { timestamp: "2026-01-01T00:00:00.000Z" };
        yield { timestamp: "2026-01-01T00:01:00.000Z" };
      } finally {
        returned = true;
      }
    }
    const it = rows();
    const first = await it.next();
    const stream = makeStream(it, first, { format: "csv", columns: ["timestamp"] });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(returned).toBe(true);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("Usage export stream failed");
    errorSpy.mockRestore();
  });

  it("token parity: promptTokens=0 columns ignore JSON fallbacks, matching getUsageStats", async () => {
    const a = await adapter();
    const ts = new Date();
    ts.setHours(5, 0, 0, 0);
    a.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId)
       VALUES (?, 'openai', 'gpt-4o', NULL, NULL, '/v1/chat/completions', 0, 0, 0, 'ok', ?, '{}', ?, ?, 'k-a')`,
      [
        ts.toISOString(),
        JSON.stringify({ prompt_tokens: 777, completion_tokens: 888, cached_tokens: 9 }),
        t.shared.id,
        t.a.user.id,
      ],
    );
    const { getUsageStats } = await import("@/lib/db/repos/usageStatsRepo.js");
    const scope = { workspaceId: t.shared.id, userId: null, apiKeyId: null };
    const stats = await getUsageStats(scope, "today");
    const res = await as(
      t.a,
      `/api/usage/export?period=today&granularity=request&format=json&workspaceId=${t.shared.id}`,
    );
    const rows = JSON.parse(await res.text());
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    // Seeded rows (130/62) plus this row's 0/0 columns and 9 cached.
    expect(sum("prompt_tokens")).toBe(stats.totalPromptTokens);
    expect(sum("completion_tokens")).toBe(stats.totalCompletionTokens);
    expect(sum("cached_tokens")).toBe(stats.totalCachedTokens);
    expect(sum("prompt_tokens")).toBe(130);
  });

  it("paginates >500 history rows and >500 rollup rows without dupes or misses", async () => {
    const a = await adapter();
    const { upsertRollupRowUnscoped, localDateKey } = await import(
      "@/lib/db/repos/usageRollupRepo.js"
    );
    const base = new Date();
    base.setHours(6, 0, 0, 0);
    const values = [];
    const params = [];
    for (let i = 0; i < 505; i++) {
      values.push(
        "(?, 'openai', ?, NULL, NULL, '/v1/chat', 1, 1, 0.001, 'ok', '{}', '{}', ?, ?, 'k-a')",
      );
      // Rows 497..504 share one timestamp, spanning the 500-row page edge so
      // the (timestamp, id) cursor must split a tie without dupes or misses.
      const tie = i >= 497 && i <= 506 ? 497 : i;
      params.push(
        new Date(base.getTime() + tie * 1000).toISOString(),
        `m-${String(i).padStart(3, "0")}`,
        t.shared.id,
        t.a.user.id,
      );
    }
    a.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId) VALUES ${values.join(",")}`,
      params,
    );
    // 505 distinct rollup dimension rows, many with '' (null) dimensions.
    for (let i = 0; i < 505; i++) {
      upsertRollupRowUnscoped(
        a,
        {
          dateKey: localDateKey(base.toISOString()),
          workspaceId: t.shared.id,
          userId: t.a.user.id,
          apiKeyId: "k-a",
          provider: i % 2 ? "openai" : "",
          model: `m-${String(i).padStart(3, "0")}`,
          connectionId: "",
          endpoint: i % 3 ? "/v1/chat" : "",
        },
        { tokensIn: 1, tokensOut: 1, cost: 0.001 },
      );
    }
    const reqRes = await as(
      t.a,
      `/api/usage/export?period=today&granularity=request&format=json&workspaceId=${t.shared.id}`,
    );
    const reqRows = JSON.parse(await reqRes.text());
    // 505 new + 2 seeded k-a rows in shared today (member row is k-b, still workspace view).
    expect(reqRows.length).toBe(508);
    expect(new Set(reqRows.map((r) => `${r.timestamp}|${r.model}`)).size).toBe(reqRows.length);

    const dayRes = await as(
      t.a,
      `/api/usage/export?period=custom&from=${localDateKey(base.toISOString())}&to=${localDateKey(base.toISOString())}&granularity=day&format=json&workspaceId=${t.shared.id}`,
    );
    const dayRows = JSON.parse(await dayRes.text());
    const totalRequests = dayRows.reduce((s, r) => s + r.requests, 0);
    // 505 new groups + seeded groups (k-a gpt-4o, k-b gpt-4o), each requests>=1.
    expect(dayRows.length).toBeGreaterThanOrEqual(505);
    expect(totalRequests).toBe(505 + 3);
    expect(new Set(dayRows.map((r) => `${r.date}|${r.model}|${r.api_key}`)).size).toBe(
      dayRows.length,
    );
  });

  it("custom-range daily export reads the rollup with the same totals", async () => {
    const { localDateKey } = await import("@/lib/db/repos/usageRollupRepo.js");
    const todayKey = localDateKey(new Date().toISOString());
    const lines = await csvLines(
      await as(
        t.a,
        `/api/usage/export?period=custom&from=${todayKey}&to=${todayKey}&granularity=day&workspaceId=${t.shared.id}`,
      ),
    );
    expect(lines.join("\n")).toContain("gpt-4o");
    const requests = lines.slice(1).reduce((sum, l) => sum + Number(l.split(",")[8]), 0);
    expect(requests).toBe(3);
  });
});
