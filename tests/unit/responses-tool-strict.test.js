// YAN-16: Responses treats an absent function-tool `strict` as strict mode,
// which forces every optional field (OpenCode subagent sessionID:"ses_invalid").
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

const PARAMS = { type: "object", properties: { sessionID: { type: "string" } } };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

function chatTool(strict) {
  const fn = { name: "subagent", description: "d", parameters: PARAMS };
  if (strict !== undefined) fn.strict = strict;
  return { type: "function", function: fn };
}

function flatTool(strict) {
  const tool = { type: "function", name: "subagent", description: "d", parameters: PARAMS };
  if (strict !== undefined) tool.strict = strict;
  return tool;
}

describe("Chat → Responses tool strict (YAN-16)", () => {
  it.each([
    ["absent → false", undefined, false],
    ["false preserved", false, false],
    ["true preserved", true, true],
  ])("%s", (_label, strict, expected) => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.5",
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [chatTool(strict)],
      },
      true,
      {},
    );
    expect(out.tools[0].strict).toBe(expected);
  });
});

const EXECUTORS = [
  ["codex", () => new CodexExecutor(), "gpt-5.5"],
  ["opencode", () => new OpenCodeExecutor(), "muse-spark-1.2-contributor-free"],
  ["opencode-go", () => new OpenCodeGoExecutor(), "muse-spark-1.3-contributor"],
  ["grok-cli", () => new GrokCliExecutor(), "grok-4.5"],
];

describe.each(EXECUTORS)(
  "%s executor keeps function tool strict (YAN-16)",
  (_name, make, model) => {
    function normalize(tool) {
      const body = { model, input: structuredClone(INPUT), tools: [tool], stream: true };
      const out = make().transformRequest(model, body, true, { connectionId: "yan-16" });
      return out.tools.find((t) => t.name === "subagent");
    }

    it.each([
      ["flat false", flatTool(false), false],
      ["nested false", chatTool(false), false],
      ["flat true", flatTool(true), true],
      ["nested true", chatTool(true), true],
      ["nested absent → false", chatTool(undefined), false],
      ["flat wins over nested", { ...flatTool(false), function: { strict: true } }, false],
    ])("%s", (_label, tool, expected) => {
      expect(normalize(tool).strict).toBe(expected);
    });

    it("leaves strict absent on a flat tool that omitted it", () => {
      expect("strict" in normalize(flatTool(undefined))).toBe(false);
    });
  },
);

// YAN-18 (#526): Claude tool `strict` was lost crossing the Claude↔OpenAI bridge —
// Codex (Responses) got strict:true downgraded to false and openai→claude dropped
// function.strict entirely. strict:true is Anthropic-only, so translateRequest
// strips it for Claude-format gateways without the claudeToolStrict quirk.
describe("tool strict across the Claude↔OpenAI bridge (YAN-18)", () => {
  const claudeBody = (strict) => {
    const tool = { name: "subagent", description: "d", input_schema: PARAMS };
    if (strict !== undefined) tool.strict = strict;
    return { messages: [{ role: "user", content: "hi" }], tools: [tool] };
  };

  it.each([
    ["true preserved", true, true],
    ["false preserved", false, false],
  ])("claudeToOpenAIRequest: %s", (_label, strict, expected) => {
    const out = claudeToOpenAIRequest("m", claudeBody(strict), true, {});
    expect(out.tools[0].function.strict).toBe(expected);
  });

  it("claudeToOpenAIRequest: absent stays absent", () => {
    const out = claudeToOpenAIRequest("m", claudeBody(undefined), true, {});
    expect("strict" in out.tools[0].function).toBe(false);
  });

  it.each([
    ["strict:true survives to the Responses target", true, true],
    ["absent strict → false (Chat default)", undefined, false],
  ])("claude → openai-responses: %s", (_label, strict, expected) => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "m", claudeBody(strict));
    expect(out.tools[0].strict).toBe(expected);
  });

  const openaiBody = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "subagent", description: "d", parameters: PARAMS, strict: true },
      },
      { type: "function", function: { name: "loose", description: "d", parameters: PARAMS } },
    ],
  };

  it("openai → claude keeps strict:true for claudeToolStrict providers", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "m",
      openaiBody,
      true,
      null,
      "claude",
    );
    expect(out.tools.find((t) => t.name === "subagent").strict).toBe(true);
  });

  it.each(["glm", "anthropic-compatible-x", "anthropic"])(
    "openai → claude strips strict:true for %s",
    (provider) => {
      const out = translateRequest(
        FORMATS.OPENAI,
        FORMATS.CLAUDE,
        "m",
        structuredClone(openaiBody),
        true,
        null,
        provider,
      );
      for (const tool of out.tools) expect("strict" in tool).toBe(false);
    },
  );

  it("absent strict stays absent (no strict:false invented)", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "m",
      openaiBody,
      true,
      null,
      "claude",
    );
    expect("strict" in out.tools.find((t) => t.name === "loose")).toBe(false);
  });

  it("claude → claude passthrough keeps strict for any provider", () => {
    const body = {
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", input_schema: { type: "object" }, strict: true }],
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "m", body, true, null, "glm");
    expect(out.tools[0].strict).toBe(true);
  });

  // `anthropic` is left out until it sends the structured-outputs beta header.
  it("only endpoints that send the strict beta declare claudeToolStrict (registry tripwire)", () => {
    expect(PROVIDERS.claude?.quirks?.claudeToolStrict).toBe(true);
    expect(PROVIDERS.anthropic?.quirks?.claudeToolStrict).toBeUndefined();
    expect(PROVIDERS.glm?.quirks?.claudeToolStrict).toBeUndefined();
    expect(PROVIDERS.minimax?.quirks?.claudeToolStrict).toBeUndefined();
  });
});
