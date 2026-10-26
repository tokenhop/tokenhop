import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { VertexExecutor } from "open-sse/executors/vertex.js";
import {
  canServeVertexVideo,
  parseVertexAdcJson,
  vertexProjectId,
} from "open-sse/services/tokenRefresh.js";

const mocks = vi.hoisted(() => ({
  refreshVertexToken: vi.fn(),
  refreshGoogleToken: vi.fn(),
  proxy: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshVertexToken: mocks.refreshVertexToken,
  refreshGoogleToken: mocks.refreshGoogleToken,
}));
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveConnectionProxyConfig: mocks.proxy,
}));
vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: mocks.fetch,
}));

import {
  parseVertexModels,
  parseVertexPartnerModels,
  resolveVertex,
  resolveVertexPartner,
  VERTEX_PARTNER_PUBLISHERS,
} from "@/lib/providerModels/vertexModels.js";
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
} from "@/models/index.js";
import { clearLiveModelsCache } from "@/lib/providerModels/liveResolvers.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

const sa = {
  type: "service_account",
  client_email: "catalog@example.test",
  private_key: "test-private-key",
  project_id: "test-project",
};
const adc = {
  type: "authorized_user",
  client_id: "test-client",
  client_secret: "test-secret",
  refresh_token: "test-refresh",
  quota_project_id: "test-project",
};
const connection = (extra = {}) => ({ provider: "vertex", apiKey: JSON.stringify(sa), ...extra });
const entry = (id, extra = {}, publisher = "google") => ({
  name: `publishers/${publisher}/models/${id}`,
  ...extra,
});
const list = (...entries) => ({ publisherModels: entries });
const dashboard = async (id) =>
  (
    await GET(new Request(`http://localhost/api/providers/${id}/models`), {
      params: Promise.resolve({ id }),
    })
  ).json();

beforeEach(async () => {
  vi.resetAllMocks();
  clearLiveModelsCache();
  mocks.proxy.mockResolvedValue({ source: "none" });
  mocks.refreshVertexToken.mockResolvedValue({ accessToken: "minted-token" });
  mocks.refreshGoogleToken.mockResolvedValue({ accessToken: "adc-token" });
  mocks.fetch.mockResolvedValue(Response.json(list()));
  for (const provider of ["vertex", "vertex-partner"])
    await deleteProviderConnectionsByProviderUnscoped(provider);
});

describe("Vertex publisher parsing", () => {
  it("strips resource prefixes, dedupes and preserves complete static metadata", () => {
    const staticVideo = getModelsByProviderId("vertex").find((m) => m.kind === "video");
    const models = parseVertexModels(
      list(
        entry("gemini-2.5-flash", { displayName: "upstream name" }),
        entry(staticVideo.id),
        entry("gemini-future-pro"),
        entry("veo-future-generate"),
        entry("gemini-future-pro"),
        {},
        entry("gemini-wrong", {}, "other"),
      ),
    );
    expect(models).toEqual([
      { ...getModelsByProviderId("vertex").find((m) => m.id === "gemini-2.5-flash") },
      { ...staticVideo },
      { id: "gemini-future-pro", name: "gemini-future-pro" },
      { id: "veo-future-generate", name: "veo-future-generate", kind: "video" },
    ]);
    expect(models[1]).not.toBe(staticVideo);
  });

  it("keeps supported launch stages and drops deprecated and unroutable kinds", () => {
    const kept = [
      "GA",
      "PUBLIC_PREVIEW",
      "PRIVATE_PREVIEW",
      "EXPERIMENTAL",
      "LAUNCH_STAGE_UNSPECIFIED",
    ];
    const models = parseVertexModels(
      list(
        ...kept.map((launchStage, i) => entry(`gemini-valid-${i}`, { launchStage })),
        ...["DEPRECATED", "LEGACY"].map((launchStage) => entry("gemini-old", { launchStage })),
        ...[
          "imagen-4",
          "text-embedding-005",
          "gemini-embedding-001",
          "gemini-tts",
          "gemini-live-2.5",
          "gemini-native-audio",
          "gemini-flash-image-preview",
          "gemini-image-generation",
        ].map((id) => entry(id)),
      ),
    );
    expect(models.map((m) => m.id)).toEqual(kept.map((_, i) => `gemini-valid-${i}`));
    expect(parseVertexModels({ publisherModels: "bad" })).toEqual([]);
  });

  it("keeps only partner MaaS chat ids with publisher prefixes and static names", () => {
    expect(
      parseVertexPartnerModels(
        list(
          entry("deepseek-v3.2-maas", {}, "deepseek-ai"),
          entry("deepseek-future-maas", {}, "deepseek-ai"),
          entry("deepseek-self-deploy", {}, "deepseek-ai"),
          entry("embedding-maas", {}, "deepseek-ai"),
          entry("deepseek-old-maas", { launchStage: "LEGACY" }, "deepseek-ai"),
          entry("claude-maas", {}, "anthropic"),
        ),
        "deepseek-ai",
      ),
    ).toEqual([
      { ...getModelsByProviderId("vertex-partner")[0] },
      { id: "deepseek-ai/deepseek-future-maas", name: "deepseek-ai/deepseek-future-maas" },
    ]);
  });
});

