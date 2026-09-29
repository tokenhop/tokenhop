import { describe, expect, it } from "vitest";
import {
  buildTtsModelFull,
  buildTtsBody,
  buildTtsCurl,
  filterLanguages,
} from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/ttsExampleLogic.js";
import {
  buildGenericModelFull,
  buildExtraBody,
  buildGenericRequestBody,
  buildGenericCurl,
  parseSseBlocks,
  maskB64,
  resultImageSrc,
} from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/genericExampleLogic.js";

describe("TTS example builders", () => {
  it("builds provider/model/voice identifiers and optional body fields", () => {
    const config = { hasModelSelector: true, hasLanguageHint: true, hasStyleInput: true };
    expect(buildTtsModelFull({ alias: "p", config, model: "m", voiceId: "v" })).toBe("p/m/v");
    expect(buildTtsModelFull({ alias: "p", config, model: "m", voiceId: "" })).toBe("p/m");
    expect(buildTtsModelFull({ alias: "p", config: {}, model: "m", voiceId: "v" })).toBe("p/v");
    expect(buildTtsModelFull({ alias: "p", config: {}, model: "", voiceId: "" })).toBe("");
    expect(
      buildTtsBody({
        modelFull: "p/m/v",
        input: " hi ",
        config,
        languageHint: "en",
        style: " soft ",
      }),
    ).toEqual({ model: "p/m/v", input: " hi ", language: "en", style: "soft" });
    expect(
      buildTtsBody({ modelFull: "p/v", input: "hi", config: {}, languageHint: "en", style: "" }),
    ).toEqual({ model: "p/v", input: "hi" });
  });

  it("builds preview-safe binary and JSON cURL and filters languages", () => {
    const body = { model: "p/v", input: "hi" };
    const binary = buildTtsCurl({
      endpoint: "https://host",
      responseFormat: "mp3",
      apiKey: "secret",
      body,
    });
    expect(binary).toContain("https://host/v1/audio/speech");
    expect(binary).toContain("Authorization: Bearer YOUR_KEY");
    expect(binary).not.toContain("secret");
    expect(binary).toContain("--output speech.mp3");
    const json = buildTtsCurl({ endpoint: "https://host", responseFormat: "json", body });
    expect(json).toContain("/v1/audio/speech?response_format=json");
    expect(json).not.toContain("--output speech.mp3");
    expect(
      filterLanguages(
        [
          { name: "English", code: "en" },
          { name: "French", code: "fr" },
        ],
        "EN",
      ),
    ).toEqual([
      { name: "English", code: "en" },
      { name: "French", code: "fr" },
    ]);
  });
});

describe("generic example builders", () => {
  it("builds model and request body with optional fields and image edit defaults", () => {
    expect(
      buildGenericModelFull({
        alias: "p",
        needsModel: false,
        selectedModel: "m",
        allowManualModel: false,
      }),
    ).toBe("p");
    expect(
      buildGenericModelFull({
        alias: "p",
        needsModel: true,
        selectedModel: "m",
        allowManualModel: false,
      }),
    ).toBe("p/m");
    expect(
      buildGenericModelFull({
        alias: "p",
        needsModel: true,
        selectedModel: "",
        allowManualModel: true,
      }),
    ).toBe("");
    expect(buildExtraBody({ n: 0, empty: "", bad: NaN, nil: null, text: "ok" })).toEqual({
      n: 0,
      text: "ok",
    });
    expect(
      buildGenericRequestBody({
        modelFull: "p/m",
        input: "cat",
        bodyKey: "prompt",
        extraBody: { size: "auto" },
        extraValues: { n: 1 },
        supportsEdit: true,
        supportsMask: true,
        effectiveRefImage: "ref",
        effectiveMaskImage: "mask",
      }),
    ).toEqual({
      model: "p/m",
      prompt: "cat",
      size: "auto",
      n: 1,
      image: "ref",
      mask_image: "mask",
    });
  });

  it("builds streaming and binary preview-safe cURL", () => {
    const base = {
      method: "POST",
      endpoint: "http://localhost",
      apiPathWithQuery: "/v1/images/generations",
      body: { model: "p/m" },
      apiKey: "secret",
    };
    const stream = buildGenericCurl({
      ...base,
      pinnedConnectionId: "conn",
      useStreaming: true,
      wantBinary: false,
    });
    expect(stream).toContain("x-connection-id: conn");
    expect(stream).toContain("Accept: text/event-stream");
    expect(stream).toContain("Authorization: Bearer YOUR_KEY");
    expect(stream).not.toContain("secret");
    const binary = buildGenericCurl({
      ...base,
      pinnedConnectionId: "",
      useStreaming: false,
      wantBinary: true,
    });
    expect(binary).toContain("--output image.png");
    expect(binary).not.toContain("x-connection-id");
  });

  it("parses complete SSE blocks, leaves chunk remainder, and ignores malformed events", () => {
    expect(
      parseSseBlocks(
        'event: progress\ndata: {"stage":"working"}\n\nevent: done\ndata: {"ok":true}\n\nevent: error\ndata: nope\n\nevent: partial_image\ndata: {"b64_json":"a"}\n',
      ),
    ).toEqual({
      events: [
        { type: "progress", payload: { stage: "working" } },
        { type: "done", payload: { ok: true } },
      ],
      rest: 'event: partial_image\ndata: {"b64_json":"a"}\n',
    });
  });

  it("masks long base64 fields recursively without changing input and picks image source", () => {
    const data = {
      data: [{ b64_json: "x".repeat(101), url: "https://example.com" }],
      other: { b64_json: "short" },
    };
    expect(maskB64(data).data[0].b64_json).toBe("<101 chars base64>");
    expect(maskB64(data).other.b64_json).toBe("short");
    expect(data.data[0].b64_json).toHaveLength(101);
    expect(resultImageSrc("blob:preview", { data })).toBe("blob:preview");
    expect(resultImageSrc("", { data })).toBe(`data:image/png;base64,${"x".repeat(101)}`);
    expect(resultImageSrc("", { data: { data: [{ url: "https://example.com" }] } })).toBe(
      "https://example.com",
    );
  });
});
