import { describe, it, expect, vi } from "vitest";
import {
  parseCommandCodeError,
  inspectAndWrapCommandCodeResponse,
  CommandCodeExecutor,
} from "../../open-sse/executors/commandcode.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

function createNdjsonStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(
          encoder.encode(typeof line === "string" ? line : JSON.stringify(line) + "\n"),
        );
      }
      controller.close();
    },
  });
}

describe("parseCommandCodeError", () => {
  it("parses user exact error payload with statusCode 503 and isRetryable", () => {
    const event = {
      type: "error",
      error: {
        type: "server_error",
        message: "Service temporarily unavailable. Please try again shortly.",
        statusCode: 503,
        isRetryable: true,
      },
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(503);
    expect(parsed.message).toBe("Service temporarily unavailable. Please try again shortly.");
    expect(parsed.type).toBe("server_error");
  });

  it("handles string error message", () => {
    const event = {
      type: "error",
      message: "Rate limit exceeded. Please wait 30s.",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.message).toBe("Rate limit exceeded. Please wait 30s.");
  });

  it("handles plain error string in error property", () => {
    const event = {
      type: "error",
      error: "Unauthorized access",
    };
    const parsed = parseCommandCodeError(event);
    expect(parsed.statusCode).toBe(401);
    expect(parsed.message).toBe("Unauthorized access");
  });
});

describe("inspectAndWrapCommandCodeResponse", () => {
  it("converts initial upstream 200 with error event to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(
      fakeResponse,
      "poolside/laguna-s-2.1-free",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);

    const body = await result.json();
    expect(body.error.message).toContain("Service temporarily unavailable");
    expect(body.error.code).toBe(503);
  });

  it("converts initial upstream 200 with start/start-step followed by error to 503 Response", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "start-step" }) + "\n",
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: "Service temporarily unavailable. Please try again shortly.",
          statusCode: 503,
          isRetryable: true,
        },
      }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(
      fakeResponse,
      "poolside/laguna-s-2.1-free",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);

    const body = await result.json();
    expect(body.error.message).toContain("Service temporarily unavailable");
  });

  it("replays every NDJSON line when the whole answer arrives in one chunk", async () => {
    const chunk = [
      { type: "start" },
      { type: "text-start" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "text-end" },
      {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      { type: "finish" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const fakeResponse = new Response(createNdjsonStream([`${chunk}\n`]), { status: 200 });

    const text = await (await inspectAndWrapCommandCodeResponse(fakeResponse, "m")).text();
    const contents = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    const content = contents.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("Hello world");
    expect(contents.some((c) => c.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(contents.some((c) => c.usage)).toBe(true);
  });

  it("replays a multi-byte UTF-8 character split across the stop-loop chunk boundary intact", async () => {
    // The peek loop stops on the first text-delta line; the chunk must end
    // inside the 3-byte character 世 so the raw tail bytes are still undecoded.
    const full = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "text-delta", text: "A" }),
      JSON.stringify({ type: "text-delta", text: "世界" }),
      JSON.stringify({ type: "finish" }),
    ]
      .join("\n")
      .concat("\n");
    const bytes = new TextEncoder().encode(full);
    const splitAt = bytes.indexOf(0xe4) + 1; // first byte of 世
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, splitAt));
        controller.enqueue(bytes.subarray(splitAt));
        controller.close();
      },
    });

    const result = await inspectAndWrapCommandCodeResponse(
      new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      "poolside/laguna-s-2.1-free",
    );

    const text = await result.text();
    const content = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)))
      .map((c) => c.choices?.[0]?.delta?.content || "")
      .join("");
    expect(content).toBe("A世界");
    expect(text).not.toContain("\uFFFD");
  });

  it("streams successful responses when content is emitted", async () => {
    const ndjsonBody = createNdjsonStream([
      JSON.stringify({ type: "start" }) + "\n",
      JSON.stringify({ type: "text-delta", text: "Hello from Laguna" }) + "\n",
      JSON.stringify({ type: "finish" }) + "\n",
    ]);

    const fakeResponse = new Response(ndjsonBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await inspectAndWrapCommandCodeResponse(
      fakeResponse,
      "poolside/laguna-s-2.1-free",
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    const text = await result.text();
    expect(text).toContain("Hello from Laguna");
    expect(text).toContain("data: [DONE]");
  });

  it("retries when initial stream yields an error and succeeds on second attempt", async () => {
    let callCount = 0;
    const executor = new CommandCodeExecutor();

    // Override execute on instance to test retry behavior
    executor.execute = async (opts) => {
      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        callCount++;
        let rawResponse;
        if (callCount === 1) {
          rawResponse = new Response(
            createNdjsonStream([
              JSON.stringify({
                type: "error",
                error: { type: "server_error", message: "Network connection lost." },
              }) + "\n",
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        } else {
          rawResponse = new Response(
            createNdjsonStream([
              JSON.stringify({ type: "start" }) + "\n",
              JSON.stringify({ type: "text-delta", text: "Recovered from lost connection" }) + "\n",
              JSON.stringify({ type: "finish" }) + "\n",
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }

        const wrappedResponse = await inspectAndWrapCommandCodeResponse(rawResponse, opts.model);
        if (!wrappedResponse.ok && attempt < maxRetries) {
          continue;
        }
        return { response: wrappedResponse };
      }
    };

    const res = await executor.execute({ model: "deepseek/deepseek-v4.1-flash" });
    expect(res.response.ok).toBe(true);
    expect(callCount).toBe(2);
    const text = await res.response.text();
    expect(text).toContain("Recovered from lost connection");
  });
});

describe("CommandCode in Combo Fallback", () => {
  it("automatically falls back to next model when commandcode returns 503 error", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const handleSingleModel = vi.fn(async (body, modelStr) => {
      if (modelStr === "commandcode/poolside/laguna-s-2.1-free") {
        // Simulated failed CommandCode response
        return new Response(
          JSON.stringify({
            error: {
              message: "Service temporarily unavailable. Please try again shortly.",
              type: "server_error",
              code: 503,
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      if (modelStr === "openai/gpt-4o-mini") {
        // Fallback model succeeds
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "Fallback success!" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    });

    const comboResponse = await handleComboChat({
      body: { messages: [{ role: "user", content: "Hello" }] },
      models: ["commandcode/poolside/laguna-s-2.1-free", "openai/gpt-4o-mini"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(comboResponse.ok).toBe(true);
    expect(comboResponse.status).toBe(200);

    const data = await comboResponse.json();
    expect(data.choices[0].message.content).toBe("Fallback success!");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "commandcode/poolside/laguna-s-2.1-free",
    );
    expect(handleSingleModel).toHaveBeenNthCalledWith(2, expect.anything(), "openai/gpt-4o-mini");
  });
});
