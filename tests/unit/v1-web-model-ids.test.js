// YAN-56 / YAN-57 / YAN-59: ids and metadata advertised by /v1/models must be
// usable as-is by the endpoints they point at.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleSearchCore: vi.fn(),
  handleFetchCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getCombos: vi.fn(async () => []),
}));

vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.handleSearchCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.handleFetchCore }));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: vi.fn(async () => {}),
}));

import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";

const post = (path, body) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("web model ids from /v1/models/web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "tvly-test",
      connectionId: "tavily-conn",
      connectionName: "Tavily",
    });
    const ok = { success: true, response: Response.json({ ok: true }) };
    mocks.handleSearchCore.mockResolvedValue(ok);
    mocks.handleFetchCore.mockResolvedValue({ success: true, data: { content: { text: "ok" } } });
  });

  it("/v1/search accepts {alias}/search", async () => {
    const res = await handleSearch(post("/v1/search", { model: "tavily/search", query: "hi" }));

    expect(res.status).toBe(200);
    expect(mocks.handleSearchCore.mock.calls[0][0].body.provider).toBe("tavily");
  });

  it("/v1/web/fetch accepts {alias}/fetch", async () => {
    const res = await handleFetch(
      post("/v1/web/fetch", { model: "tavily/fetch", url: "https://example.com" }),
    );

    expect(res.status).toBe(200);
    expect(mocks.handleFetchCore).toHaveBeenCalledOnce();
    expect(mocks.getProviderCredentials.mock.calls[0][0]).toBe("tavily");
  });

  it("/v1/search still rejects a fetch id", async () => {
    const res = await handleSearch(post("/v1/search", { model: "tavily/fetch", query: "hi" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Unknown provider: tavily/fetch");
  });
});

describe("/v1/models entries", () => {
  it("carry the OpenAI `created` field", async () => {
    const models = await buildModelsList(["llm"]);

    expect(models.length).toBeGreaterThan(0);
    const created = new Set(models.map((m) => m.created));
    expect(created.size).toBe(1);
    expect(Number.isInteger([...created][0])).toBe(true);
  });
});

describe("/v1/models/info", () => {
  it("points webFetch models at /v1/web/fetch", async () => {
    const res = await getModelInfo(new Request("http://localhost/v1/models/info?id=tavily/fetch"));

    expect(res.status).toBe(200);
    expect((await res.json()).endpoint).toBe("/v1/web/fetch");
  });
});