describe("Vertex catalog authentication and transport", () => {
  it.each([resolveVertex, resolveVertexPartner])(
    "gates express keys without any network or proxy lookup",
    async (resolve) => {
      const result = await resolve(connection({ apiKey: "express-key" }));
      expect(result.models).toEqual([]);
      expect(result.warning).toMatch(/API-key \(express mode\).*Service Account JSON/);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.proxy).not.toHaveBeenCalled();
      expect(mocks.refreshVertexToken).not.toHaveBeenCalled();
    },
  );

  it("mints SA auth and passes concrete connection proxy options", async () => {
    mocks.proxy.mockResolvedValue({
      source: "legacy",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      proxyPoolId: "pool",
    });
    mocks.fetch.mockResolvedValue(Response.json(list(entry("gemini-future"))));
    const result = await resolveVertex(
      connection({ providerSpecificData: { proxyPoolId: "pool" } }),
    );
    expect(result.models[0].id).toBe("gemini-future");
    expect(mocks.proxy).toHaveBeenCalledWith({ proxyPoolId: "pool" });
    const proxyOptions = expect.objectContaining({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionProxyPoolId: "pool",
    });
    expect(mocks.refreshVertexToken).toHaveBeenCalledWith(sa, undefined, proxyOptions);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=1000",
      expect.objectContaining({
        headers: { Authorization: "Bearer minted-token" },
        signal: expect.any(AbortSignal),
      }),
      proxyOptions,
    );
  });

  it("refreshes ADC via the existing Google helper", async () => {
    await resolveVertex(connection({ apiKey: JSON.stringify(adc) }));
    expect(mocks.refreshGoogleToken).toHaveBeenCalledWith(
      "test-refresh",
      "test-client",
      "test-secret",
      undefined,
      expect.any(Object),
    );
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer adc-token");
    expect(mocks.fetch.mock.calls[0][1].headers["x-goog-user-project"]).toBe("test-project");
  });

  it("accepts a pre-set access token", async () => {
    await resolveVertex(
      connection({
        apiKey: undefined,
        accessToken: "preset",
        providerSpecificData: { projectId: "test-project" },
      }),
    );
    expect(mocks.refreshVertexToken).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer preset");
  });

  it("fails closed when proxy resolution or token mint fails", async () => {
    mocks.proxy.mockResolvedValue({ source: "error" });
    expect((await resolveVertex(connection())).warning).toMatch(/proxy resolution failed/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.proxy.mockResolvedValue({ source: "none" });
    mocks.refreshVertexToken.mockResolvedValue(null);
    expect((await resolveVertex(connection())).warning).toMatch(/access token/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([resolveVertex, resolveVertexPartner])(
    "requires a project before minting or listing",
    async (resolve) => {
      for (const credentials of [
        { apiKey: undefined, accessToken: "preset" },
        { apiKey: JSON.stringify({ ...adc, quota_project_id: undefined }) },
      ]) {
        const result = await resolve(connection(credentials));
        expect(result.warning).toMatch(/project_id/);
      }
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.refreshGoogleToken).not.toHaveBeenCalled();
    },
  );

  it("omits Veo when the existing video adapter cannot authenticate the connection", async () => {
    mocks.fetch.mockImplementation(async () =>
      Response.json(list(entry("gemini-future"), entry("veo-future"))),
    );
    const adcResult = await resolveVertex(connection({ apiKey: JSON.stringify(adc) }));
    expect(adcResult.models[0].id).toBe("gemini-future");
    expect(adcResult.models.some((model) => model.kind === "video")).toBe(false);
    const tokenResult = await resolveVertex(
      connection({
        apiKey: undefined,
        accessToken: "preset",
        providerSpecificData: { projectId: "test-project" },
      }),
    );
    expect(tokenResult.models.slice(0, 2).map((m) => m.id)).toEqual([
      "gemini-future",
      "veo-future",
    ]);
  });
});

describe("shared Vertex auth helpers", () => {
  it("preserves executor ADC project precedence and endpoint shape", () => {
    const credentials = connection({
      apiKey: JSON.stringify(adc),
      providerSpecificData: { projectId: "other-project" },
    });
    expect(parseVertexAdcJson(credentials.apiKey)).toEqual(adc);
    expect(vertexProjectId(credentials)).toBe("test-project");
    expect(new VertexExecutor("vertex").buildUrl("gemini-test", false, 0, credentials)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-test:generateContent",
    );
    expect(
      new VertexExecutor("vertex-partner").buildUrl("qwen/test-maas", false, 0, credentials),
    ).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi/chat/completions",
    );
  });

  it("matches Veo auth including a top-level projectId", () => {
    expect(canServeVertexVideo(connection())).toBe(true);
    expect(canServeVertexVideo({ accessToken: "token", projectId: "project" })).toBe(true);
    expect(
      canServeVertexVideo({ accessToken: "token", providerSpecificData: { projectId: "project" } }),
    ).toBe(true);
    expect(canServeVertexVideo({ apiKey: JSON.stringify(adc) })).toBe(false);
    expect(canServeVertexVideo({ accessToken: "token" })).toBe(false);
  });
});

