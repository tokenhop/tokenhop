import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

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
