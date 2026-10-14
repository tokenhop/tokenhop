import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.includes(":loadCodeAssist")
      ? {
          cloudaicompanionProject: "project-1",
          currentTier: { name: "Pro" },
          paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
        }
      : url.includes(":retrieveUserQuotaSummary")
        ? { groups: [] }
        : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("keeps IDE provisioning separate from hub catalog/quota traffic", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of proxyAwareFetch.mock.calls) {
      if (url.includes(":loadCodeAssist")) {
        expect(options.headers["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
      } else {
        expect(options.headers["User-Agent"]).toBe("antigravity/hub/2.23.0 darwin/arm64");
        expect(options.headers["X-Client-Version"]).toBe("2.23.0");
      }
      expect(options.headers).not.toHaveProperty("x-request-source");
    }
  });
});
