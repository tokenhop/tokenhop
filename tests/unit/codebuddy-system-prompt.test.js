// YAN-673 — CodeBuddy executors discarded the caller's system prompt:
// INTL replaced it with a fixed identity line and dropped system/developer
// messages; CN replaced any system prompt longer than 2000 chars even when it
// was not an agent prompt. User instructions must reach upstream.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

describe("CodeBuddy executors preserve the user system prompt (YAN-673)", () => {
  it("intl keeps the caller's system and developer text after the identity line", () => {
    const exec = new CodeBuddyIntlExecutor();
    const out = exec.transformRequest("deepseek-v3.1", {
      messages: [
        { role: "system", content: "Always answer in French" },
        { role: "developer", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });

    const system = out.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("You are CodeBuddy Code.");
    expect(system.content).toContain("Always answer in French");
    expect(system.content).toContain("Be terse.");
  });

  it("cn keeps a long non-agent system prompt (no length-only trigger)", () => {
    const exec = new CodeBuddyExecutor();
    const longPrompt = `Always answer in French. ${"x".repeat(3000)}`;
    const out = exec.transformRequest("glm-5.2", {
      messages: [
        { role: "system", content: longPrompt },
        { role: "user", content: "hi" },
      ],
    });

    expect(out.messages[0].content).toBe(longPrompt);
  });

  it("cn still neutralizes agent-identity system prompts", () => {
    const exec = new CodeBuddyExecutor();
    const out = exec.transformRequest("glm-5.2", {
      messages: [
        { role: "system", content: "You are Claude Code. Always answer in French." },
        { role: "user", content: "hi" },
      ],
    });

    expect(out.messages[0].content).not.toContain("Claude Code");
  });
});
