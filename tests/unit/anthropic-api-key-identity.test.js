// YAN-1042: official Anthropic API-key traffic must not carry Claude Code identity
// markers (claude-code beta, "You are Claude Code" system prompt). OAuth `claude`
// and compatible providers keep their existing behavior.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CLAUDE_SYSTEM_PROMPT } from "../../open-sse/config/appConstants.js";

const MODEL = "claude-sonnet-4-20250514";
const OAUTH = "sk-ant-oat-test-token";

// translateRequest -> real DefaultExecutor.execute -> captured outbound request.
async function send(provider, source, body, credentials, model = MODEL) {
  proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  const translated = translateRequest(
    source,
    FORMATS.CLAUDE,
    model,
    structuredClone(body),
    false,
    credentials,
    provider,
  );
  await new DefaultExecutor(provider).execute({
    model,
    body: translated,
    stream: false,
    credentials,
    log: { warn: vi.fn(), debug: vi.fn() },
  });
  const [url, init] = proxyAwareFetch.mock.calls.at(-1);
  return { url, headers: init.headers, body: JSON.parse(init.body) };
}

const apiKey = { apiKey: "sk-ant-api03-test" };
const openai = (body) => send("anthropic", FORMATS.OPENAI, body, apiKey);
const systemText = (out) => (out.system || []).map((b) => b.text);
const betas = (headers) => (headers["Anthropic-Beta"] || "").split(",").filter(Boolean);

beforeEach(() => proxyAwareFetch.mockReset());

describe("anthropic API-key headers", () => {
  const build = (model) =>
    new DefaultExecutor("anthropic").buildHeaders(apiKey, false, undefined, model);

  it.each([[MODEL], [undefined]])("has no claude-code beta (model=%s)", (model) => {
    const headers = build(model);
    expect(headers["Anthropic-Beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(headers["x-api-key"]).toBe(apiKey.apiKey);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("X-App");
  });
});

describe("anthropic API-key system prompt (OpenAI source)", () => {
  it("omits system when the caller sent none", async () => {
    const out = await openai({ messages: [{ role: "user", content: "hi" }] });
    expect(out.body).not.toHaveProperty("system");
    expect(JSON.stringify(out.body)).not.toContain("Claude Code");
    expect(betas(out.headers)).not.toContain("claude-code-20250219");
  });

  it("keeps system then developer order without an injected identity", async () => {
    const out = await openai({
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
        { role: "developer", content: "DEV" },
      ],
    });
    expect(out.body.system).toHaveLength(1);
    expect(out.body.system[0].text).toBe("SYS\nDEV");
  });

  it("preserves caller-owned identity text exactly", async () => {
    const out = await openai({
      messages: [
        { role: "system", content: CLAUDE_SYSTEM_PROMPT },
        { role: "user", content: "hi" },
      ],
    });
    expect(systemText(out.body)).toEqual([CLAUDE_SYSTEM_PROMPT]);
  });

  it("creates system from json_object / json_schema instructions only", async () => {
    const obj = await openai({
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    expect(systemText(obj.body)).toEqual([
      "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.",
    ]);

    const schema = await openai({
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } },
    });
    expect(schema.body.system).toHaveLength(1);
    expect(schema.body.system[0].text).toContain("JSON schema");
    expect(JSON.stringify(schema.body.system)).not.toContain("Claude Code");
  });

  it("keeps tools, history and thinking intact", async () => {
    const out = await openai({
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "a",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "r" },
        { role: "user", content: "next" },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    });
    expect(out.body).not.toHaveProperty("system");
    expect(out.body.tools.map((t) => t.name)).toEqual(["f"]);
    expect(out.body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out.body.messages[1].content.some((b) => b.type === "tool_use")).toBe(true);
    expect(out.body.messages[2].content[0].type).toBe("tool_result");
    expect(out.body.thinking).toBeDefined();
  });
});

describe("anthropic API-key native Claude source", () => {
  it("passes caller system content through untouched", async () => {
    const system = [
      { type: "text", text: CLAUDE_SYSTEM_PROMPT },
      { type: "text", text: "caller rules" },
    ];
    const out = await send(
      "anthropic",
      FORMATS.CLAUDE,
      { max_tokens: 64, system, messages: [{ role: "user", content: "hi" }] },
      apiKey,
    );
    expect(systemText(out.body)).toEqual([CLAUDE_SYSTEM_PROMPT, "caller rules"]);
  });

  it("adds no system when the native request had none", async () => {
    const out = await send(
      "anthropic",
      FORMATS.CLAUDE,
      { max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      apiKey,
    );
    expect(out.body).not.toHaveProperty("system");
  });
});

describe("unchanged providers (OpenAI source)", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("claude OAuth keeps identity prompt, billing cloak, bearer and claude-code beta", async () => {
    const out = await send("claude", FORMATS.OPENAI, body, { accessToken: OAUTH });
    const texts = systemText(out.body);
    expect(texts[0]).toMatch(/^x-anthropic-billing-header:/);
    expect(texts).toContain(CLAUDE_SYSTEM_PROMPT);
    expect(out.body.metadata.user_id).toBeTruthy();
    expect(out.headers.Authorization).toBe(`Bearer ${OAUTH}`);
    expect(out.headers).not.toHaveProperty("x-api-key");
    expect(out.headers["X-App"]).toBe("cli");
    expect(betas(out.headers)).toContain("claude-code-20250219");
  });

  it("anthropic-compatible still gets the identity prompt but no claude-code beta", async () => {
    const out = await send("anthropic-compatible-test", FORMATS.OPENAI, body, {
      apiKey: "sk-third-party",
      providerSpecificData: { baseUrl: "https://gw.example.com/v1" },
    });
    expect(systemText(out.body)).toEqual([CLAUDE_SYSTEM_PROMPT]);
    expect(betas(out.headers)).not.toContain("claude-code-20250219");
  });
});
