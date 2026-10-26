/**
 * Unit tests for image generation handler
 *
 * Covers:
 *  - OpenAI-compatible format (openai, minimax, openrouter)
 *  - Gemini format (generateContent API)
 *  - Provider-specific formats (nanobanana, sdwebui)
 *  - Response normalization to OpenAI format
 *  - Error handling (missing prompt, invalid model)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Cloudflare input image URLs are DNS-validated before fetching.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

// Upstream calls go through proxyAwareFetch, which captures the real fetch at import.
// Delegate to the per-test global fetch stub instead.
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/codexCliFingerprint.js";
import { MAX_IMAGE_BYTES } from "../../open-sse/config/mediaConfig.js";

const originalFetch = global.fetch;

describe("handleImageGenerationCore", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("validates required prompt field", async () => {
    const result = await handleImageGenerationCore({
      body: { model: "openai/dall-e-3" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: prompt");
  });

  it("rejects unsupported provider", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "unknown-provider", model: "test" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support image generation");
  });

  it("generates image with OpenAI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A cute cat", n: 1, size: "1024x1024" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
        body: expect.stringContaining('"prompt":"A cute cat"'),
      }),
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].url).toBe("https://example.com/image.png");
  });

  it("generates image with Gemini format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Generated image" }, { inlineData: { data: "base64imagedata" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A sunset" },
      modelInfo: { provider: "gemini", model: "gemini-image-preview" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"responseModalities":["TEXT","IMAGE"]'),
      }),
    );

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(1);
    expect(responseBody.data[0].b64_json).toBe("base64imagedata");
  });

  it("generates image with Minimax format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/minimax.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain", size: "1024x1024" },
      modelInfo: { provider: "minimax", model: "minimax-image-01" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("generates image with NanoBanana format", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { taskId: "task-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              successFlag: 1,
              response: { resultImageUrl: "https://example.com/nanobanana.png" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const pending = handleImageGenerationCore({
      body: { prompt: "A robot", n: 2, size: "1024x1792" },
      modelInfo: { provider: "nanobanana", model: "nanobanana-flash" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.type).toBe("TEXTTOIAMGE");
    expect(requestBody.numImages).toBe(2);
    expect(requestBody.image_size).toBe("9:16");
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.nanobananaapi.ai/api/v1/nanobanana/record-info?taskId=task-123",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );

    const responseBody = await result.response.json();
    expect(responseBody.data[0].url).toBe("https://example.com/nanobanana.png");
  });

  it("generates image with SD WebUI format", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ images: ["base64sdwebui1", "base64sdwebui2"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A forest", size: "768x768", n: 2 },
      modelInfo: { provider: "sdwebui", model: "sdxl-base-1.0" },
      credentials: null,
      log: null,
    });

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.width).toBe(768);
    expect(requestBody.height).toBe(768);
    expect(requestBody.batch_size).toBe(2);

    const responseBody = await result.response.json();
    expect(responseBody.data).toHaveLength(2);
  });

  it("handles OpenRouter with HTTP-Referer header", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/or.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A city" },
      modelInfo: { provider: "openrouter", model: "openai/dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({
          "HTTP-Referer": "https://endpoint-proxy.local",
          "X-Title": "Endpoint Proxy",
        }),
      }),
    );
  });

  it("handles Vercel AI Gateway image generation as OpenAI-compatible", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/vercel-image.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A watercolor castle", n: 1, size: "1024x1024" },
      modelInfo: { provider: "vercel-ai-gateway", model: "openai/gpt-image-1" },
      credentials: { apiKey: "vag-test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer vag-test-key",
        }),
        body: expect.stringContaining('"model":"openai/gpt-image-1"'),
      }),
    );
  });

  it("handles HuggingFace binary response", async () => {
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    global.fetch.mockResolvedValueOnce(
      new Response(imageBuffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A tree" },
      modelInfo: { provider: "huggingface", model: "black-forest-labs/FLUX.1-schnell" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBeTruthy();
  });

  it.each(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "generates image with Codex %s-image using current Codex version header",
    async (model) => {
      global.fetch.mockResolvedValueOnce(
        new Response(
          [
            "event: response.output_item.done",
            'data: {"item":{"type":"image_generation_call","result":"base64codeximage"}}',
            "",
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );

      const result = await handleImageGenerationCore({
        body: {
          prompt: "A green square",
          size: "1024x1024",
          output_format: "png",
        },
        modelInfo: { provider: "codex", model: `${model}-image` },
        credentials: {
          accessToken: "codex-token",
          providerSpecificData: { chatgptAccountId: "account-123" },
        },
        log: null,
      });

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/codex/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer codex-token",
            "chatgpt-account-id": "account-123",
            version: CODEX_CLI_VERSION,
          }),
        }),
      );

      const fetchCall = global.fetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);
      expect(requestBody.model).toBe(model);
      expect(requestBody.tools).toEqual([
        { type: "image_generation", output_format: "png", size: "1024x1024" },
      ]);

      const responseBody = await result.response.json();
      expect(responseBody.data[0].b64_json).toBe("base64codeximage");
    },
  );

  it("generates image with Codex gpt-image-2.5 tool model", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        [
          "event: response.output_item.done",
          'data: {"item":{"type":"image_generation_call","result":"base64codeximage"}}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A futuristic city",
        size: "1024x1024",
        output_format: "png",
      },
      modelInfo: { provider: "codex", model: "gpt-image-2.5" },
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { chatgptAccountId: "account-123" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.tools).toEqual([
      {
        type: "image_generation",
        output_format: "png",
        size: "1024x1024",
        action: "generate",
        model: "gpt-image-2.5",
      },
    ]);
    expect(requestBody.tool_choice).toEqual({ type: "image_generation" });
    expect(requestBody.reasoning).toEqual({ effort: "medium", summary: "auto" });

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64codeximage");
  });

  it("generates image with Cloudflare Workers AI JSON response", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64cloudflare" },
          success: true,
          errors: [],
          messages: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A lighthouse", size: "1024x1536" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/leonardo/lucid-origin" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/leonardo/lucid-origin",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer cf-token",
        }),
      }),
    );

    const fetchCall = global.fetch.mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.prompt).toBe("A lighthouse");
    expect(requestBody.width).toBe(1024);
    expect(requestBody.height).toBe(1536);

    const responseBody = await result.response.json();
    expect(responseBody.data[0].b64_json).toBe("base64cloudflare");
  });

  it("uses multipart form data for Cloudflare FLUX.2 models", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { image: "base64flux2" },
          success: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "A mountain lake", size: "1792x1024", steps: 4 },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);

    const fetchCall = global.fetch.mock.calls[0];
    expect(fetchCall[1].headers).not.toHaveProperty("Content-Type");
    expect(fetchCall[1].body).toBeInstanceOf(FormData);
    expect(fetchCall[1].body.get("prompt")).toBe("A mountain lake");
    expect(fetchCall[1].body.get("width")).toBe("1792");
    expect(fetchCall[1].body.get("height")).toBe("1024");
    expect(fetchCall[1].body.get("steps")).toBe("4");
  });

  it("resolves Cloudflare img2img and inpainting URL inputs before sending", async () => {
    const PNG_1 = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([1, 2, 3]),
    ]);
    const PNG_2 = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([4, 5, 6]),
    ]);
    global.fetch
      .mockResolvedValueOnce(
        new Response(PNG_1, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG_2, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { image: "base64inpaint" }, success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "Change to a lion",
        image: "https://example.com/source.png",
        mask_image: "https://example.com/mask.png",
        size: "512x512",
      },
      modelInfo: {
        provider: "cloudflare-ai",
        model: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
      },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { accountId: "cf-account" },
      },
      log: null,
    });

    expect(result.success).toBe(true);
    // The hardened fetcher pins DNS via an undici dispatcher on the direct path.
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/source.png",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/mask.png",
      expect.objectContaining({ redirect: "manual" }),
    );

    const providerCall = global.fetch.mock.calls[2];
    expect(providerCall[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/@cf/runwayml/stable-diffusion-v1-5-inpainting",
    );
    const requestBody = JSON.parse(providerCall[1].body);
    expect(requestBody.image_b64).toBe(PNG_1.toString("base64"));
    expect(requestBody.image).toEqual(Array.from(PNG_1));
    expect(requestBody.mask_b64).toBe(PNG_2.toString("base64"));
    expect(requestBody.mask).toEqual(Array.from(PNG_2));
    expect(requestBody.mask_image).toEqual(Array.from(PNG_2));
  });

  it("handles provider error responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("handles network errors", async () => {
    global.fetch.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Network timeout");
  });

  it("calls onRequestSuccess callback on success", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1234567890,
          data: [{ url: "https://example.com/success.png" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "test-key" },
      log: null,
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });
});

// YAN-1595: provider-returned image URLs are fetched through the hardened
// fetcher before inlining; any refusal falls back to returning the URL.
describe("binary output with a provider-returned URL", () => {
  const IMAGE_URL = "https://cdn.example/i.png";
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_BYTES = Buffer.from([...PNG_SIG, 1, 2, 3, 4]);
  const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  // imageResponse: a Response for the image fetch, or an implementation for every later fetch.
  const generate = (imageResponse) => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 1, data: [{ url: IMAGE_URL }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    if (typeof imageResponse === "function") global.fetch.mockImplementation(imageResponse);
    else if (imageResponse) global.fetch.mockResolvedValueOnce(imageResponse);
    return handleImageGenerationCore({
      body: { prompt: "a cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-x" },
      log: null,
      binaryOutput: true,
    });
  };

  const expectUrlFallback = async (result) => {
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("application/json");
    const responseBody = await result.response.json();
    expect(responseBody.data[0].url).toBe(IMAGE_URL);
  };

  beforeEach(() => {
    global.fetch = vi.fn();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("never fetches a URL resolving to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const result = await generate(new Response(PNG_BYTES, { status: 200 }));

    await expectUrlFallback(result);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not follow redirects", async () => {
    const metadataUrl = "http://169.254.169.254/x.png";
    // Behaves like real fetch: follows Location unless redirect is "manual".
    const result = await generate(async (url, options) => {
      if (url === metadataUrl) return new Response(PNG_BYTES, { status: 200 });
      if (options?.redirect !== "manual") return global.fetch(metadataUrl, options);
      return new Response(null, { status: 302, headers: { Location: metadataUrl } });
    });

    await expectUrlFallback(result);
    expect(global.fetch).toHaveBeenCalledWith(
      IMAGE_URL,
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(metadataUrl, expect.anything());
  });

  it("does not inline a non-image payload", async () => {
    const result = await generate(new Response(Buffer.from("<html>"), { status: 200 }));

    await expectUrlFallback(result);
  });

  it("does not inline an oversize image", async () => {
    const oversize = Buffer.concat([Buffer.from(PNG_SIG), Buffer.alloc(MAX_IMAGE_BYTES)]);

    const result = await generate(new Response(oversize, { status: 200 }));

    await expectUrlFallback(result);
  });

  it("inlines a verified image", async () => {
    const result = await generate(new Response(PNG_BYTES, { status: 200 }));

    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("labels the response from the detected image type", async () => {
    const result = await generate(new Response(JPEG_BYTES, { status: 200 }));

    expect(result.response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(result.response.headers.get("Content-Disposition")).toBe('inline; filename="image.jpg"');
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(JPEG_BYTES);
  });
});
