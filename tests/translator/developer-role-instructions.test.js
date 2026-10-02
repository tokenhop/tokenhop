// YAN-30: developer and mid-conversation system messages must stay instructions
// across Claude, Gemini, Kiro, and Cursor instead of being dropped or overwritten.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { buildAgentRunFrame } from "../../open-sse/executors/cursor.js";
import { decodeMessage } from "../../open-sse/utils/cursorProtobuf.js";

const translate = (from, to, body, model = "test-model") =>
  translateRequest(from, to, model, structuredClone(body), false);

const systemText = (claude) => claude.system.map((block) => block.text).join("\n");

const cursorUserText = (frame) => {
  const run = decodeMessage(decodeMessage(frame.subarray(5)).get(1)[0].value);
  const action = decodeMessage(run.get(2)[0].value);
  const userAction = decodeMessage(action.get(1)[0].value);
  const userMessage = decodeMessage(userAction.get(1)[0].value);
  return Buffer.from(userMessage.get(1)[0].value).toString("utf8");
};

describe("developer and system instructions", () => {
  it("OpenAI → Claude extracts developer with system in order", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.CLAUDE, {
      messages: [
        { role: "system", content: "system rule" },
        { role: "developer", content: [{ type: "text", text: "developer rule" }] },
        { role: "user", content: "hi" },
      ],
    });

    expect(systemText(out)).toContain("system rule\ndeveloper rule");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("Responses → Claude keeps instructions and developer input", () => {
    const out = translate(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, {
      instructions: "top instructions",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });

    expect(systemText(out)).toContain("top instructions\ndev");
    expect(out.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("OpenAI → Gemini accumulates every system and developer instruction", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.GEMINI, {
      messages: [
        { role: "system", content: "first" },
        { role: "developer", content: "second" },
        { role: "user", content: "hi" },
        { role: "system", content: "third" },
      ],
    });

    expect(out.systemInstruction.parts.map((part) => part.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("OpenAI → Responses joins every system and developer instruction", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, {
      messages: [
        { role: "system", content: "A" },
        { role: "developer", content: "B" },
        { role: "user", content: "hi" },
      ],
    });

    expect(out.instructions).toBe("A\nB");
    expect(out.input.map((item) => item.role)).toEqual(["user"]);
  });

  it("OpenAI → Kiro wraps developer exactly like system", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.KIRO, {
      messages: [
        { role: "developer", content: "follow dev" },
        { role: "user", content: "hi" },
      ],
    });
    const content = out.conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<instructions>\nfollow dev\n</instructions>");
    expect(content.indexOf("follow dev")).toBeLessThan(content.indexOf("hi"));
  });

  it("Claude → Kiro folds mid-conversation system in chronological order", () => {
    const out = translate(FORMATS.CLAUDE, FORMATS.KIRO, {
      messages: [
        { role: "user", content: "before" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "middle rule" },
        { role: "user", content: "after" },
      ],
    });
    const content = out.conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<instructions>\nmiddle rule\n</instructions>");
    expect(content.indexOf("middle rule")).toBeLessThan(content.indexOf("after"));
    expect(JSON.stringify(out.conversationState.history)).not.toContain("middle rule");
  });

  it("Cursor executor treats passthrough developer as preamble, not history or a turn", () => {
    const messages = [
      { role: "user", content: "old" },
      { role: "developer", content: "dev rule" },
      { role: "assistant", content: "done" },
      { role: "user", content: "now" },
    ];
    const text = cursorUserText(buildAgentRunFrame(messages, "gpt-5.2"));
    const history = text.slice(text.indexOf("<conversation_history>"));

    expect(text.startsWith("dev rule")).toBe(true);
    expect(history).not.toContain("dev rule");
    expect(history).toContain("Assistant:\ndone");
    expect(text).toMatch(/Latest message:\nnow$/);
  });
});
