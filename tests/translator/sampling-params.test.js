// YAN-44: max_completion_tokens, stop, top_p and temperature:0 survive format translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

const T = (src, tgt, body, provider = null) =>
  translateRequest(src, tgt, "m", body, false, null, provider);
const user = [{ role: "user", content: "hi" }];

describe("sampling params across formats", () => {
  it("OpenAI → Claude keeps max_completion_tokens, stop and top_p", () => {
    const out = T(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      { messages: user, max_completion_tokens: 50, stop: "###", top_p: 0.5 },
      "anthropic-compatible-x",
    );
    expect(out.max_tokens).toBe(50);
    expect(out.stop_sequences).toEqual(["###"]);
    expect(out.top_p).toBe(0.5);
  });

  it("OpenAI → Gemini maps max_completion_tokens and stop", () => {
    const out = T(FORMATS.OPENAI, FORMATS.GEMINI, {
      messages: user,
      max_completion_tokens: 50,
      stop: ["a", "b"],
    });
    expect(out.generationConfig.maxOutputTokens).toBe(50);
    expect(out.generationConfig.stopSequences).toEqual(["a", "b"]);
  });

  it("Claude → OpenAI keeps stop_sequences and top_p", () => {
    const out = T(FORMATS.CLAUDE, FORMATS.OPENAI, {
      max_tokens: 10,
      messages: user,
      stop_sequences: ["END"],
      top_p: 0.3,
    });
    expect(out.stop).toEqual(["END"]);
    expect(out.top_p).toBe(0.3);
  });

  it("Antigravity Claude route keeps temperature 0, but forces 1 with thinking", () => {
    const off = openaiToAntigravityRequest("claude-sonnet-4-6", { messages: user, temperature: 0 });
    expect(off.request.generationConfig.temperature).toBe(0);
    const on = openaiToAntigravityRequest("claude-sonnet-4-6", {
      messages: user,
      temperature: 0,
      reasoning_effort: "high",
    });
    expect(on.request.generationConfig.temperature).toBe(1);
    const gemini = openaiToAntigravityRequest("claude-sonnet-4-6", {
      messages: user,
      temperature: 0,
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    });
    expect(gemini.request.generationConfig.temperature).toBe(1);
  });

  it("Claude models drop top_p along with temperature", () => {
    const body = { temperature: 0.2, top_p: 0.5, max_tokens: 10 };
    stripUnsupportedParams("claude", "claude-opus-4-7", body);
    expect(body).toEqual({ max_tokens: 10 });
  });
});
