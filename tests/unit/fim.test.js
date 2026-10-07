import { describe, it, expect } from "vitest";
import {
  CURSOR_MARKER,
  parseFimPrompt,
  cleanFimOutput,
} from "../../open-sse/translator/concerns/fim.js";

describe("parseFimPrompt", () => {
  const cases = [
    {
      name: "qwen",
      prompt: "<|fim_prefix|>int a =<|fim_suffix|> = 1;<|fim_middle|>",
      prefix: "int a =",
      suffix: " = 1;",
    },
    {
      name: "star_coder",
      prompt: "<fim_prefix>int a =<fim_suffix> = 1;<fim_middle>",
      prefix: "int a =",
      suffix: " = 1;",
    },
    {
      name: "code_llama (exact template spaces)",
      prompt: "<PRE> int a = <SUF> = 1; <MID>",
      prefix: "int a =",
      suffix: " = 1;",
    },
    {
      name: "deepseek_coder",
      prompt: "<｜fim▁begin｜>int a =<｜fim▁hole｜> = 1;<｜fim▁end｜>",
      prefix: "int a =",
      suffix: " = 1;",
    },
    {
      name: "codestral (suffix-first)",
      prompt: "[SUFFIX] = 1;[PREFIX]int a =",
      prefix: "int a =",
      suffix: " = 1;",
    },
    {
      name: "glm",
      prompt: "<|code_prefix|>int a =<|code_suffix|> = 1;<|code_middle|>",
      prefix: "int a =",
      suffix: " = 1;",
    },
  ];
  for (const { name, prompt, prefix, suffix } of cases) {
    it(name, () => {
      expect(parseFimPrompt(prompt)).toEqual({
        prefix,
        suffix,
        format: name.split(" ")[0],
        context: "",
      });
    });
  }

  it("plain when no markers", () => {
    expect(parseFimPrompt("hello world")).toEqual({
      prefix: "hello world",
      suffix: "",
      format: "plain",
      context: "",
    });
  });

  it("real suffix arg without markers → format suffix", () => {
    expect(parseFimPrompt("int a =", " = 1;")).toEqual({
      prefix: "int a =",
      suffix: " = 1;",
      format: "suffix",
      context: "",
    });
  });

  it("text before first marker → context, stripped of file/repo tokens", () => {
    const prompt =
      "<|file_sep|>a.js <|repo_name|>myrepo\nlet x = 1;\n<|fim_prefix|>int a =<|fim_suffix|>;<|fim_middle|>";
    const out = parseFimPrompt(prompt);
    expect(out).toEqual({
      prefix: "int a =",
      suffix: ";",
      format: "qwen",
      context: "a.js myrepo\nlet x = 1;\n",
    });
  });

  it("malformed template → plain fallback", () => {
    expect(parseFimPrompt("<|fim_prefix|>oops<|fim_middle|>")).toEqual({
      prefix: "<|fim_prefix|>oops<|fim_middle|>",
      suffix: "",
      format: "plain",
      context: "",
    });
  });

  it("empty prompt → plain", () => {
    expect(parseFimPrompt("")).toEqual({ prefix: "", suffix: "", format: "plain", context: "" });
  });
});

describe("cleanFimOutput", () => {
  it("strips surrounding fence when output starts with one", () => {
    expect(cleanFimOutput("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("cuts at leaked fim token", () => {
    expect(cleanFimOutput("x = 1;<|fim_middle|>garbage")).toBe("x = 1;");
  });

  it("removes think blocks", () => {
    expect(cleanFimOutput("<think>reasoning</think>x = 1;")).toBe("x = 1;");
  });

  it("trims prefix overlap at line boundary", () => {
    expect(cleanFimOutput("int a =\nx = 1;", { prefix: "let b;\nint a =\n" })).toBe("x = 1;");
  });

  it("drops indentation the cursor already sits in, first line only (YAN-741)", () => {
    const prefix = "def add(a, b):\n    ";
    expect(cleanFimOutput("    return a + b", { prefix })).toBe("return a + b");
    expect(cleanFimOutput("        return a + b", { prefix })).toBe("    return a + b");
    expect(cleanFimOutput("    x = 1\n    return x", { prefix })).toBe("x = 1\n    return x");
    expect(cleanFimOutput("\treturn a", { prefix })).toBe("\treturn a");
    expect(cleanFimOutput("    return a", { prefix: "x = 1  " })).toBe("    return a");
    expect(cleanFimOutput("\r\nx", { prefix: "a\n\r" })).toBe("\r\nx");
  });

  it("trims suffix overlap at end", () => {
    expect(cleanFimOutput("x = 1;\nreturn x;\n", { suffix: "return x;\n" })).toBe("x = 1;\n");
  });

  it("removes cursor marker echoes", () => {
    expect(cleanFimOutput(`a${CURSOR_MARKER}b`)).toBe("ab");
  });

  it("unterminated leading think → empty", () => {
    expect(cleanFimOutput("<think>never ends")).toBe("");
  });

  it("keeps </s> in markup and never trims mid-identifier", () => {
    expect(cleanFimOutput("a</s><div>end</div>")).toBe("a</s><div>end</div>");
    expect(cleanFimOutput("ValueName = 1;", { prefix: "let longValueName" })).toBe(
      "ValueName = 1;",
    );
  });

  it("stays fast on 400KB inputs", () => {
    const big = "a".repeat(400_000);
    const t = Date.now();
    cleanFimOutput(`${big}c`, { prefix: `${big}b`, suffix: big });
    parseFimPrompt(`<|fim_prefix|>${"<|fim_suffix|>".repeat(30_000)}`);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("non-string → empty, never throws", () => {
    expect(cleanFimOutput(undefined)).toBe("");
    expect(cleanFimOutput(null)).toBe("");
  });
});

describe("openAICompletionToClientFormat → text_completion", () => {
  it("converts and cleans with cursor context", async () => {
    const { openAICompletionToClientFormat } = await import(
      "../../open-sse/handlers/chatCore/completionToClient.js"
    );
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const out = openAICompletionToClientFormat(
      {
        id: "chatcmpl-1",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            message: { content: "```\nx = 1;\nreturn x + 1;\n```" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      FORMATS.OPENAI_COMPLETIONS,
      null,
      { prefix: "", suffix: "return x + 1;\n}" },
    );
    expect(out).toEqual({
      id: "cmpl-1",
      object: "text_completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, text: "x = 1;\n", logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
});
