// REAL integration test: Antigravity (AG) prompt caching behavior.
//
// Verifies:
//  1. Same sessionId + repeated long prompt → cache hit (cachedContentTokenCount > 0)
//  2. Different sessionId (same account) → cache still hits (content-based cache)
//  3. Cross-account cache share? (call A warmup → B same prompt/session, check hit)
//  4. Codex-style stable sessionId vs random sessionId on a fresh unique prompt
//  5. Unique prompt → explore when the cache starts hitting
//
// Reads active Antigravity OAuth connections from the real SQLite DB
// (<DATA_DIR>/db/data.sqlite) via the app DB layer. Gated by RUN_REAL=1 so the
// default `vitest run` never touches the network or the real data dir.
//
//   npx dotenvx run -f .env.encrypted -- npx vitest run --config tests/vitest.config.js tests/translator/real/antigravity-cache.real.test.js
//
// Requires RUN_REAL=1 (default skip) and ANTIGRAVITY_OAUTH_CLIENT_ID/_SECRET,
// which live in the repo's encrypted env — hence the dotenvx wrapper (the env
// is read at module load, before the test can inject it). Tests skip cleanly
// when the DB is unavailable or no usable Antigravity connection exists.
import { beforeAll, describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dataDirResolver from "../../../src/shared/dataDir/index.cjs";
import { PROVIDERS } from "../../../open-sse/config/providers.js";
import {
  ANTIGRAVITY_HEADERS,
  INTERNAL_REQUEST_HEADER,
} from "../../../open-sse/config/appConstants.js";
import { assertOAuthClient } from "../../../open-sse/providers/shared.js";

const RUN_REAL = process.env.RUN_REAL === "1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FETCH_TIMEOUT_MS = 30000;
const MIN_CACHE_TOKENS = 100; // AG implicit cache threshold observed ~1024-2048
const LONG_TEXT = "You are a careful assistant. Always follow these rules. ".repeat(300).trim();

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = PROVIDERS.antigravity;
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Antigravity OAuth token refresh failed: HTTP ${res.status}`);
  const json = await res.json();
  if (typeof json.access_token !== "string" || !json.access_token.trim()) {
    throw new Error("Antigravity OAuth token refresh returned no access_token");
  }
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    console.warn("[warn] Google rotated the refresh token; the stored credential may be stale");
  }
  return json.access_token;
}

async function callAg({ accessToken, projectId, sessionId, longText, userText }) {
  const baseUrl = PROVIDERS.antigravity.baseUrls[0];
  const body = {
    project: projectId,
    model: "gemini-3-flash",
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      systemInstruction: { role: "system", parts: [{ text: longText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      sessionId,
    },
  };
  const res = await fetch(`${baseUrl}/v1internal:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": ANTIGRAVITY_HEADERS["User-Agent"],
      [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value,
      "X-Machine-Session-Id": sessionId,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* keep status-only result */
  }
  const usage = json?.response?.usageMetadata || json?.usageMetadata || {};
  return {
    status: res.status,
    promptTokens: usage.promptTokenCount || 0,
    cachedTokens: usage.cachedContentTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    raw: json,
  };
}