describe("Vertex pagination and failure handling", () => {
  it("merges two pages and encodes the token", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({ ...list(entry("gemini-one")), nextPageToken: "next +/" }),
      )
      .mockResolvedValueOnce(Response.json(list(entry("gemini-two"), entry("gemini-one"))));
    expect((await resolveVertex(connection())).models.slice(0, 2).map((m) => m.id)).toEqual([
      "gemini-one",
      "gemini-two",
    ]);
    expect(mocks.fetch.mock.calls[1][0]).toMatch(/pageToken=next%20%2B%2F$/);
    expect(
      mocks.fetch.mock.calls.every(([, init]) => !("x-goog-user-project" in init.headers)),
    ).toBe(true);
  });

  it("stops repeated tokens", async () => {
    mocks.fetch.mockImplementation(async () =>
      Response.json({ ...list(entry("gemini-one")), nextPageToken: "same" }),
    );
    const result = await resolveVertex(connection());
    expect(result.models[0].id).toBe("gemini-one");
    expect(result.warning).toMatch(/Partial Vertex AI catalog:.*repeated page token/);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("caps publishers at ten pages", async () => {
    mocks.fetch.mockImplementation(async () =>
      Response.json({
        ...list(entry("gemini-one")),
        nextPageToken: `page-${mocks.fetch.mock.calls.length}`,
      }),
    );
    const result = await resolveVertex(connection());
    expect(result.models[0].id).toBe("gemini-one");
    expect(result.warning).toMatch(/Partial Vertex AI catalog:.*page cap/);
    expect(mocks.fetch).toHaveBeenCalledTimes(10);
  });

  it("merges partner publishers despite one failing", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      const publisher = new URL(url).pathname.split("/")[3];
      return publisher === VERTEX_PARTNER_PUBLISHERS[0]
        ? new Response("unavailable", { status: 503 })
        : Response.json(
            list(entry("new-chat-maas", {}, publisher), entry("new-chat-maas", {}, publisher)),
          );
    });
    const result = await resolveVertexPartner(connection());
    expect(result.warning).toMatch(/Partial Vertex Partner catalog: deepseek-ai: HTTP 503/);
    expect(result.models.slice(0, VERTEX_PARTNER_PUBLISHERS.length - 1).map((m) => m.id)).toEqual(
      VERTEX_PARTNER_PUBLISHERS.slice(1).map((p) => `${p}/new-chat-maas`),
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(VERTEX_PARTNER_PUBLISHERS.length);
  });

  it("bounds the catalog resolution with a timeout", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const pending = resolveVertex(connection());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({
        models: [],
        warning: expect.stringContaining("request failed"),
      });
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps earlier partner pages and warns when a later page fails", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      const parsed = new URL(url);
      const publisher = parsed.pathname.split("/")[3];
      if (publisher !== "deepseek-ai") return Response.json(list());
      return parsed.searchParams.has("pageToken")
        ? new Response("down", { status: 503 })
        : Response.json({ ...list(entry("new-chat-maas", {}, publisher)), nextPageToken: "next" });
    });
    const result = await resolveVertexPartner(connection());
    expect(result.models[0].id).toBe("deepseek-ai/new-chat-maas");
    expect(result.warning).toMatch(/Partial Vertex Partner catalog:.*HTTP 503/);
  });

  it.each(["mint", "pages"])("shares one deadline across %s work", async (phase) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      if (phase === "mint")
        mocks.refreshVertexToken.mockImplementation(() => new Promise(() => {}));
      else
        mocks.fetch.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return Response.json({ ...list(entry("gemini-one")), nextPageToken: "next" });
        });
      const pending = resolveVertex(connection());
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.warning).toMatch(
        phase === "mint" ? /access token/ : /Partial Vertex AI catalog/,
      );
      if (phase === "mint") expect(mocks.fetch).not.toHaveBeenCalled();
      else {
        expect(result.models[0].id).toBe("gemini-one");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.fetch.mock.calls[0][1].signal).toBe(mocks.fetch.mock.calls[1][1].signal);
      }
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([resolveVertex, resolveVertexPartner])(
    "warns for total failure without exposing upstream secrets",
    async (resolve) => {
      mocks.fetch.mockImplementation(async () => new Response("secret-token", { status: 401 }));
      const result = await resolve(connection());
      expect(result.models).toEqual([]);
      expect(result.warning).toMatch(/401/);
      expect(result.warning).not.toContain("secret-token");
    },
  );

  it("warns for network failures and empty or unroutable catalogs", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("network secret-token"));
    expect((await resolveVertex(connection())).warning).toMatch(/request failed/);
    mocks.fetch.mockImplementation(async () => Response.json(list(entry("imagen-4"))));
    expect((await resolveVertex(connection())).warning).toMatch(/no live models/);
    expect((await resolveVertexPartner(connection())).warning).toMatch(/no live models/);
  });
});

