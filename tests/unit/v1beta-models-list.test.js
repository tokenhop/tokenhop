import { beforeEach, describe, expect, it, vi } from "vitest";

// Auth is covered by gateway-auth tests; legacy = no principal.
vi.mock("@/lib/auth/gatewayAuth.js", () => ({
  resolveGatewayAuth: async () => ({ principal: null, legacy: true }),
}));

const buildModelsList = vi.hoisted(() => vi.fn());

vi.mock("../../src/app/api/v1/models/route.js", () => ({ buildModelsList }));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");

async function listNames() {
  const body = await (await GET(new Request("http://localhost/v1beta/models"))).json();
  return body.models;
}

describe("GET /v1beta/models", () => {
  beforeEach(() => buildModelsList.mockReset());

  it("lists only routable LLM models, with bare Gemini and Gemini TTS names", async () => {
    buildModelsList.mockResolvedValue([
      {
        id: "gemini/gemini-2.5-pro",
        owned_by: "gemini",
        context_length: 1048576,
        max_completion_tokens: 65536,
      },
      { id: "cl/anthropic/claude-opus-4.7", owned_by: "cl" },
    ]);

    const models = await listNames();
    const byName = Object.fromEntries(models.map((m) => [m.name, m]));

    expect(buildModelsList).toHaveBeenCalledWith(["llm"]);
    expect(byName["models/gemini-2.5-pro"].inputTokenLimit).toBe(1048576);
    expect(byName["models/gemini/gemini-2.5-pro"].outputTokenLimit).toBe(65536);
    expect(byName["models/cl/anthropic/claude-opus-4.7"].supportedGenerationMethods).toContain(
      "streamGenerateContent",
    );
    expect(byName["models/gemini-2.5-flash-preview-tts"].supportedGenerationMethods).toEqual([
      "generateContent",
    ]);
    expect(models.some((m) => /embed/.test(m.name))).toBe(false);
  });

  it("omits Gemini TTS names when no Gemini model is routable", async () => {
    buildModelsList.mockResolvedValue([{ id: "cl/anthropic/claude-opus-4.7", owned_by: "cl" }]);

    const names = (await listNames()).map((m) => m.name);

    expect(names).toEqual(["models/cl/anthropic/claude-opus-4.7"]);
  });
});
