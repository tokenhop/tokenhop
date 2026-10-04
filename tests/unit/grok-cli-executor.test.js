import { describe, it, expect, beforeEach, vi } from "vitest";

const { outboundFetch } = vi.hoisted(() => ({ outboundFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: outboundFetch }));
import { BaseExecutor } from "../../open-sse/executors/base.js";
import {
  GrokCliExecutor,
  countGrokCliUserTurns,
  resolveGrokCliTurnIdx,
  _resetGrokCliTurnStore,
  _getGrokCliTurnStoreSize,
  normalizeGrokCliEffort,
  supportsGrokCliReasoningEffort,
} from "../../open-sse/executors/grok-cli.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS, PROVIDER_OAUTH, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { GROK_CLI_VERSION } from "../../open-sse/config/grokCli.js";
import { getModelInfoCore, resolveProviderAlias } from "../../open-sse/services/model.js";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("grok-cli registry", () => {
  it("registers transport + oauth + models", () => {
    const cfg = PROVIDERS["grok-cli"];
    expect(cfg).toBeTruthy();
    expect(cfg.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(cfg.format).toBe("openai-responses");
    expect(cfg.forceStream).toBe(true);
    expect(cfg.tokenAuth).toBe("xai-grok-cli");

    const oauth = PROVIDER_OAUTH["grok-cli"];
    expect(oauth.clientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(oauth.deviceCodeUrl).toContain("auth.x.ai");
    expect(oauth.scope).toContain("grok-cli:access");
    expect(oauth.scope).toContain("conversations:write");
    expect(oauth.referrer).toBe("grok-build");

    expect(PROVIDER_MODELS.gcli?.some((m) => m.id === "grok-build")).toBe(true);
  });

  it("is listed as oauth provider for dashboard", () => {
    expect(OAUTH_PROVIDERS["grok-cli"]).toBeTruthy();
    expect(OAUTH_PROVIDERS["grok-cli"].name).toMatch(/Grok CLI/i);
  });

  it("resolves aliases to provider id", () => {
    expect(resolveProviderAlias("gcli")).toBe("grok-cli");
    expect(resolveProviderAlias("gb")).toBe("grok-cli");
    expect(resolveProviderAlias("grok-build")).toBe("grok-cli");
    expect(resolveProviderAlias("grok-cli")).toBe("grok-cli");
  });

  it("routes bare grok-build to the subscription provider", async () => {
    await expect(getModelInfoCore("grok-build", {})).resolves.toEqual({
      provider: "grok-cli",
      model: "grok-build",
    });
  });

  it("maps effort virtual models to upstream grok-4.5", () => {
    expect(getModelUpstreamId("gcli", "grok-4.5-high")).toBe("grok-4.5");
    expect(getModelUpstreamId("gcli", "grok-4.5-medium")).toBe("grok-4.5");
    expect(getModelUpstreamId("gcli", "grok-4.5-low")).toBe("grok-4.5");
    expect(getModelUpstreamId("gcli", "grok-4.5")).toBe("grok-4.5");
  });
});

describe("GrokCliExecutor", () => {
  let executor;
  let executor2;

  beforeEach(() => {
    _resetGrokCliTurnStore();
    outboundFetch.mockReset();
    executor = new GrokCliExecutor();
  });

  it("is registered on executor map (id + aliases)", () => {
    expect(hasSpecializedExecutor("grok-cli")).toBe(true);
    expect(getExecutor("grok-cli")).toBeInstanceOf(GrokCliExecutor);
    expect(getExecutor("gcli")).toBeInstanceOf(GrokCliExecutor);
    expect(getExecutor("gb")).toBeInstanceOf(GrokCliExecutor);
  });

  it("buildUrl points at cli-chat-proxy responses", () => {
    expect(executor.buildUrl()).toBe("https://cli-chat-proxy.grok.com/v1/responses");
  });

  it("buildHeaders sets trusted Responses fingerprint without identity (task2.1)", () => {
    // Real BaseExecutor.execute contract: transformRequest, then buildHeaders
    // with the transformed body. Request state rides the body Symbol, not the
    // shared singleton fields.
    const creds = {
      accessToken: "tok_test",
      connectionId: "conn-hdr",
      rawHeaders: { "x-session-id": "sess-abc" },
      providerSpecificData: { email: "u@example.com", userId: "uid-1", deviceId: "agent-1" },
    };

    let body;
    for (let i = 0; i < 3; i += 1) {
      body = executor.transformRequest(
        "grok-4.5",
        { model: "grok-4.5", input: [{ type: "message", role: "user", content: "hi" }] },
        true,
        creds,
      );
    }

    const headers = executor.buildHeaders(
      creds,
      true,
      "https://cli-chat-proxy.grok.com/v1/responses",
      null,
      body,
    );

    expect(headers.Authorization).toBe("Bearer tok_test");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(headers["x-grok-client-version"]).toBe(GROK_CLI_VERSION);
    expect(headers["x-grok-session-id"]).toBe("sess-abc");
    expect(headers["x-grok-conv-id"]).toBe("sess-abc");
    expect(headers["x-grok-req-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers["x-grok-turn-idx"]).toBe("3");
    expect(headers["x-grok-agent-id"]).toBe("agent-1");
    expect(headers["x-grok-model-override"]).toBe("grok-4.5");
    // Trusted-proxy-only fingerprint
    expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(headers["x-authenticateresponse"]).toBe("authenticate-response");
    expect(headers["x-grok-client-mode"]).toBe("headless");
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    // Responses construction must not carry user identity
    expect(headers["x-email"]).toBeUndefined();
    expect(headers["x-userid"]).toBeUndefined();
    // Policy headers deliberately absent
    expect(headers["x-compaction-at"]).toBeUndefined();
    expect(headers["x-uncompacted-prefix-count"]).toBeUndefined();
    expect(headers["x-doom-loop-detected"]).toBeUndefined();
  });

  it("buildHeaders omits proxy fingerprint off the trusted origin", () => {
    executor._currentSessionId = "sess-untrusted";
    executor._currentReqId = "req-untrusted";

    const headers = executor.buildHeaders(
      { accessToken: "tok_test" },
      true,
      "https://evil-cli-chat-proxy.grok.com.attacker.example/v1/responses",
    );

    expect(headers["x-xai-token-auth"]).toBeUndefined();
    expect(headers["x-authenticateresponse"]).toBeUndefined();
    expect(headers["x-grok-client-mode"]).toBeUndefined();
    expect(headers["x-grok-conv-group-id"]).toBeUndefined();
    expect(headers["x-grok-session-id"]).toBe("sess-untrusted");
    expect(headers.Authorization).toBe("Bearer tok_test");
  });

  it("each attempt gets a fresh traceparent", () => {
    executor._currentSessionId = "sess-t";
    const h1 = executor.buildHeaders({ accessToken: "t" }, true);
    const h2 = executor.buildHeaders({ accessToken: "t" }, true);
    expect(h1.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(h1.traceparent).not.toBe(h2.traceparent);
  });

  it("transformRequest normalizes Responses body like official CLI", () => {
    const body = {
      model: "grok-4.5-high",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "run_terminal_command",
            description: "Run bash",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
        { type: "web_search" },
        { type: "x_search" },
      ],
      temperature: 0.7,
      max_tokens: 100,
      user: "cursor-user",
    };

    // Simulate translator already converting messages→input; also test messages fallback
    const out = executor.transformRequest("grok-4.5-high", { ...body }, true, {
      connectionId: "conn-1",
    });

    expect(out.model).toBe("grok-4.5");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.reasoning).toEqual({ effort: "high", summary: "concise" });
    expect(out.messages).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.input.length).toBeGreaterThan(0);
    expect(executor._currentTurnIdx).toBe(1);

    // tools flattened + hosted tools kept
    expect(out.tools).toHaveLength(3);
    expect(out.tools[0]).toMatchObject({
      type: "function",
      name: "run_terminal_command",
    });
    expect(out.tools[0].parameters).toBeTruthy();
    expect(out.tools[0].function).toBeUndefined();
    expect(out.tools[1]).toEqual({ type: "web_search" });
    expect(out.tools[2]).toEqual({ type: "x_search" });
  });

  it("transformRequest keeps role:system (HAR parity) and strips server ids", () => {
    const body = {
      model: "grok-4.5",
      input: [
        { type: "message", role: "system", content: "You are Grok" },
        { type: "message", role: "user", content: "hi", id: "msg_server_id" },
        { type: "item_reference", id: "rs_abc" },
        "rs_should_drop",
      ],
      reasoning_effort: "medium",
    };

    const out = executor.transformRequest("grok-4.5", body, true, { connectionId: "c1" });
    expect(out.input).toHaveLength(2);
    // Official CLI sends system, not developer (Codex converts; Grok does not)
    expect(out.input[0].role).toBe("system");
    expect(out.input[1].id).toBeUndefined();
    expect(out.reasoning.effort).toBe("medium");
  });

  it("normalizes Codex cross-provider tool and reasoning history", () => {
    const out = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [
          { type: "message", role: "user", content: "continue" },
          {
            type: "reasoning",
            id: "rs_07fe505b3114f180016a5698411c448191bdcdcba678464461",
            encrypted_content: "openai-ciphertext",
            summary: [],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
          {
            type: "custom_tool_call",
            id: "ctc_openai",
            call_id: "call-custom",
            name: "exec",
            input: "run this",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
          {
            type: "custom_tool_call_output",
            call_id: "call-custom",
            output: [
              { type: "input_text", text: "first" },
              { type: "input_text", text: "second" },
            ],
          },
          {
            type: "function_call_output",
            call_id: "call-function",
            output: [{ type: "input_text", text: "function result" }],
          },
        ],
        tools: [{ type: "custom", name: "exec", description: "Run command" }],
      },
      true,
      { connectionId: "cross-provider" },
    );

    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(out.input[1]).toEqual({
      type: "function_call",
      call_id: "call-custom",
      name: "exec",
      arguments: JSON.stringify({ input: "run this" }),
    });
    expect(out.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call-custom",
      output: JSON.stringify([
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ]),
    });
    expect(out.input.some((item) => item.call_id === "call-function")).toBe(false);
    expect(out.tools[0].parameters).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    });
  });

  it("stringifies structured outputs and removes orphaned output items", () => {
    const out = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [
          { type: "function_call", call_id: "call-array", name: "array_tool", arguments: "{}" },
          { type: "function_call_output", call_id: "call-array", output: [1, 2] },
          { type: "function_call", call_id: "call-null", name: "null_tool", arguments: "{}" },
          { type: "function_call_output", call_id: "call-null", output: null },
          { type: "custom_tool_call", call_id: "call-invalid", input: "missing name" },
          { type: "custom_tool_call_output", call_id: "call-invalid", output: "orphan" },
        ],
      },
      true,
      { connectionId: "structured-output" },
    );

    const outputs = out.input.filter((item) => item.type === "function_call_output");
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "call-array", output: "[1,2]" },
      { type: "function_call_output", call_id: "call-null", output: "null" },
    ]);
    expect(out.input.some((item) => item.call_id === "call-invalid")).toBe(false);
  });

  it("preserves native Grok encrypted reasoning and item ids", () => {
    const reasoningId = "rs_3e3f6187-892a-96db-893b-904eff019e19";
    const messageId = "msg_3e3f6187-892a-96db-893b-904eff019e19";
    const functionId = "fc_3e3f6187-892a-96db-893b-904eff019e19";
    const out = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [
          {
            type: "reasoning",
            id: reasoningId,
            status: "completed",
            encrypted_content: "grok-ciphertext",
            summary: [],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-2" },
          },
          { type: "message", id: messageId, role: "assistant", content: "done" },
          {
            type: "function_call",
            id: functionId,
            call_id: "native-call",
            name: "wait",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "native-call", output: "done" },
          { type: "message", role: "user", content: "next" },
        ],
      },
      true,
      { connectionId: "native-grok" },
    );

    expect(out.input[0]).toMatchObject({
      type: "reasoning",
      id: reasoningId,
      encrypted_content: "grok-ciphertext",
    });
    expect(out.input[0].internal_chat_message_metadata_passthrough).toBeUndefined();
    expect(out.input[1].id).toBe(messageId);
    expect(out.input[2].id).toBe(functionId);
  });

  it("normalizes official effort aliases", () => {
    expect(normalizeGrokCliEffort("none")).toBe("high");
    expect(normalizeGrokCliEffort("minimal")).toBe("high");
    expect(normalizeGrokCliEffort("max")).toBe("xhigh");
    expect(normalizeGrokCliEffort("xhigh")).toBe("xhigh");
    expect(normalizeGrokCliEffort("ultra")).toBe("high");

    const out = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: "hi",
        reasoning: { effort: "max", summary: "detailed" },
      },
      true,
      { connectionId: "effort-conn" },
    );
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "detailed" });
  });

  it("omits reasoning effort for models that reject it", () => {
    expect(supportsGrokCliReasoningEffort("grok-4.5")).toBe(true);
    expect(supportsGrokCliReasoningEffort("grok-build")).toBe(false);
    expect(supportsGrokCliReasoningEffort("grok-composer-2.5-fast")).toBe(false);

    for (const model of ["grok-build", "grok-composer-2.5-fast"]) {
      const out = executor.transformRequest(
        model,
        {
          model,
          input: "hi",
          reasoning: { effort: "max" },
        },
        true,
        { connectionId: `effort-${model}` },
      );
      expect(out.reasoning).toEqual({ summary: "concise" });
      expect(out.include).toContain("reasoning.encrypted_content");
    }
  });

  it("drops stale tool_choice and normalizes converted custom choices", () => {
    const noTools = executor.transformRequest(
      "grok-build",
      {
        model: "grok-build",
        input: "hi",
        tool_choice: "auto",
      },
      true,
      { connectionId: "tools-none" },
    );
    expect(noTools.tool_choice).toBeUndefined();

    const custom = executor.transformRequest(
      "grok-build",
      {
        model: "grok-build",
        input: "hi",
        tools: [{ type: "custom", name: "apply_patch", description: "Patch files" }],
        tool_choice: { type: "custom", name: "apply_patch" },
      },
      true,
      { connectionId: "tools-custom" },
    );
    expect(custom.tools).toEqual([
      expect.objectContaining({ type: "function", name: "apply_patch" }),
    ]);
    expect(custom.tool_choice).toEqual({ type: "function", name: "apply_patch" });
  });

  it("increments x-grok-turn-idx from user-message count and stays monotonic", () => {
    const creds = {
      connectionId: "turn-conn",
      rawHeaders: { "x-session-id": "stable-session-xyz" },
    };

    // Turn 1: one user message
    executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [
          { type: "message", role: "system", content: "sys" },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      true,
      creds,
    );
    expect(executor._currentSessionId).toBeTruthy();
    expect(executor._currentTurnIdx).toBe(1);
    let headers = executor.buildHeaders({ accessToken: "t" }, true);
    expect(headers["x-grok-turn-idx"]).toBe("1");
    expect(headers["x-grok-session-id"]).toBe(executor._currentSessionId);
    expect(headers["x-grok-conv-id"]).toBe(executor._currentSessionId);

    const sessionId = executor._currentSessionId;

    // Turn 2: full history with two user messages
    executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [
          { type: "message", role: "system", content: "sys" },
          { type: "message", role: "user", content: "hi" },
          { type: "message", role: "assistant", content: "hello" },
          { type: "message", role: "user", content: "next" },
        ],
      },
      true,
      creds,
    );
    expect(executor._currentSessionId).toBe(sessionId);
    expect(executor._currentTurnIdx).toBe(2);
    headers = executor.buildHeaders({ accessToken: "t" }, true);
    expect(headers["x-grok-turn-idx"]).toBe("2");

    // Same session, a new delta-style request advances without relying on full history.
    executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [{ type: "message", role: "user", content: "only latest" }],
      },
      true,
      creds,
    );
    expect(executor._currentTurnIdx).toBe(3);
  });

  it("countGrokCliUserTurns / resolveGrokCliTurnIdx helpers", () => {
    expect(countGrokCliUserTurns(null)).toBe(1);
    expect(
      countGrokCliUserTurns([
        { type: "message", role: "system", content: "s" },
        { type: "message", role: "user", content: "a" },
        { type: "message", role: "assistant", content: "b" },
        { type: "message", role: "user", content: "c" },
      ]),
    ).toBe(2);

    expect(resolveGrokCliTurnIdx("s1", [{ role: "user", type: "message", content: "a" }])).toBe(1);
    expect(
      resolveGrokCliTurnIdx("s1", [
        { role: "user", type: "message", content: "a" },
        { role: "user", type: "message", content: "b" },
      ]),
    ).toBe(2);
    // monotonic
    expect(resolveGrokCliTurnIdx("s1", [{ role: "user", type: "message", content: "a" }])).toBe(2);
  });

  it("keeps fallback session stable when assistant history appears", () => {
    const creds = { connectionId: "fallback-conn", rawHeaders: {} };
    executor.transformRequest(
      "grok-build",
      {
        model: "grok-build",
        input: [{ type: "message", role: "user", content: "first" }],
      },
      true,
      creds,
    );
    const firstSession = executor._currentSessionId;

    executor.transformRequest(
      "grok-build",
      {
        model: "grok-build",
        input: [
          { type: "message", role: "user", content: "first" },
          { type: "message", role: "assistant", content: "x".repeat(100) },
          { type: "message", role: "user", content: "second" },
        ],
      },
      true,
      creds,
    );
    expect(executor._currentSessionId).toBe(firstSession);
    expect(executor._currentTurnIdx).toBe(2);
  });

  it("does not advance turn index when retrying the same request body", () => {
    const body = {
      model: "grok-build",
      input: [{ type: "message", role: "user", content: "retry me" }],
    };
    const creds = { connectionId: "retry-conn" };
    executor.transformRequest("grok-build", body, true, creds);
    const firstTurn = executor._currentTurnIdx;
    executor.transformRequest("grok-build", body, true, creds);
    expect(executor._currentTurnIdx).toBe(firstTurn);
  });

  it("bounds per-session turn state", () => {
    for (let i = 0; i < 5100; i += 1) {
      resolveGrokCliTurnIdx(`session-${i}`, [{ role: "user", content: "hi" }]);
    }
    expect(_getGrokCliTurnStoreSize()).toBe(5000);
  });

  it("parseError surfaces 402 spending-limit", () => {
    const err = executor.parseError(
      { status: 402 },
      JSON.stringify({
        code: "personal-team-blocked:spending-limit",
        error: "You have run out of credits",
      }),
    );
    expect(err.status).toBe(402);
    expect(err.code).toBe("personal-team-blocked:spending-limit");
    expect(err.message).toMatch(/credits/i);
  });

  it("defaults missing model to grok-4.6 with high effort and concise summary", () => {
    const out = executor.transformRequest(
      undefined,
      {
        input: [{ type: "message", role: "user", content: "hi" }],
      },
      true,
      { connectionId: "default-conn" },
    );
    expect(out.model).toBe("grok-4.6");
    expect(out.reasoning).toEqual({ effort: "high", summary: "concise" });
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.include).toContain("no_inline_citations");
  });

  it("grok-4.7 sends concise summary with effort omitted and no invented limits", () => {
    const out = executor.transformRequest(
      "grok-4.7-high",
      {
        model: "grok-4.7-high",
        input: "hi",
      },
      true,
      { connectionId: "c47" },
    );
    expect(out.model).toBe("grok-4.7");
    expect(out.reasoning.effort).toBeUndefined();
    expect(out.reasoning.summary).toBe("concise");
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("valid prompt_cache_key kept verbatim; malformed dropped and replaced by session", () => {
    const kept = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: "hi",
        prompt_cache_key: "  stable-key  ",
      },
      true,
      { connectionId: "cache-conn" },
    );
    expect(kept.prompt_cache_key).toBe("  stable-key  ");

    executor2 = new GrokCliExecutor();
    const tooLong = executor2.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: "hi",
        prompt_cache_key: "x".repeat(257),
      },
      true,
      { connectionId: "cache-conn" },
    );
    expect(tooLong.prompt_cache_key).toBe(executor2._currentSessionId);

    const ctrl = executor2.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: "hi",
        prompt_cache_key: "bad\u0000key",
      },
      true,
      { connectionId: "cache-conn" },
    );
    expect(ctrl.prompt_cache_key).toBe(executor2._currentSessionId);
  });

  it("includes dedupe + summary none keeps encrypted continuity without summary field", () => {
    const out = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: "hi",
        include: [
          "reasoning.encrypted_content",
          "reasoning.encrypted_content",
          42,
          " other.include ",
        ],
        reasoning: { summary: "none" },
      },
      true,
      { connectionId: "inc-conn" },
    );
    expect(out.include.filter((v) => v === "reasoning.encrypted_content")).toHaveLength(1);
    expect(out.include).toContain("other.include");
    expect(out.include).toContain("no_inline_citations");
    expect(out.reasoning.summary).toBeUndefined();
  });

  it("no_inline_citations only on trusted config URL", () => {
    const saved = executor.config.baseUrl;
    executor.config.baseUrl = "https://elsewhere.example/v1/responses";
    try {
      const out = executor.transformRequest(
        "grok-4.5",
        {
          model: "grok-4.5",
          input: "hi",
        },
        true,
        { connectionId: "inc-untrusted" },
      );
      expect(out.include).not.toContain("no_inline_citations");
      expect(out.include).toContain("reasoning.encrypted_content");
    } finally {
      executor.config.baseUrl = saved;
    }
  });

  it("same conversation gets stable conv-group UUID; request state isolated per body", () => {
    const creds = { connectionId: "group-conn", rawHeaders: { "x-session-id": "conv-1" } };
    const b1 = executor.transformRequest(
      "grok-4.5",
      { model: "grok-4.5", input: "hi" },
      true,
      creds,
    );
    const h1 = executor.buildHeaders(
      creds,
      true,
      "https://cli-chat-proxy.grok.com/v1/responses",
      null,
      b1,
    );
    const b2 = executor.transformRequest(
      "grok-4.5",
      { model: "grok-4.5", input: "again" },
      true,
      creds,
    );
    const h2 = executor.buildHeaders(
      creds,
      true,
      "https://cli-chat-proxy.grok.com/v1/responses",
      null,
      b2,
    );
    expect(h1["x-grok-conv-group-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h2["x-grok-conv-group-id"]).toBe(h1["x-grok-conv-group-id"]);

    const credsB = { connectionId: "group-conn-b", rawHeaders: { "x-session-id": "conv-2" } };
    const bB = executor.transformRequest(
      "grok-4.6",
      { model: "grok-4.6", input: "other convo" },
      true,
      credsB,
    );
    const hB = executor.buildHeaders(
      credsB,
      true,
      "https://cli-chat-proxy.grok.com/v1/responses",
      null,
      bB,
    );
    expect(hB["x-grok-conv-group-id"]).not.toBe(h1["x-grok-conv-group-id"]);

    // Build headers from older bodies AFTER another request changed singleton fields.
    const delayed1 = executor.buildHeaders(creds, true, executor.config.baseUrl, null, b1);
    const delayed2 = executor.buildHeaders(creds, true, executor.config.baseUrl, null, b2);
    expect(delayed1["x-grok-session-id"]).toBe("conv-1");
    expect(delayed1["x-grok-req-id"]).toBe(h1["x-grok-req-id"]);
    expect(delayed1["x-grok-turn-idx"]).toBe("1");
    expect(delayed2["x-grok-turn-idx"]).toBe("2");
    expect(delayed1["x-grok-model-override"]).toBe("grok-4.5");
    expect(hB["x-grok-session-id"]).toBe("conv-2");
  });

  it("execute sends per-request headers through one outbound fetch and keeps interleaved requests isolated", async () => {
    const resolvers = [];
    outboundFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const makeCreds = (session) => ({
      accessToken: `tok_${session}`,
      connectionId: `conn-${session}`,
      rawHeaders: { "x-session-id": session },
      providerSpecificData: { deviceId: `agent-${session}` },
    });
    // Avoid unrelated asynchronous machine-ID initialization in this wire test.
    executor._machineAgentId = "machine-test";
    const makeBody = (model) => ({
      model,
      input: [{ type: "message", role: "user", content: "hi" }],
    });

    const callA = executor.execute({
      model: "grok-4.5",
      body: makeBody("grok-4.5"),
      stream: true,
      credentials: makeCreds("sess-A"),
    });
    const callB = executor.execute({
      model: "grok-4.6",
      body: makeBody("grok-4.6"),
      stream: true,
      credentials: makeCreds("sess-B"),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(outboundFetch).toHaveBeenCalledTimes(2);

    const [urlA, optsA] = outboundFetch.mock.calls[0];
    const [, optsB] = outboundFetch.mock.calls[1];
    expect(urlA).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    const hA = optsA.headers;
    const hB = optsB.headers;
    expect(hA.Authorization).toBe("Bearer tok_sess-A");
    expect(hB.Authorization).toBe("Bearer tok_sess-B");
    expect(hA["x-grok-session-id"]).toBe("sess-A");
    expect(hB["x-grok-session-id"]).toBe("sess-B");
    expect(hA["x-grok-model-override"]).toBe("grok-4.5");
    expect(hB["x-grok-model-override"]).toBe("grok-4.6");
    expect(hA["x-grok-req-id"]).toMatch(/^[0-9a-f]{8}-/);
    expect(hB["x-grok-req-id"]).toMatch(/^[0-9a-f]{8}-/);
    expect(hA["x-grok-req-id"]).not.toBe(hB["x-grok-req-id"]);
    expect(hA.traceparent).not.toBe(hB.traceparent);
    const bodyA = JSON.parse(optsA.body);
    const bodyB = JSON.parse(optsB.body);
    expect(bodyA.prompt_cache_key).toBe("sess-A");
    expect(bodyB.prompt_cache_key).toBe("sess-B");
    expect(bodyA.model).toBe("grok-4.5");
    expect(bodyB.model).toBe("grok-4.6");

    for (const resolve of resolvers) {
      resolve(
        new Response('data: {"type":"response.completed","response":{}}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA.response.status).toBe(200);
    expect(resultB.response.status).toBe(200);
  });

  it("outbound execute ignores attacker-controlled inbound fingerprint/trace headers", async () => {
    const resolvers = [];
    outboundFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const credentials = {
      accessToken: "tok_guard",
      connectionId: "conn-guard",
      rawHeaders: {
        "x-session-id": "sess-guard",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        "x-xai-token-auth": "forged",
        "x-grok-client-mode": "forged",
        "x-attacker": "inject",
      },
    };
    const call = executor.execute({
      model: "grok-4.5",
      body: { model: "grok-4.5", input: [{ type: "message", role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(outboundFetch).toHaveBeenCalledTimes(1);
    const headers = outboundFetch.mock.calls[0][1].headers;
    expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(headers["x-grok-client-mode"]).toBe("headless");
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(headers.traceparent).not.toBe(credentials.rawHeaders.traceparent);
    expect(headers["x-attacker"]).toBeUndefined();
    for (const resolve of resolvers) {
      resolve(
        new Response('data: {"type":"response.completed","response":{}}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    await call;
  });

  it("drops a non-string prompt_cache_key before resolving cache identity", () => {
    const body = executor.transformRequest(
      "grok-4.5",
      {
        model: "grok-4.5",
        input: [{ type: "message", role: "user", content: "hi" }],
        prompt_cache_key: 42,
      },
      true,
      { accessToken: "tok", connectionId: "conn-cache" },
    );
    expect(typeof body.prompt_cache_key).toBe("string");
    expect(body.prompt_cache_key).toBe(executor._currentSessionId);
  });

  it("426 redacts plain bearer secrets from text detail", () => {
    const err = executor.parseError(
      { status: 426 },
      "client too old; Authorization: Bearer tok_live_secret_123456789 rejected",
    );
    expect(err.status).toBe(426);
    expect(err.message).toContain("GROK_CLI_VERSION");
    expect(err.message).not.toContain("tok_live_secret_123456789");
  });

  it("parseError 426 stays 426 with GROK_CLI_VERSION hint and safe detail", () => {
    const cases = [
      "Upgrade required: client too old",
      JSON.stringify({ message: "unsupported version" }),
      JSON.stringify({ error: { message: "version too old", code: "version_gate" } }),
      "{not json",
      "",
      JSON.stringify({ error: "token=eyJhbGciOi.abc.def rejected" }),
    ];
    for (const bodyText of cases) {
      const err = executor.parseError({ status: 426 }, bodyText);
      expect(err.status).toBe(426);
      expect(err.message).toContain("GROK_CLI_VERSION");
      expect(err.message).not.toMatch(/eyJ[A-Za-z0-9_-]/);
      expect(err.message.length).toBeLessThan(500);
    }
  });

  it("sends x-grok-agent-id without deviceId and never leaks another connection's id (YAN-26)", async () => {
    // Mirror BaseExecutor.execute's order: transformRequest, then buildHeaders.
    const spy = vi.spyOn(BaseExecutor.prototype, "execute").mockImplementation(function ({
      model,
      body,
      stream,
      credentials,
    }) {
      this.transformRequest(model, body, stream, credentials);
      return this.buildHeaders(credentials, stream)["x-grok-agent-id"];
    });
    const run = (psd) =>
      executor.execute({
        model: "grok-4.5",
        body: { input: "hi" },
        stream: true,
        credentials: { accessToken: "t", providerSpecificData: psd },
      });

    try {
      const machineId = await run({});
      expect(machineId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await run({ deviceId: "dev-1" })).toBe("dev-1");
      expect(await run({})).toBe(machineId);
    } finally {
      spy.mockRestore();
    }
  });
});
