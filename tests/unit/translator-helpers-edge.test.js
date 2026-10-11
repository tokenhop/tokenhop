// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("Haiku 5.5 on anthropic: enabled+budget → adaptive with derived effort", () => {
    const out = normalizeClaudePassthrough(
      { thinking: { type: "enabled", budget_tokens: 10000, display: "summarized" } },
      "claude-haiku-5-5",
      "anthropic",
    );
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("Haiku 5.5: enabled without budget → adaptive, effort left unset", () => {
    const out = normalizeClaudePassthrough(
      { thinking: { type: "enabled" } },
      "claude-haiku-5-5",
      "claude",
    );
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toBeUndefined();
  });

  it("Haiku 5.5: adaptive + effort kept (xhigh too), tool_choice and other output_config intact", () => {
    const toolChoice = { type: "tool", name: "x" };
    for (const effort of ["high", "xhigh", "max"]) {
      const out = normalizeClaudePassthrough(
        {
          thinking: { type: "adaptive" },
          output_config: { effort, format: { type: "json_schema" } },
          tool_choice: toolChoice,
        },
        "anthropic/claude-haiku-5-5",
        "anthropic",
      );
      expect(out.thinking).toEqual({ type: "adaptive" });
      expect(out.output_config).toEqual({ effort, format: { type: "json_schema" } });
      expect(out.tool_choice).toBe(toolChoice);
    }
    const any = normalizeClaudePassthrough(
      { thinking: { type: "enabled", budget_tokens: 2000 }, tool_choice: { type: "any" } },
      "claude-haiku-5-5",
      "anthropic",
    );
    expect(any.tool_choice).toEqual({ type: "any" });
    expect(any.thinking.type).toBe("adaptive");
  });

  it("Haiku 5.5: disabled is forwarded untouched", () => {
    const out = normalizeClaudePassthrough(
      { thinking: { type: "disabled" }, output_config: { effort: "max" } },
      "claude-haiku-5-5",
      "anthropic",
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.output_config).toEqual({ effort: "max" });
  });

  it("does not mutate the original nested objects (shared with combo request)", () => {
    const outputConfig = { effort: "high", format: { type: "json_schema" } };
    const thinking = { type: "adaptive" };
    const original = { thinking, output_config: outputConfig };
    normalizeClaudePassthrough({ ...original }, "claude-haiku-4-5", "anthropic");
    expect(outputConfig).toEqual({ effort: "high", format: { type: "json_schema" } });
    expect(thinking).toEqual({ type: "adaptive" });

    const enabled = { type: "enabled", budget_tokens: 10000 };
    normalizeClaudePassthrough({ thinking: enabled }, "claude-haiku-5-5", "anthropic");
    expect(enabled).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("Haiku 4.5 on anthropic is still downgraded; effort stripped, other fields kept", () => {
    const out = normalizeClaudePassthrough(
      { thinking: { type: "adaptive" }, output_config: { effort: "high", format: { a: 1 } } },
      "claude-haiku-4-5-20251001",
      "anthropic",
    );
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toEqual({ format: { a: 1 } });
  });

  it("Sonnet 5.5 on claude: enabled → adaptive; third-party provider unchanged", () => {
    const body = () => ({ thinking: { type: "enabled", budget_tokens: 10000 } });
    expect(normalizeClaudePassthrough(body(), "claude-sonnet-5-5", "claude").thinking).toEqual({
      type: "adaptive",
    });
    expect(
      normalizeClaudePassthrough(body(), "claude-sonnet-5-5", "anthropic-compatible-x").thinking,
    ).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("Opus/Sonnet 4.6 keep enabled+budget natively (they accept it)", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4.6",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
    ]) {
      const body = { thinking: { type: "enabled", budget_tokens: 10000 } };
      const out = normalizeClaudePassthrough(body, model, "anthropic");
      expect(out.thinking, model).toEqual({ type: "enabled", budget_tokens: 10000 });
      expect(out.output_config, model).toBeUndefined();
    }
  });

  it("verified enabled-rejecting exact ids convert on official providers only", () => {
    for (const model of [
      "claude-haiku-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-opus-4-7",
      "claude-opus-4.8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "anthropic/claude-opus-5-5",
    ]) {
      for (const provider of ["claude", "anthropic"]) {
        const out = normalizeClaudePassthrough(
          { thinking: { type: "enabled", budget_tokens: 10000 } },
          model,
          provider,
        );
        expect(out.thinking.type, `${provider}/${model}`).toBe("adaptive");
      }
      const third = normalizeClaudePassthrough(
        { thinking: { type: "enabled", budget_tokens: 10000 } },
        model,
        "anthropic-compatible-x",
      );
      expect(third.thinking.type, `third/${model}`).toBe("enabled");
    }
  });

  it("unknown/undated Claude models are left untouched", () => {
    for (const model of ["claude-unknown-9", "claude-haiku-5-5-20260101", "claude-opus-5-9"]) {
      const out = normalizeClaudePassthrough(
        { thinking: { type: "enabled", budget_tokens: 10000 } },
        model,
        "anthropic",
      );
      expect(out.thinking, model).toEqual({ type: "enabled", budget_tokens: 10000 });
    }
  });

  it("Haiku 5.5 on a third-party provider keeps the legacy haiku downgrade", () => {
    const out = normalizeClaudePassthrough(
      { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
      "claude-haiku-5-5",
      "anthropic-compatible-x",
    );
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });

  it("folds mid-conversation system messages into the adjacent user turn in place", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "be brief" },
      ],
    });
    // Fold-in-place (not hoist into body.system): hoisting volatile mid-conversation
    // system content ahead of the whole conversation would invalidate the prefix cache.
    expect(out.system).toBeUndefined();
    expect(out.messages.every((m) => m.role !== "system")).toBe(true);
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "be brief" },
        ],
      },
    ]);
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({
      mimeType: "image/png",
      base64: "AAAB",
    });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });
});
