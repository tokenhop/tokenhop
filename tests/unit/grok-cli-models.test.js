import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
}));

import { refreshProviderCredentials } from "../../open-sse/services/oauthCredentialManager.js";
import { parseGrokCliModels, resolveGrokCliModels } from "../../open-sse/services/grokCliModels.js";
import { GROK_CLI_VERSION } from "../../open-sse/config/grokCli.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getDefaultModel } from "../../open-sse/config/providerModels.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Grok CLI live models", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes official model metadata", () => {
    expect(
      parseGrokCliModels({
        models: [
          {
            model_id: "grok-build",
            display_name: "Grok Build",
            context_window: 500000,
            max_output_tokens: 64000,
            supported_in_api: false,
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "grok-build",
        name: "Grok Build",
        contextLength: 500000,
        maxOutputTokens: 64000,
        supported_in_api: false,
      }),
    ]);
  });

  it("refreshes and retries through selected proxy", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "grok-build" }] }));
    const onCredentialsRefreshed = vi.fn();
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      strictProxy: true,
    };
    refreshProviderCredentials.mockResolvedValue({ accessToken: "new-token" });

    const result = await resolveGrokCliModels(
      {
        accessToken: "old-token",
        refreshToken: "refresh-token",
        providerSpecificData: { email: "user@example.com" },
      },
      { fetchFn, proxyOptions, onCredentialsRefreshed },
    );

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "grok-build",
        contextLength: 500000,
        maxOutputTokens: 64000,
      }),
    ]);
    expect(refreshProviderCredentials).toHaveBeenCalledWith(
      "grok-cli",
      expect.any(Object),
      expect.anything(),
      proxyOptions,
    );
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({ accessToken: "new-token" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][2]).toBe(proxyOptions);
    expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe("Bearer new-token");
    expect(fetchFn.mock.calls[1][1].headers["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
  });

  it("sends stored identity headers on discovery", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "grok-4.6" }] }));

    await resolveGrokCliModels(
      {
        accessToken: "token",
        providerSpecificData: { email: "user@example.com", userId: "uid-123" },
      },
      { fetchFn },
    );

    const headers = fetchFn.mock.calls[0][1].headers;
    expect(headers["x-email"]).toBe("user@example.com");
    expect(headers["x-userid"]).toBe("uid-123");
    expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(headers["x-grok-client-mode"]).toBe("headless");
    expect(headers["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
  });

  it("applies fallback limits only to Grok Build", () => {
    const models = parseGrokCliModels({
      models: [
        { model_id: "grok-build", display_name: "Grok Build" },
        { model_id: "grok-4.6", display_name: "Grok 4.6" },
        { model_id: "grok-4.7", display_name: "Grok 4.7" },
      ],
    });

    expect(models.find((m) => m.id === "grok-build")).toMatchObject({
      contextLength: 500000,
      maxOutputTokens: 64000,
    });
    // No fabricated limits for non-Build models without live metadata
    for (const id of ["grok-4.6", "grok-4.7"]) {
      const model = models.find((m) => m.id === id);
      expect(model.contextLength).toBeUndefined();
      expect(model.maxOutputTokens).toBeUndefined();
    }
  });

  it("preserves live limits and capabilities instead of static defaults", () => {
    const models = parseGrokCliModels({
      models: [
        { model_id: "grok-build", context_window: 400000, max_output_tokens: 32000 },
        {
          model_id: "grok-4.7",
          context_window: 200000,
          max_output_tokens: 16000,
          supported_reasoning_efforts: ["high"],
        },
      ],
    });
    expect(models[0]).toMatchObject({ contextLength: 400000, maxOutputTokens: 32000 });
    expect(models[1]).toMatchObject({
      contextLength: 200000,
      maxOutputTokens: 16000,
      supported_reasoning_efforts: ["high"],
    });
  });

  it("lists grok-4.6 as default and grok-4.7 conservatively", () => {
    expect(getDefaultModel("gcli")).toBe("grok-4.6");
    const models = PROVIDER_MODELS.gcli;
    expect(models[0]).toMatchObject({ id: "grok-4.6", contextLength: 500000 });

    const grok47 = models.find((m) => m.id === "grok-4.7");
    expect(grok47).toMatchObject({ id: "grok-4.7", name: "Grok 4.7" });
    // ponytail: 4.7 limits/effort stay unasserted until verified upstream metadata
    expect(grok47.contextLength).toBeUndefined();
    expect(grok47.maxOutputTokens).toBeUndefined();

    // Build stays a distinct, non-default model with its own limits
    expect(models.find((m) => m.id === "grok-build")).toMatchObject({
      contextLength: 500000,
      maxOutputTokens: 64000,
    });
  });
});
