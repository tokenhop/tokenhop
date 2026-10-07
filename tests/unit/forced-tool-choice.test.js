import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { normalizeForcedToolChoice } from "../../open-sse/translator/concerns/toolChoice.js";

// Break caught: Claude 5.5/5.1 and manual thinking 400 on forced tool_choice;
// Kimi K3 400 on a named function (YAN-723 / YAN-724).
const NO = { forcedToolChoice: false };
const ANY = { forcedToolChoice: "any" };
const OK = { forcedToolChoice: true };
const fn = (name) => ({ type: "function", function: { name } });
const claudeTools = () => [{ name: "a" }, { name: "b" }];
const openaiTools = () => [{ type: "function", function: { name: "a" } }, fn("b")];

describe("normalizeForcedToolChoice — forcedToolChoice:false", () => {
  it.each([
    [{ type: "any" }, { type: "auto" }],
    [{ type: "tool", name: "a" }, { type: "auto" }],
    [
      { type: "any", disable_parallel_tool_use: true },
      { type: "auto", disable_parallel_tool_use: true },
    ],
  ])("claude %j → %j", (choice, want) => {
    const body = { tool_choice: choice };
    expect(normalizeForcedToolChoice(body, FORMATS.CLAUDE, NO)).toBeTruthy();
    expect(body.tool_choice).toEqual(want);
  });

  it.each([
    ["openai required", FORMATS.OPENAI, "required"],
    ["openai named", FORMATS.OPENAI, fn("a")],
    ["responses named", FORMATS.OPENAI_RESPONSES, { type: "function", name: "a" }],
  ])("%s → auto", (_l, format, choice) => {
    const body = { tool_choice: choice };
    normalizeForcedToolChoice(body, format, NO);
    expect(body.tool_choice).toBe("auto");
  });

  it("allowed_tools: nested (openai) and top-level (responses) mode → auto", () => {
    const original = { type: "allowed_tools", allowed_tools: { mode: "required" } };
    const nested = { tool_choice: original };
    normalizeForcedToolChoice(nested, FORMATS.OPENAI, NO);
    expect(nested.tool_choice.allowed_tools.mode).toBe("auto");
    // shared with the client body reused by combo fallbacks — must stay intact
    expect(original.allowed_tools.mode).toBe("required");
    const flat = { tool_choice: { type: "allowed_tools", mode: "required", tools: [] } };
    normalizeForcedToolChoice(flat, FORMATS.OPENAI_RESPONSES, NO);
    expect(flat.tool_choice.mode).toBe("auto");
  });

  it("leaves auto / none / absent alone", () => {
    for (const c of ["auto", "none", { type: "auto" }, { type: "none" }, undefined]) {
      const body = c === undefined ? {} : { tool_choice: structuredClone(c) };
      const fmt = typeof c === "object" ? FORMATS.CLAUDE : FORMATS.OPENAI;
      expect(normalizeForcedToolChoice(body, fmt, NO)).toBeNull();
      expect(body.tool_choice).toEqual(c);
    }
  });
});

describe("normalizeForcedToolChoice — forcedToolChoice:'any'", () => {
  it("openai named → required, tools narrowed", () => {
    const body = { tool_choice: fn("a"), tools: openaiTools() };
    normalizeForcedToolChoice(body, FORMATS.OPENAI, ANY);
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toEqual([openaiTools()[0]]);
  });

  it("claude tool → any, tools narrowed, disable_parallel kept", () => {
    const body = {
      tool_choice: { type: "tool", name: "b", disable_parallel_tool_use: true },
      tools: claudeTools(),
    };
    normalizeForcedToolChoice(body, FORMATS.CLAUDE, ANY);
    expect(body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
    expect(body.tools).toEqual([{ name: "b" }]);
  });

  it("narrowing keeps tools already called in history", () => {
    const tools = [...openaiTools(), fn("c")];
    const body = {
      tool_choice: fn("a"),
      tools,
      messages: [{ role: "assistant", tool_calls: [{ function: { name: "c" } }] }],
    };
    normalizeForcedToolChoice(body, FORMATS.OPENAI, ANY);
    expect(body.tools.map((t) => t.function.name)).toEqual(["a", "c"]);
  });

  it("no matching tool → required, tools untouched", () => {
    const body = { tool_choice: fn("zzz"), tools: openaiTools() };
    normalizeForcedToolChoice(body, FORMATS.OPENAI, ANY);
    expect(body.tool_choice).toBe("required");
    expect(body.tools).toHaveLength(2);
  });

  it("keeps plain required / claude any", () => {
    const a = { tool_choice: "required" };
    expect(normalizeForcedToolChoice(a, FORMATS.OPENAI, ANY)).toBeNull();
    expect(a.tool_choice).toBe("required");
    const b = { tool_choice: { type: "any" } };
    expect(normalizeForcedToolChoice(b, FORMATS.CLAUDE, ANY)).toBeNull();
  });
});

describe("normalizeForcedToolChoice — misc", () => {
  it("manual thinking downgrades forced choice on any claude model", () => {
    const body = {
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type: "any" },
    };
    normalizeForcedToolChoice(body, FORMATS.CLAUDE, OK);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("adaptive thinking keeps forced choice", () => {
    const body = { thinking: { type: "adaptive" }, tool_choice: { type: "any" } };
    expect(normalizeForcedToolChoice(body, FORMATS.CLAUDE, OK)).toBeNull();
    expect(body.tool_choice).toEqual({ type: "any" });
  });

  it("forcedToolChoice:true is a no-op; other formats untouched", () => {
    const body = { tool_choice: fn("a") };
    expect(normalizeForcedToolChoice(body, FORMATS.OPENAI, OK)).toBeNull();
    expect(normalizeForcedToolChoice(body, FORMATS.GEMINI, NO)).toBeNull();
    expect(body.tool_choice).toEqual(fn("a"));
  });
});

describe("forcedToolChoice capabilities", () => {
  it.each([
    ["claude", "claude-opus-5-5", false],
    ["claude", "claude-opus-5-5-thinking", false],
    ["kiro", "claude-sonnet-5-5", false],
    ["claude", "claude-fable-5-1", false],
    ["claude", "claude-mythos-5-1", false],
    ["claude", "claude-opus-5", true],
    ["claude", "claude-sonnet-5", true],
    ["claude", "claude-fable-5", true],
    ["kimi", "k3", "any"],
    ["kimi", "kimi-k3", "any"],
    ["llm7", "kimi-k3", "any"],
    ["moonshot", "moonshotai/kimi-k3-free", "any"],
    ["codebuddy-cn", "kimi-k3-1", "any"],
    ["kimi", "kimi-k2.7-code", true],
  ])("%s/%s → %j", (provider, model, want) => {
    expect(getCapabilitiesForModel(provider, model).forcedToolChoice).toBe(want);
  });
});
