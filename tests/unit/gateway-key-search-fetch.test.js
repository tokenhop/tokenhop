import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  credentials: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
  combos: vi.fn(),
  expand: vi.fn(),
  dispatch: vi.fn(),
  raw: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/auth/gatewayAuth.js", async (original) => ({
  ...(await original()),
  resolveGatewayAuth: mocks.auth,
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: mocks.lock,
  clearAccountError: vi.fn(),
  extractApiKey: mocks.raw,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), getCombos: mocks.combos }));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.search }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.fetch }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/comboHeadroom.js", () => ({ loadComboHeadroomFn: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: async () => {} }));
vi.mock("open-sse/services/combo.js", async (original) => ({
  ...(await original()),
  getComboModelsFromData: mocks.expand,
  handleComboChat: mocks.dispatch,
}));
import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";

const principal = Object.freeze({
  via: "apiKey",
  apiKeyId: "key-a",
  workspaceId: "workspace-a",
  userId: "user-a",
  scopes: { allowedModels: ["tavily/search", "tavily/fetch"], allowedCombos: ["combo-a"] },
});
const lanes = [
  ["search", handleSearch],
  ["fetch", handleFetch],
];
function request(kind, model = `tavily/${kind}`, headers = {}) {
  return new Request(`http://localhost/v1/${kind}`, {
    method: "POST",
    headers: { authorization: "Bearer secret", ...headers },
    body: JSON.stringify({ model, query: "hello", url: "https://example.com" }),
  });
}

describe("gateway search/fetch handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ principal, legacy: false });
    mocks.combos.mockResolvedValue([]);
    mocks.expand.mockReturnValue(null);
    mocks.credentials.mockImplementation(async (_provider, _exclude, _model, options) =>
      options?.principal?.workspaceId === "workspace-a" || !options?.principal
        ? { connectionId: "connection-a", connectionName: "A", apiKey: "upstream-secret" }
        : null,
    );
    mocks.search.mockImplementation(async () => ({
      success: true,
      response: Response.json({ ok: true }),
    }));
    mocks.fetch.mockResolvedValue({ success: true, data: { ok: true } });
    mocks.lock.mockResolvedValue({ shouldFallback: true });
    mocks.raw.mockReturnValue("legacy-secret");
    mocks.dispatch.mockImplementation(async ({ body, models, handleSingleModel }) =>
      handleSingleModel(body, models[0]),
    );
  });

  it.each(lanes)(
    "%s reaches upstream with workspace credentials and no raw key",
    async (kind, handler) => {
      const response = await handler(request(kind));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.credentials).toHaveBeenCalledWith(
        "tavily",
        expect.any(Set),
        `web${kind}:tavily`,
        { principal },
      );
      const core = kind === "search" ? mocks.search : mocks.fetch;
      expect(core).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({ apiKey: "upstream-secret" }),
        }),
      );
      // Cores take only upstream connection credentials; neither gateway
      // key material nor hashed attribution is passed into them.
      expect(core.mock.calls[0][0].apiKey).toBeUndefined();
      expect(core.mock.calls[0][0].apiKeyId).toBeUndefined();
      expect(mocks.raw).not.toHaveBeenCalled();
    },
  );

  it.each(lanes)("%s foreign workspace cannot use global credentials", async (kind, handler) => {
    const foreign = Object.freeze({ ...principal, workspaceId: "foreign" });
    mocks.auth.mockResolvedValue({ principal: foreign, legacy: false });
    expect((await handler(request(kind))).status).toBe(400);
    expect(mocks.credentials.mock.calls[0][3].principal).toBe(foreign);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(lanes)(
    "%s bad bearer stays terminal alongside CLI/local carriers",
    async (kind, handler) => {
      const denied = Response.json({ error: "Invalid API key" }, { status: 401 });
      mocks.auth.mockResolvedValue(denied);
      const req = request(kind, undefined, {
        "x-9r-cli-token": "valid-cli",
        cookie: "owner-session",
      });
      expect(await handler(req)).toBe(denied);
      expect(mocks.auth).toHaveBeenCalledWith(req);
      expect(mocks.combos).not.toHaveBeenCalled();
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.raw).not.toHaveBeenCalled();
    },
  );

  it.each(lanes)("%s denies combo ID before expansion", async (kind, handler) => {
    mocks.combos.mockResolvedValue([
      { id: "forbidden", name: "combo", models: [`tavily/${kind}`] },
    ]);
    expect((await handler(request(kind, "combo"))).status).toBe(403);
    expect(mocks.expand).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it.each(lanes)(
    "%s forbidden combo leaf is terminal, not upstream fallback",
    async (kind, handler) => {
      mocks.combos.mockResolvedValue([{ id: "combo-a", name: "combo" }]);
      mocks.expand.mockReturnValue([`exa/${kind}`, `tavily/${kind}`]);
      expect((await handler(request(kind, "combo"))).status).toBe(403);
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.lock).not.toHaveBeenCalled();
    },
  );

  it.each(lanes)("%s allowed combo reaches scoped upstream", async (kind, handler) => {
    mocks.combos.mockResolvedValue([{ id: "combo-a", name: "combo" }]);
    mocks.expand.mockReturnValue([`tavily/${kind}`]);
    expect((await handler(request(kind, "combo"))).status).toBe(200);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.credentials.mock.calls[0][3].principal).toBe(principal);
  });

  it.each(lanes)("%s retries accounts only within principal workspace", async (kind, handler) => {
    const core = kind === "search" ? mocks.search : mocks.fetch;
    core.mockResolvedValueOnce({ success: false, status: 429, error: "busy" });
    expect((await handler(request(kind))).status).toBe(200);
    expect(mocks.credentials).toHaveBeenCalledTimes(2);
    for (const call of mocks.credentials.mock.calls) expect(call[3].principal).toBe(principal);
  });

  it.each(lanes)(
    "%s legacy routing keeps raw extraction and unrestricted scope",
    async (kind, handler) => {
      mocks.auth.mockResolvedValue({ principal: null, legacy: true });
      expect((await handler(request(kind))).status).toBe(200);
      expect(mocks.raw).toHaveBeenCalledTimes(1);
      expect(mocks.credentials.mock.calls[0][3].principal).toBeFalsy();
      const core = kind === "search" ? mocks.search : mocks.fetch;
      expect(core.mock.calls[0][0].apiKeyId).toBeUndefined();
    },
  );

  it("search no-auth provider still requires model permission", async () => {
    expect((await handleSearch(request("search", "searxng/search"))).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
