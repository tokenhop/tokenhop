/**
 * Session isolation for perplexity-web executor.
 *
 * Same history + different credential ids must not share backendUuid;
 * same id must reuse.
 */
import { describe, it, expect } from "vitest";
import {
  parseOpenAIMessages,
  sessionKey,
  sessionLookup,
  sessionStore,
  sessionOwnerId,
} from "../../open-sse/executors/perplexity-web.js";

const MSGS = [
  { role: "user", content: "Q1" },
  { role: "assistant", content: "A1" },
  { role: "user", content: "Q2" },
];

describe("sessionOwnerId", () => {
  it("prefers connectionId, then id, then anon", () => {
    expect(sessionOwnerId({ connectionId: "c1", id: "i1" })).toBe("c1");
    expect(sessionOwnerId({ id: "i1" })).toBe("i1");
    // ponytail: anon fallback keeps single-user reuse
    expect(sessionOwnerId({})).toBe("anon");
    expect(sessionOwnerId(undefined)).toBe("anon");
  });
});

describe("session isolation", () => {
  it("same history, different owners -> no cross lookup; same owner -> reuse", () => {
    const { history, currentMsg } = parseOpenAIMessages(MSGS);
    const ownerA = sessionOwnerId({ connectionId: "conn-a" });
    const ownerB = sessionOwnerId({ connectionId: "conn-b" });

    // Turn 1: history [Q1,A1], current Q2 -> stores under [Q1,A1,Q2,answer]
    sessionStore(history, currentMsg, "answer-a", "uuid-a", ownerA);

    // Turn 2: history now includes Q2 + answer
    const next = [
      ...history,
      { role: "user", content: currentMsg },
      { role: "assistant", content: "answer-a" },
    ];
    expect(sessionLookup(next, ownerA)).toBe("uuid-a");
    expect(sessionLookup(next, ownerB)).toBeNull();
  });

  it("sessionKey differs by owner", () => {
    const { history } = parseOpenAIMessages(MSGS);
    expect(sessionKey(history, "conn-a")).not.toBe(sessionKey(history, "conn-b"));
    expect(sessionKey(history, "conn-a")).toBe(sessionKey(history, "conn-a"));
  });
});
