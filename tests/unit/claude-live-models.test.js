// GET /api/providers/[connectionId]/models for Claude connections. Subscription
// (OAuth) tokens used to be sent as `x-api-key`, which Anthropic rejects, so the
// live model list never loaded and new models had to be added by hand.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tokenMocks = vi.hoisted(() => ({
  refreshClaudeOAuthToken: vi.fn(),
  updateProviderCredentials: vi.fn(async () => true),
}));
vi.mock("@/sse/services/tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal()),
  ...tokenMocks,
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { createProviderConnectionUnscoped } from "@/models/index.js";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";

const LIVE_MODELS = {
  data: [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "claude-opus-5", display_name: "Claude Opus 5" },
  ],
  has_more: false,
};

let calls;
// Per-test override: (url, headers) => Response | undefined (undefined → LIVE_MODELS).
let respond;
beforeEach(() => {
  calls = [];
  respond = () => undefined;
  clearLiveModelsCache();
  tokenMocks.refreshClaudeOAuthToken.mockReset();
  tokenMocks.updateProviderCredentials.mockClear();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (url, init) => {
    if (!String(url).startsWith("https://api.anthropic.com/v1/models"))
      return nativeFetch(url, init);
    calls.push({ url: String(url), headers: init.headers });
    return respond(String(url), init.headers) || Response.json(LIVE_MODELS);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function getModels(connectionId) {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models`);
  return GET(req, { params: Promise.resolve({ id: connectionId }) });
}

const seedOAuth = (extra = {}) =>
  createProviderConnectionUnscoped({
    provider: "claude",
    authType: "oauth",
    accessToken: `sk-ant-oat01-${Date.now()}-${Math.random()}`,
    testStatus: "active",
    ...extra,
  });
const seedApiKey = () =>
  createProviderConnectionUnscoped({
    provider: "claude",
    authType: "apikey",
    apiKey: `sk-ant-api03-${Date.now()}-${Math.random()}`,
    testStatus: "active",
  });

describe("Claude live models", () => {
  it("lists models for an OAuth connection with a Bearer token and the OAuth beta", async () => {
    const conn = await seedOAuth();

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    expect((await res.json()).models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("limit=1000");
    expect(calls[0].headers).toMatchObject({
      Authorization: `Bearer ${conn.accessToken}`,
      "Anthropic-Beta": "oauth-2025-04-20",
    });
    expect(calls[0].headers).not.toHaveProperty("x-api-key");
  });

  it("keeps x-api-key auth for an API-key connection", async () => {
    const conn = await seedApiKey();

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    expect(calls[0].url).toContain("limit=1000");
    expect(calls[0].headers).toMatchObject({ "x-api-key": conn.apiKey });
    expect(calls[0].headers).not.toHaveProperty("Authorization");
    expect(calls[0].headers).not.toHaveProperty("Anthropic-Beta");
  });

  it("maps display_name to name", async () => {
    const conn = await seedOAuth();

    const { models } = await (await getModels(conn.id)).json();

    expect(models[0]).toMatchObject({ id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect(models[1]).toMatchObject({ id: "claude-opus-5", name: "Claude Opus 5" });
  });

  it("follows has_more / after_id pagination", async () => {
    respond = (url) => {
      if (!url.includes("after_id=")) {
        return Response.json({
          data: [{ id: "claude-a", display_name: "A" }],
          has_more: true,
          last_id: "claude-a",
        });
      }
      return Response.json({
        data: [{ id: "claude-b", display_name: "B" }],
        has_more: false,
        last_id: "claude-b",
      });
    };
    const conn = await seedApiKey();

    const { models } = await (await getModels(conn.id)).json();

    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("after_id=claude-a");
    expect(calls[1].url).toContain("limit=1000");
  });

  it("refreshes the OAuth token on 401, persists it, and retries", async () => {
    respond = (_url, headers) =>
      headers.Authorization === "Bearer fresh-token"
        ? undefined
        : new Response("expired", { status: 401 });
    tokenMocks.refreshClaudeOAuthToken.mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "fresh-refresh",
      expiresIn: 3600,
    });
    const conn = await seedOAuth({ refreshToken: "old-refresh" });

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    expect((await res.json()).models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5",
    ]);
    expect(tokenMocks.refreshClaudeOAuthToken).toHaveBeenCalledWith("old-refresh");
    expect(tokenMocks.updateProviderCredentials).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({ accessToken: "fresh-token", refreshToken: "fresh-refresh" }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].headers).toMatchObject({ Authorization: "Bearer fresh-token" });
  });

  it("returns 200 with no models and a warning when upstream fails", async () => {
    respond = () => new Response("overloaded", { status: 529 });
    const conn = await seedApiKey();

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/Failed to fetch Claude models: 529/);
  });

  it("returns 200 with a warning when the OAuth refresh cannot recover a 401", async () => {
    respond = () => new Response("revoked", { status: 401 });
    tokenMocks.refreshClaudeOAuthToken.mockResolvedValue(null);
    const conn = await seedOAuth({ refreshToken: "dead-refresh" });

    const res = await getModels(conn.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/401/);
    expect(tokenMocks.updateProviderCredentials).not.toHaveBeenCalled();
  });
});
