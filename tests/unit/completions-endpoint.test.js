import { describe, expect, it, vi } from "vitest";
import { detectFormatByEndpoint, FORMATS } from "../../open-sse/translator/formats.js";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn(async () => new Response("{}")) }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));

const { POST, OPTIONS } = await import("../../src/app/api/v1/completions/route.js");

describe("/v1/completions route", () => {
  it("delegates POST to handleChat", async () => {
    const req = new Request("https://router.test/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", prompt: "x" }),
    });
    await POST(req);
    expect(mocks.handleChat).toHaveBeenCalledWith(req);
  });

  it("answers OPTIONS with CORS headers", async () => {
    const res = await OPTIONS();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("detects openai-completions only on the exact path", () => {
    expect(detectFormatByEndpoint("/v1/completions", {})).toBe(FORMATS.OPENAI_COMPLETIONS);
    expect(detectFormatByEndpoint("/api/v1/completions", {})).toBe(FORMATS.OPENAI_COMPLETIONS);
    expect(detectFormatByEndpoint("/v1/completions/", {})).toBe(FORMATS.OPENAI_COMPLETIONS);
    expect(detectFormatByEndpoint("/v1/chat/completions", {})).not.toBe(FORMATS.OPENAI_COMPLETIONS);
  });
});
