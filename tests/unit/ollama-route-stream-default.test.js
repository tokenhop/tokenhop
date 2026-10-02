// Ollama's API streams by default. The shared chat path (YAN-659) defaults a
// missing `stream` to false, so the /v1/api/chat route must make Ollama's
// default explicit before handing the request over (#676).
import { describe, it, expect, vi, beforeEach } from "vitest";

const forwarded = vi.hoisted(() => ({ body: null, headers: null }));
vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: vi.fn(async (req) => {
    forwarded.body = await req.clone().json();
    forwarded.headers = req.headers;
    return Response.json(
      {
        id: "chatcmpl-abcdefgh",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      },
      { headers: { "Content-Type": "application/json" } },
    );
  }),
}));

import { POST } from "@/app/api/v1/api/chat/route.js";

const post = (body) =>
  POST(
    new Request("http://localhost/v1/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  forwarded.body = null;
  forwarded.headers = null;
});

describe("/v1/api/chat stream default (#676)", () => {
  it("defaults a missing stream field to true", async () => {
    await post({ model: "llama3.2", messages: [{ role: "user", content: "hi" }] });
    expect(forwarded.body.stream).toBe(true);
  });

  it("keeps an explicit stream:false and stream:true", async () => {
    await post({ model: "llama3.2", stream: false, messages: [] });
    expect(forwarded.body.stream).toBe(false);
    await post({ model: "llama3.2", stream: true, messages: [] });
    expect(forwarded.body.stream).toBe(true);
  });

  it("still returns a single done:true Ollama JSON for the non-streaming response", async () => {
    const res = await post({ model: "llama3.2", stream: false, messages: [] });
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.message.role).toBe("assistant");
  });
});
