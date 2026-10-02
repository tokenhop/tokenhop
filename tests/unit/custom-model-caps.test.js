// YAN-657: capability toggles saved with a custom model drive routing and
// media stripping, overriding the pattern table (e.g. *qwen* text-only).
import { describe, it, expect, afterEach } from "vitest";
import { getCapabilitiesForModel, setCustomCapsSource } from "open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "open-sse/translator/concerns/modality.js";
import { FORMATS } from "open-sse/translator/formats.js";

afterEach(() => setCustomCapsSource(null));

describe("custom model capabilities (YAN-657)", () => {
  it("declared caps win over patterns, both ways", () => {
    const provider = "openai-compatible-local";
    expect(getCapabilitiesForModel(provider, "qwen3.8-27b").vision).toBe(false);
    setCustomCapsSource(new Map([[`${provider}|qwen3.8-27b`, { vision: true, pdf: false }]]));
    const caps = getCapabilitiesForModel(provider, "qwen3.8-27b");
    expect(caps.vision).toBe(true);
    expect(caps.pdf).toBe(false);
    // Other models and providers are untouched
    expect(getCapabilitiesForModel("other", "qwen3.8-27b").vision).toBe(false);
  });

  it("keeps the image for a vision-declared custom model", () => {
    const provider = "openai-compatible-local";
    setCustomCapsSource(new Map([[`${provider}|qwen3.8-27b`, { vision: true }]]));
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
    };
    const caps = getCapabilitiesForModel(provider, "qwen3.8-27b");
    stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
    expect(body.messages[0].content[0].type).toBe("image_url");
  });
});
