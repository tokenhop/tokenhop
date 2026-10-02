/**
 * Unit tests for grok-web executor thinking-token routing (YAN-29)
 *
 * Upstream NDJSON token events carry result.response.isThinking. Those tokens
 * must surface as reasoning_content, separate from content, in both stream and
 * non-stream paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrokWebExecutor } from "../../open-sse/executors/grok-web.js";

const originalFetch = global.fetch;

function mockGrokNdjson(events) {
  const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  return new Response(new Blob([body]).stream(), {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

const THINKING_EVENTS = [
  {
    result: {
      response: {
        responseId: "r1",
        llmInfo: { modelHash: "hash-1" },
        token: "think one ",
        isThinking: true,
      },
    },
  },
  { result: { response: { responseId: "r1", token: "think two", isThinking: true } } },
  { result: { response: { responseId: "r1", token: "Hello", isThinking: false } } },
  { result: { response: { responseId: "r1", token: " world", isThinking: false } } },
];

describe("GrokWebExecutor thinking tokens", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => mockGrokNdjson(THINKING_EVENTS));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("streams isThinking tokens as reasoning_content, others as content", async () => {
    const exec = new GrokWebExecutor();
    const { response } = await exec.execute({
      model: "grok-4-thinking",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "sso-cookie" },
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }

    let reasoning = "";
    let content = "";
    for (const line of output.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const delta = JSON.parse(line.slice(6)).choices[0].delta;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.content) content += delta.content;
    }
    expect(reasoning).toBe("think one think two");
    expect(content).toBe("Hello world");
  });

  it("collects isThinking tokens into message.reasoning_content when not streaming", async () => {
    const exec = new GrokWebExecutor();
    const { response } = await exec.execute({
      model: "grok-4-thinking",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "sso-cookie" },
    });

    const json = await response.json();
    expect(json.choices[0].message.reasoning_content).toBe("think one think two");
    expect(json.choices[0].message.content).toBe("Hello world");
  });
});