describe("Vertex dashboard and gateway catalogs", () => {
  it.each(["vertex", "vertex-partner"])(
    "exposes %s discoveries through both consumers",
    async (provider) => {
      mocks.fetch.mockImplementation(async (url) => {
        const publisher = new URL(url).pathname.split("/")[3];
        return Response.json(
          list(
            entry(publisher === "google" ? "gemini-future" : "future-chat-maas", {}, publisher),
            ...(publisher === "google" ? [entry("veo-future")] : []),
          ),
        );
      });
      const conn = await createProviderConnectionUnscoped({
        provider,
        authType: "apikey",
        apiKey: JSON.stringify(sa),
        testStatus: "active",
      });
      const expectedId =
        provider === "vertex"
          ? "gemini-future"
          : `${VERTEX_PARTNER_PUBLISHERS[0]}/future-chat-maas`;
      const dashboardResult = await dashboard(conn.id);
      expect(dashboardResult.models.map((m) => m.id)).toContain(expectedId);
      const staticRows = getModelsByProviderId(provider);
      expect(dashboardResult.models.slice(-staticRows.length)).toEqual(staticRows);
      expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(
        `${getProviderAlias(provider)}/${expectedId}`,
      );
      const missingStatic = getModelsByProviderId(provider).find((model) => !model.kind);
      expect((await buildModelsList(["llm"])).map((model) => model.id)).toContain(
        `${getProviderAlias(provider)}/${missingStatic.id}`,
      );
      if (provider === "vertex") {
        expect((await buildModelsList(["video"])).map((m) => m.id)).toContain(
          `${getProviderAlias(provider)}/veo-future`,
        );
        expect((await buildModelsList(["llm"])).map((m) => m.id)).not.toContain(
          `${getProviderAlias(provider)}/veo-future`,
        );
      }
    },
  );

  it("does not fetch the catalog for an explicit enabledModels selection", async () => {
    await createProviderConnectionUnscoped({
      provider: "vertex",
      authType: "apikey",
      apiKey: JSON.stringify(sa),
      testStatus: "active",
      providerSpecificData: { enabledModels: ["gemini-2.5-flash"] },
    });
    expect((await buildModelsList(["llm"])).map((model) => model.id)).toContain(
      `${getProviderAlias("vertex")}/gemini-2.5-flash`,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns the express warning to the dashboard and leaves gateway static fallback intact", async () => {
    const conn = await createProviderConnectionUnscoped({
      provider: "vertex",
      authType: "apikey",
      apiKey: "express-key",
      testStatus: "active",
    });
    expect(await dashboard(conn.id)).toMatchObject({
      models: [],
      warning: expect.stringContaining("express mode"),
    });
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain(
      `${getProviderAlias("vertex")}/gemini-2.5-flash`,
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
