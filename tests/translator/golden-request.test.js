// P0 GOLDEN: lock OUTPUT của translateRequest (body) cho các đích đặc biệt.
// openai → claude/gemini/kiro: thinking, tools, image, system, tool_result.
// Sau refactor chạy lại phải khớp y hệt.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Body openai mẫu phủ nhiều concern (text, image, tool, tool_result, system, thinking).
function baseBody() {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,IMGDATA", detail: "high" },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    temperature: 0.7,
  };
}

// Khử field động: toolNameMap, kiro conversationId (uuid), timestamp trong content.
function clean(body) {
  const s = JSON.stringify(body, (k, v) => {
    if (k === "_toolNameMap" || k === "conversationId") return undefined;
    return v;
  }).replace(/Current time is [^"\\]+/g, "Current time is <TS>");
  return JSON.parse(s);
}

describe("GOLDEN request: OpenAI → Claude", () => {
  it("full body (system/image/tool/tool_result)", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "claude-opus-4-6",
      baseBody(),
      true,
      { apiKey: "sk-x" },
      "claude",
    );
    expect(clean(out)).toMatchSnapshot();
  });

  it("reasoning_effort → adaptive output_config (claude 4.6+)", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "claude-opus-4-6",
      body,
      true,
      { apiKey: "sk-x" },
      "anthropic",
    );
    expect(clean(out)).toMatchSnapshot();
  });
});

describe("GOLDEN request: OpenAI → Gemini", () => {
  it("full body (system/image/tool/tool_result)", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI,
      "gemini-3-pro",
      baseBody(),
      true,
      { apiKey: "k" },
      "gemini",
    );
    expect(clean(out)).toMatchSnapshot();
  });

  it("Gemini CLI tool requests include validated toolConfig and enough output for high thinking", () => {
    const body = {
      messages: [{ role: "user", content: "Call add with 7 and 35." }],
      tools: [
        {
          type: "function",
          function: {
            name: "add",
            description: "Add two numbers",
            parameters: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        },
      ],
      reasoning_effort: "high",
      max_tokens: 128,
    };
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.GEMINI_CLI,
      "gemini-3.1-pro-preview",
      body,
      true,
      { accessToken: "t", projectId: "p" },
      "gemini-cli",
    );

    expect(out.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(out.request.safetySettings).toBeDefined();
    expect(out.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
    expect(out.request.generationConfig.maxOutputTokens).toBe(65535);
  });
});

describe("GOLDEN request: OpenAI → Kiro", () => {
  it("full body (image base64 + tool_result)", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.KIRO,
      "claude-sonnet-4.5",
      baseBody(),
      true,
      { accessToken: "t" },
      "kiro",
    );
    expect(clean(out)).toMatchSnapshot();
  });
});

describe("GOLDEN request: Completions → OpenAI / Claude / Gemini", () => {
  const completionsBody = () => ({
    model: "m",
    prompt: "<|fim_prefix|>function add(a, b) {\n  return <|fim_suffix|>;\n}<|fim_middle|>",
    max_tokens: 32,
    stop: ["\n\n"],
  });
  const targets = [
    ["openai", FORMATS.OPENAI, "gpt-4o", "openai"],
    ["claude", FORMATS.CLAUDE, "claude-sonnet-4-5", "claude"],
    ["gemini", FORMATS.GEMINI, "gemini-3-pro", "gemini"],
  ];
  for (const [name, format, model, provider] of targets) {
    it(`→ ${name}`, () => {
      const out = translateRequest(
        FORMATS.OPENAI_COMPLETIONS,
        format,
        model,
        completionsBody(),
        false,
        { apiKey: "k" },
        provider,
      );
      expect(clean(out)).toMatchSnapshot();
    });
  }

  it("invalid prompt throws", () => {
    for (const prompt of [undefined, 5, ["a", "b"], [["a"]]]) {
      expect(() =>
        translateRequest(FORMATS.OPENAI_COMPLETIONS, FORMATS.OPENAI, "gpt-4o", { prompt }, false),
      ).toThrow(/prompt/);
    }
  });

  it("stop: FIM tokens dropped, then capped to 4", () => {
    const fimStops = [
      "<|fim_prefix|>",
      "<|fim_suffix|>",
      "<|fim_middle|>",
      "<|file_separator|>",
      "<|endoftext|>",
      "<|fim_pad|>",
      "<fim_prefix>",
      "<fim_suffix>",
      "<fim_middle>",
      "<PRE>",
      "<SUF>",
      "<MID>",
      "<EOT>",
      "</s>",
    ];
    const out = translateRequest(
      FORMATS.OPENAI_COMPLETIONS,
      FORMATS.OPENAI,
      "gpt-4o",
      { prompt: "x", stop: [...fimStops, "\n\n"] },
      false,
    );
    expect(out.stop).toEqual(["\n\n"]);
  });

  const toOpenAI = (src, body) =>
    translateRequest(src, FORMATS.OPENAI, "gpt-4o", body, false, { apiKey: "k" }, "openai");

  it("max_tokens: default 128 when absent, client value respected", () => {
    expect(toOpenAI(FORMATS.OPENAI_COMPLETIONS, { prompt: "x" }).max_tokens).toBe(128);
    expect(toOpenAI(FORMATS.OPENAI_COMPLETIONS, { prompt: "x", max_tokens: 7 }).max_tokens).toBe(7);
  });

  it("max_completion_tokens reaches every target, no 128 default", () => {
    const body = { prompt: "x", max_completion_tokens: 50 };
    const oa = toOpenAI(FORMATS.OPENAI_COMPLETIONS, body);
    expect(oa.max_completion_tokens).toBe(50);
    expect(oa.max_tokens).toBeUndefined();
    const claude = translateRequest(
      FORMATS.OPENAI_COMPLETIONS,
      FORMATS.CLAUDE,
      "claude-sonnet-4-5",
      body,
      false,
      { apiKey: "k" },
      "claude",
    );
    expect(claude.max_tokens).toBe(50);
    const gemini = translateRequest(
      FORMATS.OPENAI_COMPLETIONS,
      FORMATS.GEMINI,
      "gemini-3-pro",
      body,
      false,
      { apiKey: "k" },
      "gemini",
    );
    expect(gemini.generationConfig.maxOutputTokens).toBe(50);
  });

  it("oversized prefix keeps tail, oversized suffix keeps head", () => {
    const prefixOut = toOpenAI(FORMATS.OPENAI_COMPLETIONS, {
      prompt: `HEAD${"x".repeat(30_000)}TAIL`,
      suffix: "s",
    }).messages[1].content;
    expect(prefixOut).not.toContain("HEAD");
    expect(prefixOut).toContain("TAIL<|cursor|>s</code>");
    expect(prefixOut.match(/x/g)).toHaveLength(24_000 - 4);

    const suffixOut = toOpenAI(FORMATS.OPENAI_COMPLETIONS, {
      prompt: "p",
      suffix: `HEAD${"y".repeat(10_000)}TAIL`,
    }).messages[1].content;
    expect(suffixOut).toContain("p<|cursor|>HEAD");
    expect(suffixOut).not.toContain("TAIL");
    expect(suffixOut.match(/y/g)).toHaveLength(8_000 - 4);
  });

  it("llamacpp n_predict wins over the 128 default", () => {
    const body = { input_prefix: "a", input_suffix: "b", n_predict: 10 };
    expect(toOpenAI(FORMATS.LLAMACPP_INFILL, body).max_tokens).toBe(10);
    expect(toOpenAI(FORMATS.LLAMACPP_INFILL, { ...body, n_predict: undefined }).max_tokens).toBe(
      128,
    );
  });
});