describe.skipIf(!RUN_REAL)("Antigravity cache behavior (real API)", () => {
  let conns = [];

  // Loaded in beforeAll (not at collection time) so a skipped suite never
  // touches the DB layer. Skipped when the DB is missing/unavailable so a
  // gated run never bootstraps the real data dir as a side effect; DB errors
  // are stored and reported per-test as skips rather than file failures.
  let loadError = null;
  beforeAll(async () => {
    try {
      // Avoid getAdapter() creating an empty DB when none exists: resolve the
      // data dir without getDataDir()'s mkdir side effect.
      const dataDir = process.env.DATA_DIR || dataDirResolver.defaultDataDir();
      const dbSqlite = path.join(dataDir, "db", "data.sqlite");
      if (!fs.existsSync(dbSqlite)) return;
      const { getProviderConnections } = await import("../../../src/lib/localDb.js");
      conns = (await getProviderConnections({ provider: "antigravity", isActive: true })).filter(
        (c) => c.refreshToken && c.projectId,
      );
    } catch (e) {
      loadError = e;
      return;
    }
    if (conns.length > 0) {
      // Fail fast with a clear message naming the missing env vars.
      assertOAuthClient(PROVIDERS.antigravity, "antigravity");
    }
  });

  const noConn = (ctx) =>
    ctx.skip(
      loadError
        ? `Antigravity credential DB unavailable: ${loadError.message}`
        : "No active Antigravity connection with refreshToken and projectId",
    );

  it("same sessionId → cache hit on repeated call", async (ctx) => {
    if (conns.length === 0) return noConn(ctx);
    const [acc] = conns;
    const token = await refreshAccessToken(acc.refreshToken);
    const sessionId = `test-same-${crypto.randomUUID()}`;

    const r1 = await callAg({
      accessToken: token,
      projectId: acc.projectId,
      sessionId,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });
    const r2 = await callAg({
      accessToken: token,
      projectId: acc.projectId,
      sessionId,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });

    console.log(
      `[same-session ${acc.email}] r1: prompt=${r1.promptTokens} cached=${r1.cachedTokens} | r2: prompt=${r2.promptTokens} cached=${r2.cachedTokens}`,
    );

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.cachedTokens).toBeGreaterThanOrEqual(MIN_CACHE_TOKENS);
  }, 60000);

  it("different sessionId (same account) → cache still hits (session-independent)", async (ctx) => {
    if (conns.length === 0) return noConn(ctx);
    const [acc] = conns;
    const token = await refreshAccessToken(acc.refreshToken);

    const r1 = await callAg({
      accessToken: token,
      projectId: acc.projectId,
      sessionId: `test-diff-a-${crypto.randomUUID()}`,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });
    const r2 = await callAg({
      accessToken: token,
      projectId: acc.projectId,
      sessionId: `test-diff-b-${crypto.randomUUID()}`,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });

    console.log(
      `[diff-session ${acc.email}] r1: cached=${r1.cachedTokens} | r2: cached=${r2.cachedTokens}`,
    );

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // AG cache is content-based, not session-based → both calls hit
    expect(r2.cachedTokens).toBeGreaterThanOrEqual(MIN_CACHE_TOKENS);
  }, 60000);

  it("cross-account → cache SHARED (content-based global cache)", async (ctx) => {
    if (conns.length === 0) return noConn(ctx);
    if (conns.length < 2) return ctx.skip("Requires two active Antigravity connections");
    const [accA, accB] = conns;
    const [tokenA, tokenB] = await Promise.all([
      refreshAccessToken(accA.refreshToken),
      refreshAccessToken(accB.refreshToken),
    ]);

    // Account A warmup with its own sessionId
    const a1 = await callAg({
      accessToken: tokenA,
      projectId: accA.projectId,
      sessionId: `cross-a-${crypto.randomUUID()}`,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });
    // Account B with DIFFERENT sessionId → if cache shares across accounts, it still hits
    const b1 = await callAg({
      accessToken: tokenB,
      projectId: accB.projectId,
      sessionId: `cross-b-${crypto.randomUUID()}`,
      longText: LONG_TEXT,
      userText: "Reply with OK only.",
    });

    console.log(
      `[cross-account] A cached=${a1.cachedTokens} | B cached=${b1.cachedTokens} (${accA.email} → ${accB.email})`,
    );

    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);
    // Cache is shared globally across accounts (content-based)
    expect(b1.cachedTokens).toBeGreaterThanOrEqual(MIN_CACHE_TOKENS);
  }, 90000);

  // ─── Codex-style sessionId comparison ────────────────────────────────
  // Codex derives sessionId from hash(conversation history), keeping it
  // stable per-conversation. Test whether this strategy improves cache
  // hit rate vs random sessionId on AG with a fresh unique prompt.
  it("codex-style sessionId vs random sessionId on unique prompt", async (ctx) => {
    if (conns.length === 0) return noConn(ctx);
    const [acc] = conns;
    const token = await refreshAccessToken(acc.refreshToken);

    // Build a unique conversation so no pre-existing cache can interfere
    const uniqueMarker = crypto.randomUUID();
    const uniqueLong = `MARKER-${uniqueMarker}. ${LONG_TEXT}`;
    const userText = "Reply with OK only.";

    // Codex-style: sess_${sha256(systemInstruction + userContent).slice(0,32)}
    const hash = crypto
      .createHash("sha256")
      .update(uniqueLong + "\n" + userText)
      .digest("hex")
      .slice(0, 32);
    const codexStyleSessionId = `sess_${hash}`;

    const N = 4;
    const randomResults = [];
    const codexResults = [];

    // Strategy A: random sessionId each call
    for (let i = 0; i < N; i++) {
      const r = await callAg({
        accessToken: token,
        projectId: acc.projectId,
        sessionId: `rand-${crypto.randomUUID()}`,
        longText: uniqueLong,
        userText,
      });
      randomResults.push(r);
      console.log(`[random   call ${i + 1}] cached=${r.cachedTokens}`);
    }

    // Strategy B: codex-style stable sessionId (same hash for every call)
    for (let i = 0; i < N; i++) {
      const r = await callAg({
        accessToken: token,
        projectId: acc.projectId,
        sessionId: codexStyleSessionId,
        longText: uniqueLong,
        userText,
      });
      codexResults.push(r);
      console.log(`[codex    call ${i + 1}] cached=${r.cachedTokens}`);
    }

    const randomHitRate =
      randomResults.filter((r) => r.cachedTokens >= MIN_CACHE_TOKENS).length / N;
    const codexHitRate = codexResults.filter((r) => r.cachedTokens >= MIN_CACHE_TOKENS).length / N;
    console.log(`[summary] randomHitRate=${randomHitRate} codexHitRate=${codexHitRate}`);

    randomResults.forEach((r) => {
      expect(r.status).toBe(200);
    });
    codexResults.forEach((r) => {
      expect(r.status).toBe(200);
    });
    // No strict comparison — just report. AG cache is session-independent per prior tests.
  }, 180000);

  it("unique prompt (never seen) → explore when cache starts hitting", async (ctx) => {
    if (conns.length === 0) return noConn(ctx);
    const [acc] = conns;
    const token = await refreshAccessToken(acc.refreshToken);
    // Unique marker to guarantee no one has cached this exact prompt before
    const uniqueLong = `UNIQUE-${crypto.randomUUID()}. ${LONG_TEXT}`;
    const sessionId = `unique-${crypto.randomUUID()}`;

    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = await callAg({
        accessToken: token,
        projectId: acc.projectId,
        sessionId,
        longText: uniqueLong,
        userText: "Reply with OK only.",
      });
      results.push(r);
      console.log(
        `[unique-prompt call ${i + 1}] prompt=${r.promptTokens} cached=${r.cachedTokens}`,
      );
    }

    results.forEach((r) => {
      expect(r.status).toBe(200);
    });
    // Log whether any call ever hits cache — no strict assertion (exploratory)
    const anyHit = results.some((r) => r.cachedTokens >= MIN_CACHE_TOKENS);
    console.log(`[unique-prompt] any-hit=${anyHit}`);
  }, 90000);
});
