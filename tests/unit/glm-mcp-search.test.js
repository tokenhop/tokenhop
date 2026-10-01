import { afterEach, describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

const GLM = REGISTRY.find((p) => p.id === "glm");
const URL_ = GLM.searchConfig.baseUrl;

// Real wire shapes captured from api.z.ai on 2026-10-01.
const sse = (message) =>
  new Response(`id:1\nevent:message\ndata:${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "mcp-session-id": "sess-1" },
  });
const ITEMS = [
  { title: "Node.js", link: "https://nodejs.org", content: "Node.js releases", refer: "ref_1" },
];
const RESULTS = sse({
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: JSON.stringify(JSON.stringify(ITEMS)) }] },
});
const NOT_FOUND = sse({
  jsonrpc: "2.0",
  id: 2,
  result: {
    content: [{ type: "text", text: "MCP error -401: Api key not found, please get your apikey" }],
    isError: true,
  },
});

// Answer by JSON-RPC method so the tests assert on call order, not on stub order.
function stubUpstream(onCall) {
  const calls = [];
  let toolCalls = 0;
  const fetchMock = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url, method: body.method, headers: init.headers, body });
    if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: body.id, result: {} });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return onCall(++toolCalls);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const search = (apiKey, query = "nodejs release") =>
  handleSearchCore({
    body: { query, max_results: 5 },
    provider: { id: "glm" },
    providerConfig: GLM.searchConfig,
    credentials: { apiKey },
  });

afterEach(() => vi.unstubAllGlobals());

describe("GLM Coding web search over MCP", () => {
  it("handshakes, parses SSE + double-encoded text, and reuses the session", async () => {
    const calls = stubUpstream(() => RESULTS.clone());

    const first = await search("key-happy");
    expect(first.success).toBe(true);
    expect((await first.response.json()).results[0]).toMatchObject({
      title: "Node.js",
      url: "https://nodejs.org",
      snippet: "Node.js releases",
    });

    expect(calls.map((c) => c.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    for (const c of calls) {
      expect(c.url).toBe(URL_);
      expect(c.headers.Accept).toBe("application/json, text/event-stream");
      expect(c.headers.Authorization).toBe("Bearer key-happy");
    }
    expect(calls[0].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(calls[2].body.params.arguments).toEqual({
      search_query: "nodejs release",
      location: "us",
    });

    expect((await search("key-happy", "second")).success).toBe(true);
    expect(calls.slice(3).map((c) => c.method)).toEqual(["tools/call"]);
  });

  it("re-initializes once when a cached session is rejected", async () => {
    const calls = stubUpstream((n) => (n === 2 ? NOT_FOUND.clone() : RESULTS.clone()));
    await search("key-retry");
    calls.length = 0;

    const result = await search("key-retry");
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("surfaces upstream auth and HTTP errors without stack frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const auth = await search("key-bad");
    expect(auth.status).toBe(401);
    expect(auth.error).toBe("glm returned 401: token expired or incorrect");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ cause: null, stackTrace: [{ methodName: "handlePost" }] }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    const http = await search("key-400");
    expect(http.status).toBe(400);
    expect(http.error).not.toMatch(/stackTrace|handlePost/);
  });
});
