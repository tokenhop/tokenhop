import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

const originalFetch = global.fetch;

function audioResponse() {
  return new Response(new Uint8Array(256), { status: 200 });
}

function upstreamBody() {
  return JSON.parse(global.fetch.mock.calls[0][1].body);
}

describe("TTS OpenAI body fields (YAN-58)", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(audioResponse());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("openai/tts-1 with body voice and response_format reaches upstream as model, voice and codec", async () => {
    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1",
      input: "hi",
      credentials: { apiKey: "k" },
      voice: "nova",
      format: "wav",
    });
    expect(upstreamBody()).toEqual({
      model: "tts-1",
      voice: "nova",
      input: "hi",
      response_format: "wav",
    });
    expect(result.response.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("a voice in the model id wins over the body voice", async () => {
    await handleTtsCore({
      provider: "openai",
      model: "tts-1/shimmer",
      input: "hi",
      credentials: { apiKey: "k" },
      voice: "alloy",
    });
    expect(upstreamBody()).toMatchObject({
      model: "tts-1",
      voice: "shimmer",
      response_format: "mp3",
    });
  });

  it("a bare non-model value is still a voice", async () => {
    await handleTtsCore({
      provider: "openai",
      model: "nova",
      input: "hi",
      credentials: { apiKey: "k" },
    });
    expect(upstreamBody()).toMatchObject({ model: "gpt-4o-mini-tts", voice: "nova" });
  });

  it("selfhosted-tts sends the codec, not the json envelope, upstream", async () => {
    const result = await handleTtsCore({
      provider: "selfhosted-tts",
      model: "kokoro",
      input: "hi",
      credentials: { apiKey: "k", baseUrl: "http://tts.local" },
      responseFormat: "json",
      voice: "af_bella",
    });
    expect(upstreamBody()).toMatchObject({
      model: "kokoro",
      voice: "af_bella",
      response_format: "mp3",
    });
    expect(JSON.parse(await result.response.text()).format).toBe("mp3");
  });
});
