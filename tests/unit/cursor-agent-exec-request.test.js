import { describe, it, expect, vi } from "vitest";

import { buildAgentRunFrame, CursorExecutor } from "../../open-sse/executors/cursor.js";
import { AGENT_ENVIRONMENT_NOTE } from "../../open-sse/utils/cursorAgentExec.js";
import {
  decodeMessage,
  encodeField,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";
import { UPSTREAM_CLIENT_IDS } from "@/shared/brand";

const VARINT = 0;
const LEN = 2;

// agent.v1.AgentServerMessage.exec_request (field 2) carrying an ExecServerMessage in
// the server's ascending field order: 1 id, <variant>, 15 exec_id, 19 span_context,
// 55 accept_hook_additional_contexts. `variantField: null` sends the envelope only.
function execFrame(
  variantField,
  { id = 7, execId = "exec-1", envelope = true, args = new Uint8Array() } = {},
) {
  const fields = [];
  if (variantField != null) fields.push([variantField, encodeField(variantField, LEN, args)]);
  if (envelope) {
    fields.push(
      [1, encodeField(1, VARINT, id)],
      [15, encodeField(15, LEN, execId)],
      [19, encodeField(19, LEN, encodeField(1, LEN, "trace"))],
      [55, encodeField(55, VARINT, 1)],
    );
  }
  fields.sort((a, b) => a[0] - b[0]);
  const execServerMessage = Buffer.concat(fields.map(([, bytes]) => Buffer.from(bytes)));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

// Written AgentClientMessage frame → decoded ExecClientMessage (field 2).
function decodeReply(frame) {
  const clientMessage = decodeMessage(frame.subarray(5));
  return decodeMessage(clientMessage.get(2)[0].value);
}

const sub = (fields, field) => decodeMessage(fields.get(field)[0].value);
const str = (fields, field) => Buffer.from(fields.get(field)[0].value).toString("utf8");
const contentOf = (events) => events.map((e) => e.choices?.[0]?.delta?.content || "").join("");

// agent.v1.AgentServerMessage.interaction_update (field 1) → text delta.
function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// InteractionUpdate.thinking_delta (field 4) + turn_ended (field 14).
function thinkingFrame(text) {
  const thinkingPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(4, LEN, thinkingPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function turnEndedFrame() {
  const update = Buffer.from(encodeField(14, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

// Connect end-of-stream trailer (flag 0x02) with a JSON error body.
function trailerErrorFrame(error) {
  const payload = Buffer.from(JSON.stringify({ error }));
  const header = Buffer.alloc(5);
  header[0] = 0x02;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function stubAgentSession(executor, frames, { readError, session = {} } = {}) {
  const written = [];
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {
      session.closed = true;
    },
    async read() {
      if (!queue.length && readError) throw readError;
      if (!queue.length) return { value: undefined, done: true };
      return { value: queue.shift(), done: false };
    },
  });
  return written;
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function runAgent({ frames, stream, model = "gpt-5.2", tools }) {
  const executor = new CursorExecutor();
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model,
    body: { messages: [{ role: "user", content: "hi" }], ...(tools ? { tools } : {}) },
    stream,
    credentials,
  });
  return { result, written };
}

describe("CursorExecutor AgentService exec_request handling", () => {
  it("closes the h2 session when writing the run frame throws", async () => {
    const executor = new CursorExecutor();
    let closed = false;
    executor.openAgentHttp2Stream = () => ({
      responseHeaders: Promise.resolve({ ":status": 200 }),
      write() {
        throw new Error("write failed");
      },
      close() {
        closed = true;
      },
    });

    await expect(
      executor.executeAgent({
        model: "gpt-5.2",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials,
      }),
    ).rejects.toThrow("write failed");
    expect(closed).toBe(true);
  });

  it("propagates a mid-stream read failure instead of finishing the stream", async () => {
    const executor = new CursorExecutor();
    const session = {};
    stubAgentSession(executor, [textFrame("Partial answer")], {
      readError: new Error("ECONNRESET"),
      session,
    });
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });
    const reader = result.response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);

    expect(first).toContain("Partial answer");
    expect(parseSSE(first)[0].choices[0].finish_reason).toBeNull();
    await expect(reader.read()).rejects.toThrow("ECONNRESET");
    expect(session.closed).toBe(true);
  });

  it("returns a connection error for a non-streaming read failure", async () => {
    const executor = new CursorExecutor();
    stubAgentSession(executor, [textFrame("Partial answer")], {
      readError: new Error("ECONNRESET"),
    });
    const result = await executor.execute({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
    });

    expect(result.response.status).toBe(500);
    expect((await result.response.json()).error.type).toBe("connection_error");
  });

  it("acknowledges a request-context exec request without ending the turn", async () => {
    const { result, written } = await runAgent({
      frames: [execFrame(10, { envelope: false }), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2); // run frame + request-context reply
    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello");
  });

  it("does not echo client tools on the request_context ack", async () => {
    const { written, result } = await runAgent({
      tools: [{ function: { name: "read_file", parameters: { type: "object" } } }],
      frames: [execFrame(10, { envelope: false }), textFrame("hello")],
      stream: true,
    });

    expect(written.length).toBe(2);
    expect(written[1].toString("utf8")).not.toContain("read_file");
    const content = parseSSE(await result.response.text())
      .map((e) => e.choices?.[0]?.delta?.content || "")
      .join("");
    expect(content).toBe("hello");
  });

  it("does not render an unsupported exec request as assistant content", async () => {
    const { result, written } = await runAgent({
      frames: [textFrame("partial answer"), execFrame(2, { envelope: false }), textFrame(" more")],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer more");
    expect(events.some((e) => e.error)).toBe(false);
    expect(written.length).toBe(2); // run frame + IDE rejection
  });

  it("still emits later text after rejecting an IDE exec in the same read", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execFrame(2, { envelope: false }), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(parseSSE(body).some((e) => e.error)).toBe(false);
    expect(body).toContain("late");
  });

  it("fails a malformed exec request that carries no variant with a stable code", async () => {
    const { result } = await runAgent({
      frames: [execFrame(null)],
      stream: false,
    });

    expect(result.response.status).not.toBe(200);
    const payload = await result.response.json();
    expect(payload.error.code).toBe("cursor_unsupported_exec");
  });

  it("ends a streaming turn with the same code for a malformed exec request", async () => {
    const { result } = await runAgent({
      frames: [execFrame(null), textFrame("dropped")],
      stream: true,
    });

    const error = parseSSE(await result.response.text()).find((e) => e.error)?.error;
    expect(error?.code).toBe("cursor_unsupported_exec");
  });

  it.each([20, 23, 17, 24])(
    "answers exec variant %i and keeps streaming the turn",
    async (variant) => {
      const { result, written } = await runAgent({
        frames: [textFrame("a"), execFrame(variant), textFrame("b")],
        stream: true,
      });

      const events = parseSSE(await result.response.text());
      expect(events.some((e) => e.error)).toBe(false);
      expect(contentOf(events)).toBe("ab");
      expect(written.length).toBe(2);
      const reply = decodeReply(written[1]);
      expect(reply.get(1)[0].value).toBe(7);
      expect(str(reply, 15)).toBe("exec-1");
      expect(reply.has(variant)).toBe(true);
    },
  );

  it.each([20, 24])("answers exec variant %i when not streaming", async (variant) => {
    const { result, written } = await runAgent({
      frames: [textFrame("a"), execFrame(variant), textFrame("b")],
      stream: false,
    });

    expect(result.response.status).toBe(200);
    const payload = await result.response.json();
    expect(payload.choices[0].message.content).toBe("ab");
    expect(written.length).toBe(2);
  });

  it.each([
    // [args field, result field, oneof case, reason field]
    ["grep", 5, 5, 2, 1],
    ["read", 7, 7, 3, 2],
    ["shell", 2, 2, 4, 3],
  ])(
    "sends the proto-exact %s rejection with a reason",
    async (_name, variant, resultField, caseField, reasonField) => {
      const { written } = await runAgent({ frames: [execFrame(variant)], stream: true });

      const reply = decodeReply(written[1]);
      const payload = sub(sub(reply, resultField), caseField);
      expect(str(payload, reasonField).length).toBeGreaterThan(0);
    },
  );

  it("maps pi_read (45) onto result field 46", async () => {
    const { written } = await runAgent({ frames: [execFrame(45)], stream: true });

    const reply = decodeReply(written[1]);
    expect(reply.has(46)).toBe(true);
    expect(reply.has(45)).toBe(false);
  });

  it("answers mcp_state (36) with the declared tools and keeps streaming", async () => {
    const { result, written } = await runAgent({
      tools: [
        {
          type: "function",
          function: { name: "read_file", description: "Read", parameters: { type: "object" } },
        },
      ],
      frames: [
        execFrame(36, { args: encodeField(1, LEN, UPSTREAM_CLIENT_IDS.cursorMcpProvider) }),
        textFrame("later"),
      ],
      stream: true,
    });

    expect(contentOf(parseSSE(await result.response.text()))).toBe("later");
    const server = sub(sub(sub(decodeReply(written[1]), 36), 1), 1);
    expect(str(server, 2)).toBe(UPSTREAM_CLIENT_IDS.cursorMcpProvider);
    expect(server.has(5)).toBe(true);
    expect(str(sub(server, 5), 1)).toBe("read_file");
  });

  it("answers an MCP exec without a tool name and keeps streaming", async () => {
    const { result, written } = await runAgent({
      frames: [execFrame(11), textFrame("ok")],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    expect(events.some((e) => e.error)).toBe(false);
    expect(contentOf(events)).toBe("ok");
    expect(written.length).toBe(2);
    // McpResult.error (2) → McpError.error (1).
    expect(str(sub(sub(decodeReply(written[1]), 11), 2), 1)).toContain("missing a tool name");
  });

  it("warns with the variant number for an unknown exec variant", async () => {
    const executor = new CursorExecutor();
    const written = stubAgentSession(executor, [execFrame(24), textFrame("ok")]);
    const log = { info: vi.fn(), warn: vi.fn() };

    await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith("CURSOR", expect.stringContaining("variant=24"));
    // Unknown result shape → empty result, which always parses upstream.
    expect(decodeReply(written[1]).get(24)[0].value.length).toBe(0);
  });

  it("folds the environment note into the run frame user text", () => {
    const frame = buildAgentRunFrame(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      "gpt-5.2",
    );

    expect(Buffer.from(frame).toString("utf8")).toContain(AGENT_ENVIRONMENT_NOTE);
  });

  it("streams Composer visible content from thinking_delta after </think>", async () => {
    const { result } = await runAgent({
      model: "composer-2.5",
      frames: [thinkingFrame("private reasoning that must not leak</think>OK"), turnEndedFrame()],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("OK");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("flushes Grok thinking as visible content when the turn has no text_delta", async () => {
    const { result } = await runAgent({
      model: "grok-4.5",
      frames: [thinkingFrame("hello from grok"), turnEndedFrame()],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello from grok");
  });

  it("maps a Connect trailer Update Required to an account-neutral 400", async () => {
    const { result } = await runAgent({
      frames: [
        trailerErrorFrame({
          code: "resource_exhausted",
          details: [
            {
              debug: {
                error: "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
                details: { title: "Update Required" },
              },
            },
          ],
        }),
      ],
      stream: false,
    });

    expect(result.response.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.code).toBe("cursor_client_update_required");
  });

  it("keeps genuine Connect trailer quota errors on 429", async () => {
    const { result } = await runAgent({
      frames: [trailerErrorFrame({ code: "resource_exhausted", message: "quota" })],
      stream: false,
    });

    expect(result.response.status).toBe(429);
  });

  it("does not treat thinking as visible output for non-Composer models when text_delta exists", async () => {
    const { result } = await runAgent({
      model: "gpt-5.3-codex",
      frames: [
        thinkingFrame("private reasoning</think>SHOULD_NOT_APPEAR"),
        textFrame("reply OK"),
        turnEndedFrame(),
      ],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("reply OK");
    expect(content).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("keeps Composer visible content only after </think> across split thinking frames", async () => {
    const { result } = await runAgent({
      model: "composer-2.5-fast",
      frames: [
        thinkingFrame("private reasoning"),
        thinkingFrame(" that must not leak</think>O"),
        thinkingFrame("K"),
        turnEndedFrame(),
      ],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("OK");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });
});
