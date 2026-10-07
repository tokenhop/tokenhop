// YAN-370: media handlers record usage with principal attribution (IDs, never
// raw hashed keys) and the right `units` key; search/fetch hand their provider
// cost through. Table-driven; mocking follows gateway-key-modalities /
// gateway-key-search-fetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGatewayAuth: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  saveRequestUsageUnscoped: vi.fn(),
  core: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
  combos: vi.fn(),
}));
vi.mock("@/lib/auth/gatewayAuth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => "raw-client-secret",
  isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: vi.fn(async () => null),
  getComboByName: vi.fn(async () => null),
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: vi.fn(async () => null) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getCombos: vi.fn(async () => []),
  getProviderConnectionByIdUnscoped: vi.fn(async () => null),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsageUnscoped: mocks.saveRequestUsageUnscoped }));
vi.mock("@/lib/auth/gatewayResources.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getGatewayCombos: mocks.combos,
  getGatewayConnections: vi.fn(async () => []),
}));
vi.mock("@/lib/db/repos/gatewayVideoJobsRepo.js", () => ({
  requireGatewayVideoJobsSync: vi.fn(),
  recordGatewayVideoJobSync: vi.fn(),
  getGatewayVideoJobsSync: vi.fn(() => null),
}));
vi.mock("@/lib/db/apiKeyState.js", () => ({
  readApiKeyStorageState: vi.fn(() => ({ storage: "hashed" })),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("../../src/sse/services/comboHeadroom.js", () => ({ loadComboHeadroomFn: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn(),
}));
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.core }));
vi.mock("../../open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.core }));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.core,
}));
vi.mock("open-sse/handlers/videoCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleVideoProxyCore: mocks.core,
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.search }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.fetch }));

import { handleTts } from "../../src/sse/handlers/tts.js";
import { handleStt } from "../../src/sse/handlers/stt.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
import { handleVideoCreate } from "../../src/sse/handlers/videoGeneration.js";
import { handleSearch } from "../../src/sse/handlers/search.js";
import { handleFetch } from "../../src/sse/handlers/fetch.js";

const principal = Object.freeze({
  via: "apiKey",
  apiKeyId: "key-a",
  workspaceId: "workspace-a",
  userId: "user-a",
  // Unrestricted key: scope enforcement is covered by gateway-key-* tests.
  scopes: { allowedModels: [], allowedCombos: [] },
});

const jsonRequest = (path, body) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: "Bearer hashed-key" },
    body: JSON.stringify(body),
  });
function sttRequest() {
  const body = new FormData();
  body.set("model", "alias");
  body.set("file", new Blob(["audio-bytes"]), "audio.wav");
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body });
}

// [name, run, units, extra entry assertions, core payload overrides]
const cases = [
  [
    "tts",
    () => handleTts(jsonRequest("/v1/audio/speech", { model: "alias", input: "hello!" })),
    { characters: 6 },
    {},
  ],
  [
    "stt (duration)",
    () => handleStt(sttRequest()),
    { seconds: 12.5 },
    {},
    { json: { ok: true, duration: 12.5 } },
  ],
  [
    "stt (bytes fallback)",
    () => handleStt(sttRequest()),
    { bytes: 11 },
    {},
    { json: { ok: true } },
  ],
  [
    "images",
    () =>
      handleImageGeneration(
        jsonRequest("/v1/images/generations", { model: "alias", prompt: "hi" }),
      ),
    { images: 1 },
    {},
  ],
  [
    "images n=3",
    () =>
      handleImageGeneration(
        jsonRequest("/v1/images/generations", { model: "alias", prompt: "hi", n: 3 }),
      ),
    { images: 3 },
    {},
  ],
  [
    "video (create)",
    () =>
      handleVideoCreate(
        jsonRequest("/v1/videos/generations", { model: "xai/grok-video", prompt: "hi" }),
        "generations",
      ),
    { jobs: 1 },
    {},
    { json: { id: "job-1" } },
  ],
  [
    "search",
    () => handleSearch(jsonRequest("/v1/search", { model: "tavily/search", query: "hello" })),
    { queries: 3 },
    { cost: 0.0025 },
    {
      core: mocks.search,
      success: {
        success: true,
        response: Response.json({ ok: true }),
        data: { usage: { queries_used: 3, search_cost_usd: 0.0025 } },
      },
    },
  ],
  [
    "fetch",
    () =>
      handleFetch(jsonRequest("/v1/fetch", { model: "tavily/fetch", url: "https://example.com" })),
    { fetches: 1, characters: 5 },
    { cost: 0.0007 },
    {
      core: mocks.fetch,
      success: { success: true, data: { content: "hello", usage: { fetch_cost_usd: 0.0007 } } },
    },
  ],
];

