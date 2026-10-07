import { describe, expect, it, vi } from "vitest";
import { detectFormatByEndpoint, FORMATS } from "../../open-sse/translator/formats.js";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn(async () => new Response("{}")) }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));

const { POST, OPTIONS } = await import("../../src/app/api/v1/completions/route.js");
const fimRoute = await import("../../src/app/api/v1/fim/completions/route.js");
const infillRoute = await import("../../src/app/api/v1/infill/route.js");

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

describe("FIM editor endpoints", () => {
  for (const [name, route, url] of [
    ["/v1/fim/completions", fimRoute, "https://router.test/v1/fim/completions"],
    ["/infill", infillRoute, "https://router.test/infill"],
  ]) {
    it(`${name}: delegates POST to handleChat`, async () => {
      mocks.handleChat.mockClear();
      const req = new Request(url, { method: "POST", body: JSON.stringify({ model: "m" }) });
      await route.POST(req);
      expect(mocks.handleChat).toHaveBeenCalledWith(req);
    });

    it(`${name}: answers OPTIONS with CORS headers`, async () => {
      const res = await route.OPTIONS();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  }

  it("detects codestral-fim only on the exact FIM path", () => {
    expect(detectFormatByEndpoint("/v1/fim/completions", {})).toBe(FORMATS.CODESTRAL_FIM);
    expect(detectFormatByEndpoint("/api/v1/fim/completions", {})).toBe(FORMATS.CODESTRAL_FIM);
    expect(detectFormatByEndpoint("/v1/chat/completions", {})).not.toBe(FORMATS.CODESTRAL_FIM);
  });

  it("detects llamacpp-infill on /infill and the rewritten path", () => {
    expect(detectFormatByEndpoint("/infill", {})).toBe(FORMATS.LLAMACPP_INFILL);
    expect(detectFormatByEndpoint("/api/v1/infill", {})).toBe(FORMATS.LLAMACPP_INFILL);
    expect(detectFormatByEndpoint("/v1/chat/completions", {})).not.toBe(FORMATS.LLAMACPP_INFILL);
  });
});
