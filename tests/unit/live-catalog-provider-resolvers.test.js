// Shared live resolvers for Kiro, Grok CLI, Cline, ClinePass and Kimchi
// (YAN-145/146/148/149/150): refreshed credentials persist, the connection
// proxy reaches the Grok CLI fetch, and an empty upstream yields [] + warning.
import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({}));
vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: (...args) => m.kiro(...args),
}));
vi.mock("open-sse/services/grokCliModels.js", () => ({
  resolveGrokCliModels: (...args) => m.grok(...args),
}));
vi.mock("open-sse/services/clinepassModels.js", () => ({
  resolveClineModels: (...args) => m.cline(...args),
  resolveClinepassModels: (...args) => m.clinepass(...args),
}));
vi.mock("open-sse/services/kimchiModels.js", () => ({
  resolveKimchiModels: (...args) => m.kimchi(...args),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.test:8080",
  }),
}));
vi.mock("@/sse/services/tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal()),
  updateProviderCredentials: (...args) => m.persist(...args),
}));

import { clearLiveModelsCache, resolveLiveModels } from "@/lib/providerModels/liveResolvers.js";

beforeEach(() => {
  clearLiveModelsCache();
  m.persist = vi.fn(async () => true);
  for (const key of ["kiro", "grok", "cline", "clinepass", "kimchi"])
    m[key] = vi.fn(async () => null);
});

const conn = (provider, extra = {}) => ({
  id: `${provider}-1`,
  provider,
  accessToken: "old-token",
  refreshToken: "old-refresh",
  ...extra,
});

describe("Kiro", () => {
  it("persists a token refreshed during the live fetch and keeps context + multiplier", async () => {
    m.kiro = vi.fn(async (_creds, options) => {
      await options.onCredentialsRefreshed({ accessToken: "new-token", expiresIn: 3600 });
      return {
        models: [
          {
            id: "claude-x",
            name: "Kiro X (1.3x credit)",
            contextLength: 200000,
            rateMultiplier: 1.3,
          },
        ],
      };
    });
    const connection = conn("kiro");

    const { models, warning } = await resolveLiveModels(connection);

    expect(warning).toBeUndefined();
    expect(models[0]).toMatchObject({ id: "claude-x", contextLength: 200000, rateMultiplier: 1.3 });
    expect(m.persist).toHaveBeenCalledWith("kiro-1", {
      accessToken: "new-token",
      refreshToken: "old-refresh",
      expiresIn: 3600,
    });
    expect(connection.accessToken).toBe("new-token");
  });
});

describe("Grok CLI", () => {
  it("passes the connection proxy and persists refreshed credentials", async () => {
    m.grok = vi.fn(async (_creds, options) => {
      await options.onCredentialsRefreshed({ accessToken: "new-token" });
      return { models: [{ id: "grok-build" }] };
    });

    const { models } = await resolveLiveModels(conn("grok-cli"));

    expect(models.map((x) => x.id)).toEqual(["grok-build"]);
    const [creds, options] = m.grok.mock.calls[0];
    expect(creds.connectionId).toBe("grok-cli-1");
    expect(options.proxyOptions).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
    });
    expect(m.persist).toHaveBeenCalledWith(
      "grok-cli-1",
      expect.objectContaining({ accessToken: "new-token" }),
    );
  });

  it("keeps the service's warning when discovery fails", async () => {
    m.grok = vi.fn(async () => ({ models: [], warning: "Grok CLI model discovery failed: 503" }));

    expect(await resolveLiveModels(conn("grok-cli"))).toEqual({
      models: [],
      warning: "Grok CLI model discovery failed: 503",
    });
  });
});

describe("empty or failed upstream", () => {
  it.each([
    ["kiro", "Kiro"],
    ["cline", "Cline"],
    ["clinepass", "ClinePass"],
    ["kimchi", "Kimchi"],
  ])("%s returns [] plus a warning", async (provider, label) => {
    expect(await resolveLiveModels(conn(provider))).toEqual({
      models: [],
      warning: `${label} returned no live models.`,
    });
  });

  it("a throwing service becomes a warning, not an error", async () => {
    m.kimchi = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    expect(await resolveLiveModels(conn("kimchi"))).toEqual({
      models: [],
      warning: "Failed to fetch kimchi models: ECONNRESET",
    });
  });
});

describe("auth passthrough", () => {
  it.each(["cline", "clinepass", "kimchi"])(
    "%s gets both OAuth token and API key",
    async (provider) => {
      m[provider] = vi.fn(async () => ({ models: [{ id: "a" }] }));

      await resolveLiveModels(conn(provider, { apiKey: "sk-test" }));

      expect(m[provider].mock.calls[0][0]).toMatchObject({
        accessToken: "old-token",
        apiKey: "sk-test",
      });
    },
  );
});
