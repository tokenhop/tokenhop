import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    // Preserve the caller's system/developer text after the gateway identity
    // line so user instructions still reach upstream.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const userSystemTexts = [];
    for (const message of source) {
      if (!message || typeof message !== "object") continue;
      if (!["system", "developer"].includes(message.role)) continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .map((b) => (b && typeof b.text === "string" ? b.text : ""))
                .filter(Boolean)
                .join("\n")
            : "";
      if (text) userSystemTexts.push(text);
    }
    const identity = "You are CodeBuddy Code.";
    transformed.messages = [
      {
        role: "system",
        content: userSystemTexts.length ? `${identity}\n${userSystemTexts.join("\n")}` : identity,
      },
    ];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role))
        continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({
          ...message,
          content: [{ type: "text", text: message.content }],
        });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
