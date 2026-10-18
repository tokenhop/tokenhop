// YAN-1211/1213: resolveConversationKey is stable per conversation and side-effect free.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionStore,
  resolveConversationKey,
  resolveSessionId,
} from "../../open-sse/utils/sessionManager.js";

const msg = (role, content) => ({ role, content });
const turn1 = { messages: [msg("system", "S"), msg("user", "hello there")] };
const turn3 = {
  messages: [
    msg("system", "S"),
    msg("user", "hello there"),
    msg("assistant", "hi"),
    msg("user", "next question"),
  ],
};

beforeEach(() => {
  clearSessionStore();
});

describe("resolveConversationKey: client session ids", () => {
  it("x-session-id header gives a stable s: key regardless of body", () => {
    const headers = { "x-session-id": "abc" };
    const a = resolveConversationKey({ headers, body: turn1 });
    const b = resolveConversationKey({ headers, body: turn3 });
    expect(a).toMatch(/^s:[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toContain("abc");
  });

  it("Claude Code metadata.user_id _session_<uuid> gives a stable s: key", () => {
    const body = { ...turn1, metadata: { user_id: "user_x_account__session_1234-abcd-ef" } };
    const key = resolveConversationKey({ body });
    expect(key).toMatch(/^s:/);
    expect(resolveConversationKey({ body: { ...turn3, metadata: body.metadata } })).toBe(key);
  });

  it("prompt_cache_key in the body gives an s: key", () => {
    expect(resolveConversationKey({ body: { ...turn1, prompt_cache_key: "pck" } })).toMatch(/^s:/);
  });

  it("x-client-request-id alone and generic metadata.user_id alone are not used", () => {
    const base = resolveConversationKey({ body: turn1 });
    expect(base).toMatch(/^p:/);
    expect(resolveConversationKey({ headers: { "x-client-request-id": "r1" }, body: turn1 })).toBe(
      base,
    );
    expect(resolveConversationKey({ body: { ...turn1, metadata: { user_id: "someone" } } })).toBe(
      base,
    );
  });
});

describe("resolveConversationKey: prefix hash", () => {
  it("turn 1 and turn 3 of one conversation share a key", () => {
    expect(resolveConversationKey({ body: turn1 })).toBe(resolveConversationKey({ body: turn3 }));
  });

  it("a mid-conversation system message does not change the key", () => {
    const withReminder = {
      messages: [...turn3.messages.slice(0, 3), msg("system", "reminder"), turn3.messages[3]],
    };
    expect(resolveConversationKey({ body: withReminder })).toBe(
      resolveConversationKey({ body: turn1 }),
    );
  });

  it("a different first user message gives a different key", () => {
    const other = { messages: [msg("system", "S"), msg("user", "something else")] };
    expect(resolveConversationKey({ body: other })).not.toBe(
      resolveConversationKey({ body: turn1 }),
    );
  });

  it("handles Claude system + content blocks", () => {
    const body = {
      system: [{ type: "text", text: "S" }],
      messages: [msg("user", [{ type: "text", text: "hello there" }])],
    };
    expect(resolveConversationKey({ body })).toMatch(/^p:/);
  });

  it("handles Responses input / instructions", () => {
    const a = resolveConversationKey({
      body: { instructions: "S", input: [msg("user", [{ type: "input_text", text: "hi" }])] },
    });
    const b = resolveConversationKey({
      body: {
        instructions: "S",
        input: [msg("user", [{ type: "input_text", text: "hi" }]), msg("assistant", "yo")],
      },
    });
    expect(a).toMatch(/^p:/);
    expect(a).toBe(b);
    expect(resolveConversationKey({ body: { input: "plain string" } })).toMatch(/^p:/);
  });

  it("handles Gemini contents / systemInstruction", () => {
    const body = {
      systemInstruction: { parts: [{ text: "S" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };
    const later = {
      ...body,
      contents: [...body.contents, { role: "model", parts: [{ text: "yo" }] }],
    };
    const key = resolveConversationKey({ body });
    expect(key).toMatch(/^p:/);
    expect(resolveConversationKey({ body: later })).toBe(key);
  });
});

describe("resolveConversationKey: no user text", () => {
  it("returns null when only system text exists and the first user text is empty", () => {
    const a = {
      instructions: "same instructions",
      input: [{ type: "function_call_output", call_id: "1", output: "x" }],
    };
    const b = {
      instructions: "same instructions",
      input: [{ type: "function_call_output", call_id: "2", output: "y" }],
    };
    expect(resolveConversationKey({ body: a })).toBeNull();
    expect(resolveConversationKey({ body: b })).toBeNull();
    const imageOnly = {
      messages: [msg("system", "S"), msg("user", [{ type: "image_url", image_url: {} }])],
    };
    expect(resolveConversationKey({ body: imageOnly })).toBeNull();
  });
});

describe("resolveConversationKey: purity", () => {
  it("returns null for empty input", () => {
    expect(resolveConversationKey()).toBeNull();
    expect(resolveConversationKey({ body: {} })).toBeNull();
    expect(resolveConversationKey({ headers: {}, body: { messages: [] } })).toBeNull();
  });

  it("makes no session store writes", () => {
    const unrelated = { messages: [msg("assistant", "y".repeat(80))] };
    const before = resolveSessionId({ body: unrelated, connectionId: "c1", scope: "codex" });
    for (let i = 0; i < 10000; i++) {
      resolveConversationKey({
        body: { messages: [msg("user", `u${i}`), msg("assistant", "z".repeat(80))] },
      });
    }
    expect(resolveSessionId({ body: unrelated, connectionId: "c1", scope: "codex" })).toBe(before);
  });
});
