// YAN-734: openai-compatible nodes with apiType "completions" serve FIM
// requests on <baseUrl>/completions with raw FIM-token prompts (or `suffix`),
// and reject every non-FIM source before any upstream call.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
  isProxyActive: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
}));

const { buildFimNativeRequest } = await import("../../open-sse/translator/request/fim-native.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const NODE = "openai-compatible-completions-11111111-2222-3333-4444-555555555555";
const BASE = "https://fim.example.test/v1";

describe("buildFimNativeRequest vendor=template", () => {
  const parts = { prefix: "int a =", suffix: " = 1;", context: "" };

  it("token mode: encodes into prompt, sends no suffix field", () => {
    const out = buildFimNativeRequest("m", {}, false, parts, "template", "qwen");
    expect(out.prompt).toBe("<|fim_prefix|>int a =<|fim_suffix|> = 1;<|fim_middle|>");
    expect(out).not.toHaveProperty("suffix");
    expect(out.stream).toBe(false);
  });

  it("token mode: codestral is suffix-first; context leads the prompt with a newline", () => {
    const out = buildFimNativeRequest(
      "m",
      {},
      false,
      { ...parts, context: "// File: a.js" },
      "template",
      "codestral",
    );
    expect(out.prompt).toBe("// File: a.js\n[SUFFIX] = 1;[PREFIX]int a =");
    expect(out).not.toHaveProperty("suffix");
  });

  it("suffix mode: plain prompt plus separate suffix field", () => {
    const out = buildFimNativeRequest("m", {}, true, parts, "template", "suffix");
    expect(out.prompt).toBe("int a =");
    expect(out.suffix).toBe(" = 1;");
    expect(out.stream).toBe(true);
  });

  it("drops stop strings that contain FIM tokens, keeps others", () => {
    const out = buildFimNativeRequest(
      "m",
      { stop: ["<|fim_middle|>", "\n\n"] },
      false,
      parts,
      "template",
      "qwen",
    );
    expect(out.stop).toEqual(["\n\n"]);
  });
});

function completionsCreds(extra = {}) {
  return {
    apiKey: "sk-node",
    providerSpecificData: { baseUrl: `${BASE}/`, apiType: "completions", ...extra },
  };
}

function options(body, endpoint, sourceFormatOverride, psd) {
  return {
    body,
    modelInfo: { provider: NODE, model: "qwen-coder" },
    credentials: completionsCreds(psd),
    sourceFormatOverride,
    connectionId: "conn-1",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: { endpoint, body, headers: { accept: "application/json" } },
  };
}

const upstreamBody = {
  id: "cmpl-1",
  object: "text_completion",
  created: 1,
  model: "qwen-coder",
  choices: [{ index: 0, text: "2;<|endoftext|>garbage", finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

describe("handleChatCore with a completions-type openai-compatible node", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  it("FIM source hits <baseUrl>/completions with the template-encoded prompt", async () => {
    const body = { model: `${NODE}/qwen-coder`, prompt: "int a =", suffix: " = 1;", stream: false };
    const result = await handleChatCore(options(body, "/v1/completions", "openai-completions"));

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/completions`);
    expect(init.headers.Authorization).toBe("Bearer sk-node");
    const sent = JSON.parse(init.body);
    expect(sent.prompt).toBe("<|fim_prefix|>int a =<|fim_suffix|> = 1;<|fim_middle|>");
    expect(sent).not.toHaveProperty("suffix");
    expect(sent).not.toHaveProperty("messages");

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("text_completion");
    expect(json.choices[0].text).toBe("2;");
  });

  it("honours the node's fimTemplate (codestral) and suffix mode", async () => {
    const body = { model: "m", prompt: "int a =", suffix: " = 1;", stream: false };
    await handleChatCore(
      options(body, "/v1/completions", "openai-completions", { fimTemplate: "codestral" }),
    );
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).prompt).toBe(
      "[SUFFIX] = 1;[PREFIX]int a =",
    );

    proxyAwareFetch.mockClear();
    await handleChatCore(
      options({ ...body }, "/v1/completions", "openai-completions", { fimTemplate: "suffix" }),
    );
    const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(sent.prompt).toBe("int a =");
    expect(sent.suffix).toBe(" = 1;");
  });

  it("rejects a chat source with 404 (combo-advanceable) and never calls upstream", async () => {
    const body = { model: "m", stream: false, messages: [{ role: "user", content: "hi" }] };
    const result = await handleChatCore(options(body, "/v1/chat/completions"));

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("only serves /v1/completions");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
