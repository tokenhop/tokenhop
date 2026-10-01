import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleChatSearch, CHAT_SEARCH_CONFIG } from "open-sse/handlers/search/chatSearch.js";

// Kimi /v1/search: OAuth connections must hit the Kimi Code endpoint with
// X-Msh-* headers, and the builtin $web_search tool must complete the
// two-turn (tool_call → tool result → answer) flow.

const OAUTH_CREDS = {
  authType: "oauth",
  accessToken: "kimi-oauth-token",
  providerSpecificData: { deviceId: "device-123" },
};

const APIKEY_CREDS = {
  authType: "apikey",
  apiKey: "sk-platform-key",
};

function jsonResponse(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 401,
    json: async () => payload,
  };
}

let queue = [];

describe("kimi chat search", () => {
  const originalFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    // Records every call; per-test queue returns payloads in order (last one repeats).
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      return jsonResponse(next ?? { stub: true }, next?.ok ?? true);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("routes OAuth connections to the Kimi Code endpoint, search-native single turn", async () => {
    const nativeTurn = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "AI news answer",
          },
        },
      ],
      usage: { total_tokens: 42 },
    };
    queue = [nativeTurn];

    const result = await handleChatSearch({
      provider: "kimi",
      query: "latest AI news",
      credentials: OAUTH_CREDS,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(init.headers["X-Msh-Device-Id"]).toBe("device-123");
    expect(init.headers["X-Msh-Platform"]).toBe("9router");
    expect(init.headers.Authorization).toBe("Bearer kimi-oauth-token");
    // OAuth body: model k3, no client-injected builtin $web_search
    const reqBody = JSON.parse(init.body);
    expect(reqBody.model).toBe("k3");
    expect(reqBody.tools).toBeUndefined();
    expect(result.data.answer.text).toBe("AI news answer");
  });

  it("completes the platform two-turn $web_search loop for API-key connections", async () => {
    const firstTurn = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "$web_search",
                  arguments: JSON.stringify({ query: "latest AI news" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { total_tokens: 10 },
    };
    const secondTurn = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "AI news answer",
          },
        },
      ],
      usage: { total_tokens: 42 },
    };
    queue = [firstTurn, secondTurn];

    const result = await handleChatSearch({
      provider: "kimi",
      query: "latest AI news",
      credentials: APIKEY_CREDS,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    for (const { url, init } of calls) {
      expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(init.headers["X-Msh-Device-Id"]).toBeUndefined();
      expect(init.headers.Authorization).toBe("Bearer sk-platform-key");
    }
    // Turn 1 injects the builtin tool
    expect(JSON.parse(calls[0].init.body).tools[0].function.name).toBe("$web_search");
    // Turn 2 echoes assistant tool_calls + tool result
    const followUp = JSON.parse(calls[1].init.body);
    const roles = followUp.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    expect(followUp.messages[2].tool_call_id).toBe("call-1");
    expect(result.data.answer.text).toBe("AI news answer");
    // Tokens sum both turns (10 + 42)
    expect(result.data.usage.llm_tokens).toBe(52);
  });

  it("keeps API-key connections on the platform endpoint without X-Msh headers", async () => {
    const singleTurn = {
      choices: [{ message: { role: "assistant", content: "answer", tool_calls: [] } }],
      usage: { total_tokens: 5 },
    };
    queue = [singleTurn];

    const result = await handleChatSearch({
      provider: "kimi",
      query: "test",
      credentials: APIKEY_CREDS,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(calls[0].init.headers["X-Msh-Device-Id"]).toBeUndefined();
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-platform-key");
    // Platform model id, not the OAuth `k3`
    expect(JSON.parse(calls[0].init.body).model).toBe("kimi-k3");
  });

  it("echoes tool_call arguments as the tool result (builtin $web_search protocol)", async () => {
    const firstTurn = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-9",
                type: "function",
                function: {
                  name: "$web_search",
                  arguments: JSON.stringify({ query: "latest AI news" }),
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 8 },
    };
    const secondTurn = {
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: { total_tokens: 9 },
    };
    queue = [firstTurn, secondTurn];

    await handleChatSearch({
      provider: "kimi",
      query: "latest AI news",
      credentials: APIKEY_CREDS,
    });

    const followUp = JSON.parse(calls[1].init.body);
    const toolMsg = followUp.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMsg.content)).toEqual({ query: "latest AI news" });
  });

  it("returns single turn when text and inline citations are already present", async () => {
    const inlineTurn = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Here is what I found.",
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "$web_search",
                  arguments: JSON.stringify({
                    search_results: [
                      { url: "https://example.com/ai", title: "AI News", snippet: "Big AI news" },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 12 },
    };
    queue = [inlineTurn];

    const result = await handleChatSearch({
      provider: "kimi",
      query: "latest AI news",
      credentials: APIKEY_CREDS,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.data.results[0].url).toBe("https://example.com/ai");
    expect(result.data.results[0].title).toBe("AI News");
    expect(result.data.answer.text).toBe("Here is what I found.");
    expect(result.data.usage.llm_tokens).toBe(12);
  });

  it("returns single-turn result untouched when no tool_calls are present", async () => {
    const plain = {
      choices: [{ message: { role: "assistant", content: "just text" } }],
      usage: { total_tokens: 3 },
    };
    queue = [plain];

    const result = await handleChatSearch({
      provider: "kimi",
      query: "hello",
      credentials: OAUTH_CREDS,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.data.answer.text).toBe("just text");
  });
});

describe("CHAT_SEARCH_CONFIG kimi", () => {
  it("keeps provider_config contract (endpoint/model/extraHeaders)", () => {
    const cfg = CHAT_SEARCH_CONFIG.kimi;
    expect(cfg.endpoint("kimi-k3", OAUTH_CREDS)).toBe(
      "https://api.kimi.com/coding/v1/chat/completions",
    );
    expect(cfg.endpoint("kimi-k3", APIKEY_CREDS)).toBe(
      "https://api.moonshot.cn/v1/chat/completions",
    );
    expect(cfg.model("kimi-k3", OAUTH_CREDS)).toBe("k3");
    expect(cfg.model("kimi-k3", APIKEY_CREDS)).toBe("kimi-k3");
    expect(cfg.extraHeaders(OAUTH_CREDS)["X-Msh-Device-Id"]).toBe("device-123");
    expect(cfg.extraHeaders(APIKEY_CREDS)).toEqual({});
  });
});
