import { describe, it, expect, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .clone().json() surface the engine uses.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  const make = () => ({
    ok: false,
    status,
    clone: make,
    json: async () => ({ error: { message: "boom" } }),
  });
  return make();
}

// YAN-1030: a 2xx fusion answer must still contain something the client can use.
function jsonResponse(json) {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const sseFrame = (delta, extra = {}) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`;

function sseResponse(raw) {
  return new Response(raw, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("fusion combo", () => {
  it("returns 502 when a single-model panel answers with empty content", async () => {
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/only"],
      handleSingleModel: vi.fn(async () =>
        jsonResponse({ choices: [{ message: { content: "" } }] }),
      ),
      log,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "Fusion answer was empty" } });
  });

  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(
      ([, m]) => m !== "p/judge",
    )) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel).toBeUndefined();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      seen.push(model);
      return okResponse(`ans-${model}`);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" },
        ],
        tools: [{ type: "function" }],
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([, , isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("appends the judge turn to Responses string input instead of messages", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });
    await handleFusionChat({
      body: { input: "what is 2+2?" },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // String input: judge prompt must live in input (translator ignores messages when input is set).
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    expect(Array.isArray(judgeCall[0].input)).toBe(true);
    expect(judgeCall[0].input.length).toBe(2);
    expect(judgeCall[0].input[0]).toEqual({ role: "user", content: "what is 2+2?" });
    expect(judgeCall[0].input[1].content).toContain("Source 1");
    expect(judgeCall[0].input[1].content).toContain("ans-p/a");
    expect(judgeCall[0].messages).toBeUndefined();
  });

  it("flattens Responses array input tool items into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        input: [
          { role: "user", content: "find files" },
          { type: "function_call", call_id: "c1", name: "find", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "['a.js']" },
          { type: "function_call", call_id: "c2", name: "read", arguments: "{}" },
          {
            type: "function_call_output",
            call_id: "c2",
            output: [{ type: "input_text", text: "file body" }],
          },
        ],
        tools: [{ type: "function", name: "find" }],
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([, , isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.input.some((i) => i.type === "function_call")).toBe(false);
      expect(panelBody.input.some((i) => i.type === "function_call_output")).toBe(false);
      expect(panelBody.input[2].content).toContain("['a.js']");
      expect(panelBody.input.at(-1).content).toBe("[Tool result: file body]");
    }
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "ok" },
              { type: "tool_use", id: "t1", name: "run" },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
        ],
        tools: [{ name: "run", description: "d" }],
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([, , isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];

    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);

    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");

    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });
  it("falls back to the first panel model when the judge JSON is empty", async () => {
    const body = { messages: [{ role: "user", content: "Q" }], stream: true };
    const handleSingleModel = vi.fn(async (requestBody, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      if (model === "p/judge") return jsonResponse({ choices: [{ message: { content: "" } }] });
      expect(model).toBe("p/a");
      // YAN-1030: the fallback gets a structuredClone of the body (chatCore mutates
      // bodies in place), so assert content equality, not identity.
      expect(requestBody).toEqual(body);
      return okResponse("FALLBACK");
    });

    const res = await handleFusionChat({
      body,
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(await res.json()).toEqual({
      choices: [{ message: { role: "assistant", content: "FALLBACK" } }],
    });
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([
      "p/a",
      "p/b",
      "p/judge",
      "p/a",
    ]);
  });

  it("falls back when the judge stream has only role, finish, and DONE frames", async () => {
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      if (model === "p/judge") {
        return sseResponse(
          sseFrame({ role: "assistant" }) +
            sseFrame({}, { finish_reason: "stop" }) +
            "data: [DONE]\n\n",
        );
      }
      return okResponse("FALLBACK");
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect((await res.json()).choices[0].message.content).toBe("FALLBACK");
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
  });

  it("returns 502 when the judge and direct fallback are both empty", async () => {
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({ choices: [{ message: { content: "" } }] });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { message: "Fusion judge and fallback returned an empty response" },
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
  });

  it("returns 502 when the single-survivor direct answer is empty", async () => {
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return model === "p/a" ? okResponse("ans") : errResponse(500);
      return jsonResponse({ choices: [{ message: { content: "" } }] });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "Fusion answer was empty" } });
  });

  it("serves a tool-call-only judge JSON answer as-is", async () => {
    const toolCall = {
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: "{}" },
    };
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({ choices: [{ message: { content: "", tool_calls: [toolCall] } }] });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect((await res.json()).choices[0].message.tool_calls).toEqual([toolCall]);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("replays a non-empty judge stream byte-for-byte", async () => {
    const raw =
      sseFrame({ role: "assistant" }) + sseFrame({ content: "FINAL" }) + "data: [DONE]\n\n";
    const handleSingleModel = vi.fn(async (_body, _model, isPanel) => {
      return isPanel ? okResponse("panel answer") : sseResponse(raw);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });

    expect(await res.text()).toBe(raw);
  });

  // YAN-1030 finding 2: non-text JSON outputs are answers, not "empty".
  it("serves an image-only judge answer instead of falling back to a 502", async () => {
    const images = [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }];
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({ choices: [{ message: { content: "", images } }] });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "draw" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.images).toEqual(images);
    // panel + judge only: no fallback call.
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("serves an audio-only judge answer instead of falling back to a 502", async () => {
    const audio = { id: "a1", data: "UklGRg==", transcript: "" };
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({ choices: [{ message: { content: null, audio } }] });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "say hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.audio).toEqual(audio);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("serves a Responses image_generation_call judge answer", async () => {
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({
        output: [{ type: "reasoning" }, { type: "image_generation_call", result: "b64" }],
      });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "draw" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("serves a Claude server_tool_use-only judge answer", async () => {
    const content = [
      { type: "thinking", thinking: "hm" },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { q: "x" } },
    ];
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return jsonResponse({ content });
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  // YAN-1030: the served-stream probe releases on the first meaningful token
  // (reasoning included), so a reasoning-only judge is served, not held or retried.
  it("serves a judge stream with only reasoning frames (no fallback call)", async () => {
    const raw =
      sseFrame({ reasoning_content: "let me think" }) +
      sseFrame({ reasoning_content: " more" }) +
      "data: [DONE]\n\n";
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return sseResponse(raw);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect(await res.text()).toBe(raw);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  // YAN-1030: reasoning is not answer text.
  it.each([
    [
      "Gemini thought-only",
      { candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] },
    ],
    [
      "Responses reasoning-only",
      {
        output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] }],
      },
    ],
  ])("%s judge JSON is empty, so the fallback runs", async (_label, emptyJson) => {
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      return model === "p/judge" ? jsonResponse(emptyJson) : okResponse("FALLBACK");
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    expect((await res.json()).choices[0].message.content).toBe("FALLBACK");
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
  });

  it("returns 502 when the single-model direct answer is Gemini thought-only", async () => {
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/only"],
      handleSingleModel: vi.fn(async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: "t", thought: true }] } }] }),
      ),
      log,
    });
    expect(res.status).toBe(502);
  });

  // YAN-1030: client abort while the judge stream probe is pending.
  it("returns 499 and makes no fallback call when the client aborts mid-probe", async () => {
    const ctrl = new AbortController();
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      // Judge stream that never produces a frame, so the probe stays pending.
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const pending = handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      clientSignal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 20);
    const res = await pending;

    expect(res.status).toBe(499);
    // 2 panel calls + the judge; no fallback.
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("closes the scope and propagates when a served call throws", async () => {
    const boom = new Error("judge exploded");
    const handleSingleModel = vi.fn(async (_body, model, isPanel) => {
      if (isPanel) return okResponse(`ans-${model}`);
      throw boom;
    });

    await expect(
      handleFusionChat({
        body: { messages: [{ role: "user", content: "Q" }] },
        models: ["p/a", "p/b"],
        handleSingleModel,
        log,
        judgeModel: "p/judge",
      }),
    ).rejects.toBe(boom);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("serves a judge stream that reasons first then answers, byte-identical", async () => {
    const raw =
      sseFrame({ reasoning_content: "hmm" }) + sseFrame({ content: "FINAL" }) + "data: [DONE]\n\n";
    const handleSingleModel = vi.fn(async (_body, _model, isPanel) => {
      return isPanel ? okResponse("panel answer") : sseResponse(raw);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });

    expect(await res.text()).toBe(raw);
  });
});
