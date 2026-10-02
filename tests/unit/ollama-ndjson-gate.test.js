import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

// Ollama /api/chat streams NDJSON (application/x-ndjson), one JSON object per
// line. The streaming handler's content-type gate used to block it as non-SSE.
const ndjsonResponse = (lines) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );

async function run(providerResponse) {
  let streamError = null;
  const result = await handleStreamingResponse({
    providerResponse,
    provider: "ollama",
    model: "llama3.2",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OLLAMA,
    userAgent: "",
    reqLogger: null,
    toolNameMap: null,
    customToolNames: null,
    body: { messages: [], model: "llama3.2", stream: true },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "test-conn",
    apiKey: null,
    clientRawRequest: null,
    onRequestSuccess: null,
    pxpipe: null,
    savings: null,
    comboName: null,
    reqTag: "TEST",
    log: null,
    streamController: {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleError: (error) => {
        streamError = error;
      },
      handleComplete: () => {},
      isCancelled: () => false,
    },
    onStreamComplete: () => {},
    streamDetailId: null,
    credentials: null,
  });

  const text = result.response.body ? await result.response.text() : "";
  return { result, text, streamError };
}

describe("streaming handler NDJSON gate (YAN-654)", () => {
  it("lets application/x-ndjson through for the ollama target format", async () => {
    const { result, text, streamError } = await run(
      ndjsonResponse([
        { model: "llama3.2", message: { role: "assistant", content: "hel" }, done: false },
        { model: "llama3.2", message: { role: "assistant", content: "lo" }, done: false },
        { model: "llama3.2", message: { role: "assistant", content: "" }, done: true },
      ]),
    );

    expect(streamError).toBeNull();
    expect(result.success).not.toBe(false);
    expect(text).toContain("hel");
    expect(text).toContain("lo");
  });

  it("still blocks non-SSE content types for non-ollama target formats", async () => {
    const { result, streamError } = await run(
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    expect(streamError).not.toBeNull();
    expect(result.success).toBe(false);
  });
});
