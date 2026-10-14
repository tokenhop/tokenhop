import { beforeEach, describe, expect, it, vi } from "vitest";

const { networkMock } = vi.hoisted(() => ({ networkMock: vi.fn() }));
// Keep model resolution, translation, executor transforms and response handling real.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: networkMock }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CASES = [
  { label: "bare default", model: "gemini-4-argon", level: "medium" },
  { label: "bare effort high", model: "gemini-4-argon", effort: "high", level: "high" },
  { label: "bare(high)", model: "gemini-4-argon(high)", level: "high" },
  { label: "tier-low default", model: "gemini-4-argon-low", level: "low" },
  { label: "tier-high effort low", model: "gemini-4-argon-high", effort: "low", level: "high" },
  { label: "tier-high(low)", model: "gemini-4-argon-high(low)", level: "high" },
  { label: "bare effort none", model: "gemini-4-argon", effort: "none", level: "low" },
  { label: "bare effort minimal", model: "gemini-4-argon", effort: "minimal", level: "low" },
  { label: "bare effort max", model: "gemini-4-argon", effort: "max", level: "high" },
  { label: "bare effort xhigh", model: "gemini-4-argon", effort: "xhigh", level: "high" },
  {
    label: "streaming bare effort high",
    model: "gemini-4-argon",
    effort: "high",
    level: "high",
    stream: true,
  },
];

describe("Gemini 4 Argon through handleChatCore", () => {
  beforeEach(() => {
    networkMock.mockReset();
    networkMock.mockImplementation(async (url) => {
      const response = {
        candidates: [
          { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
      if (url.includes(":streamGenerateContent")) {
        return new Response(`data: ${JSON.stringify({ response })}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ response });
    });
  });

  it.each(CASES)(
    "$label → $level wire tier and thinkingLevel",
    async ({ model, effort, level, stream = false }) => {
      const body = {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream,
        ...(effort ? { reasoning_effort: effort } : {}),
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "antigravity", model },
        credentials: { accessToken: "tok", projectId: "project-argon", providerSpecificData: {} },
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        connectionId: "conn-argon",
        rtkEnabled: false,
        headroomEnabled: false,
        cavemanEnabled: false,
        ponytailEnabled: false,
        pxpipeEnabled: false,
        sourceFormatOverride: "openai",
      });

      expect(result.success).toBe(true);
      await result.response.text();
      expect(networkMock).toHaveBeenCalledTimes(1);
      const [url, options] = networkMock.mock.calls[0];
      const transmitted = JSON.parse(options.body);
      expect(transmitted.model).toBe(`gemini-4-argon-${level}`);
      expect(transmitted.request.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: level,
        includeThoughts: true,
      });
      expect(options.headers["User-Agent"]).toBe("antigravity/hub/2.23.0 darwin/arm64");
      expect(url).toContain(stream ? ":streamGenerateContent" : ":generateContent");
    },
  );
});
