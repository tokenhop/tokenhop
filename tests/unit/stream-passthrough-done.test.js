import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  createPassthroughStreamWithLogger,
  createSSETransformStreamWithLogger,
} from "../../open-sse/utils/stream.js";

// YAN-82: passthrough forwarded upstream [DONE] and flush() appended another.
async function drain(input) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(createPassthroughStreamWithLogger("openai", null, "m", null, { messages: [] }))
    .getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let r = await reader.read(); !r.done; r = await reader.read())
    out += decoder.decode(r.value);
  return out;
}

const chunk = `data: ${JSON.stringify({ id: "chatcmpl-abcdefgh", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`;

describe("passthrough stream [DONE]", () => {
  it.each([
    ["newline-terminated", `${chunk}data: [DONE]\n\n`],
    ["no space after data:", `${chunk}data:[DONE]\n\n`],
    ["in the trailing buffer", `${chunk}data: [DONE]`],
    ["repeated upstream", `${chunk}data: [DONE]\n\ndata: [DONE]\n\ndata: [DONE]`],
    ["absent upstream", chunk],
  ])("emits exactly one [DONE] (%s)", async (_, input) => {
    expect((await drain(input)).match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("translated Claude stream ends with exactly one [DONE] for OpenAI Chat clients (YAN-652)", async () => {
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const claude =
      ev("message_start", {
        type: "message_start",
        message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 3, output_tokens: 0 } },
      }) +
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }) +
      ev("message_stop", { type: "message_stop" });
    const source = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(claude));
        c.close();
      },
    });
    const reader = source
      .pipeThrough(
        createSSETransformStreamWithLogger(
          FORMATS.CLAUDE,
          FORMATS.OPENAI,
          "claude",
          null,
          null,
          "m",
        ),
      )
      .getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (let r = await reader.read(); !r.done; r = await reader.read())
      out += decoder.decode(r.value);
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("strips an empty delta.role while keeping a valid role (YAN-676)", async () => {
    const make = (delta) =>
      `data: ${JSON.stringify({ id: "chatcmpl-abcdefgh", choices: [{ index: 0, delta }] })}\n\n`;
    const out = await drain(
      `${make({ role: "", content: "hi" })}${make({ role: "assistant", content: "ho" })}`,
    );
    expect(out).not.toContain('"role":""');
    expect(out).toContain('"role":"assistant"');
  });
});