describe("media handlers record usage attribution (YAN-370)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGatewayAuth.mockResolvedValue({ principal, legacy: false });
    mocks.getModelInfo.mockImplementation(async (modelStr) =>
      String(modelStr).includes("xai")
        ? { provider: "xai", model: "grok-video" }
        : { provider: "openai", model: "model" },
    );
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "connection-a",
      connectionName: "A",
      apiKey: "upstream-secret",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.saveRequestUsageUnscoped.mockResolvedValue(undefined);
    mocks.combos.mockResolvedValue([]);
    mocks.core.mockImplementation(async () => ({
      success: true,
      response: Response.json({ ok: true }),
    }));
    mocks.search.mockImplementation(async () => ({
      success: true,
      response: Response.json({ ok: true }),
      data: { usage: { queries_used: 3, search_cost_usd: 0.0025 } },
    }));
    mocks.fetch.mockResolvedValue({
      success: true,
      data: { content: "hello", usage: { fetch_cost_usd: 0.0007 } },
    });
  });

  it.each(cases)(
    "%s: one sink call with principal ids and the right units",
    async (_name, run, units, extra, opts = {}) => {
      if (opts.core) opts.core.mockImplementationOnce(async () => opts.success);
      if (opts.json)
        mocks.core.mockImplementationOnce(async () => ({
          success: true,
          response: Response.json(opts.json),
        }));
      const response = await run();
      expect(response.status).toBe(200);
      // stt records asynchronously (units parsed from the response body first).
      for (let i = 0; i < 20 && mocks.saveRequestUsageUnscoped.mock.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(mocks.saveRequestUsageUnscoped).toHaveBeenCalledTimes(1);
      expect(mocks.saveRequestUsageUnscoped).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeyId: "key-a",
          workspaceId: "workspace-a",
          userId: "user-a",
          units,
          status: "success",
          ...extra,
        }),
      );
      const entry = mocks.saveRequestUsageUnscoped.mock.calls[0][0];
      expect(entry.apiKey).toBeNull(); // no raw key on the hashed path
      expect(entry.model === null || typeof entry.model === "string").toBe(true);
    },
  );

  it("video: a failed create records nothing", async () => {
    mocks.core.mockImplementationOnce(async () => ({
      success: false,
      status: 500,
      error: "boom",
      response: Response.json({ error: "boom" }, { status: 500 }),
    }));
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    const response = await handleVideoCreate(
      jsonRequest("/v1/videos/generations", { model: "xai/grok-video", prompt: "hi" }),
      "generations",
    );
    expect(response.status).toBe(500);
    expect(mocks.saveRequestUsageUnscoped).not.toHaveBeenCalled();
  });

  it("search without provider usage defaults queries to 1 and lets pricing compute cost", async () => {
    mocks.search.mockImplementationOnce(async () => ({
      success: true,
      response: Response.json({ ok: true }),
      data: {},
    }));
    expect(
      (await handleSearch(jsonRequest("/v1/search", { model: "tavily/search", query: "q" })))
        .status,
    ).toBe(200);
    expect(mocks.saveRequestUsageUnscoped).toHaveBeenCalledWith(
      expect.objectContaining({ units: { queries: 1 }, cost: undefined }),
    );
  });
});
