// Probes (endpoint /api/combos/probe) never persist usage/cost, but remain
// visible in request detail rows. Normal traffic is unaffected (regression).
import { describe, expect, it, vi } from "vitest";

describe("probe usage exclusion (YAN-299)", () => {
  it("skips saveRequestUsage for the probe endpoint only", async () => {
    vi.resetModules();
    const calls = [];
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestUsage: async (entry) => calls.push(entry),
      appendRequestLog: async () => {},
      saveRequestDetail: async () => {},
    }));
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

    saveUsageStats({
      provider: "openai",
      model: "probe-model",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/api/combos/probe",
    });
    saveUsageStats({
      provider: "openai",
      model: "real-model",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("real-model");
  });
});
