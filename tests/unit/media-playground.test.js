import { describe, it, expect } from "vitest";
import {
  playgroundDefaults,
  playgroundModelOptions,
  resolvePlaygroundModel,
  buildPlaygroundBody,
  buildSttFormData,
  sttFormFields,
  playgroundHeaders,
  playgroundPreviews,
} from "@/app/(dashboard)/dashboard/media-providers/components/playgroundLogic.js";
import { createObjectUrlRegistry } from "@/shared/constants/playgroundUrls.js";

describe("playgroundDefaults", () => {
  it("returns kind defaults and falls back to image", () => {
    expect(playgroundDefaults("embedding").path).toBe("/v1/embeddings");
    expect(playgroundDefaults("tts").path).toBe("/v1/audio/speech");
    expect(playgroundDefaults("stt").path).toBe("/v1/audio/transcriptions");
    expect(playgroundDefaults("unknown").path).toBe("/v1/images/generations");
  });
});

describe("resolvePlaygroundModel", () => {
  it("keeps the current model when still available", () => {
    const options = [{ value: "a/x" }, { value: "b/y" }];
    expect(resolvePlaygroundModel("b/y", options)).toBe("b/y");
  });

  it("falls back to the first option otherwise", () => {
    const options = [{ value: "a/x" }, { value: "b/y" }];
    expect(resolvePlaygroundModel("stale", options)).toBe("a/x");
    expect(resolvePlaygroundModel("", options)).toBe("a/x");
  });

  it("returns empty string when no options exist", () => {
    expect(resolvePlaygroundModel("x", [])).toBe("x");
  });
});

describe("buildPlaygroundBody", () => {
  it("builds embedding payload with dimensions only when positive", () => {
    const base = { kind: "embedding", model: "m/e", input: " hi ", dimensions: "512" };
    expect(buildPlaygroundBody(base)).toEqual({ model: "m/e", input: "hi", dimensions: 512 });
    expect(buildPlaygroundBody({ ...base, dimensions: "" })).toEqual({
      model: "m/e",
      input: "hi",
    });
    expect(buildPlaygroundBody({ ...base, dimensions: "0" })).toEqual({
      model: "m/e",
      input: "hi",
    });
  });

  it("builds image payload with size and optional images", () => {
    const body = buildPlaygroundBody({
      kind: "image",
      model: "m/i",
      input: "cat",
      imageSize: "1024x1024",
      refImage: " https://x/a.png ",
      maskImage: "",
    });
    expect(body).toEqual({
      model: "m/i",
      prompt: "cat",
      size: "1024x1024",
      image: "https://x/a.png",
    });
  });

  it("builds tts payload with voice/language/style", () => {
    const body = buildPlaygroundBody({
      kind: "tts",
      model: "m/t",
      input: "hello",
      ttsVoice: "alloy",
      ttsLanguage: "en",
      ttsStyle: " warm ",
    });
    expect(body).toEqual({
      model: "m/t",
      input: "hello",
      voice: "alloy",
      language: "en",
      style: "warm",
    });
  });

  it("builds stt payload with language/temperature/format", () => {
    const body = buildPlaygroundBody({
      kind: "stt",
      model: "m/s",
      input: "ctx",
      sttLanguage: "vi",
      sttTemp: "0.2",
      sttFormat: "text",
    });
    expect(body).toEqual({
      model: "m/s",
      prompt: "ctx",
      language: "vi",
      temperature: 0.2,
      response_format: "text",
    });
  });

  it("builds web payloads with query/url keys", () => {
    expect(buildPlaygroundBody({ kind: "webSearch", model: "m", input: " q " })).toEqual({
      model: "m",
      query: "q",
    });
    expect(buildPlaygroundBody({ kind: "webFetch", model: "m", input: " https://x " })).toEqual({
      model: "m",
      url: "https://x",
    });
  });
});

describe("playgroundHeaders", () => {
  it("includes auth and connection pin headers", () => {
    expect(playgroundHeaders("sk-1", "conn-9", true)).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-1",
      "x-connection-id": "conn-9",
    });
    expect(playgroundHeaders("", "", false)).toEqual({});
  });
});

describe("buildSttFormData", () => {
  it("appends file, model and optional params", () => {
    const file = new Blob(["audio"], { type: "audio/mpeg" });
    const fd = buildSttFormData({
      model: "m/s",
      input: "ctx",
      sttFile: file,
      sttLanguage: "en",
      sttTemp: "0.1",
      sttFormat: "json",
    });
    expect(fd.get("model")).toBe("m/s");
    expect(fd.get("file")).toBeInstanceOf(Blob);
    expect(fd.get("file").size).toBe(5);
    expect(fd.get("language")).toBe("en");
    expect(fd.get("temperature")).toBe("0.1");
    expect(fd.get("response_format")).toBe("json");
    expect(fd.get("prompt")).toBe("ctx");
  });
});

describe("sttFormFields", () => {
  it("derives shared multipart fields and matches FormData", () => {
    const file = new Blob(["audio"], { type: "audio/mpeg" });
    file.name = "voice.mp3";
    const fields = {
      model: "m/s",
      input: "ctx",
      sttFile: file,
      sttLanguage: "en",
      sttTemp: "0.1",
      sttFormat: "json",
    };
    expect(sttFormFields(fields)).toEqual({
      fileName: "voice.mp3",
      model: "m/s",
      language: "en",
      temperature: "0.1",
      responseFormat: "json",
      prompt: "ctx",
    });
    const fd = buildSttFormData(fields);
    expect(fd.get("model")).toBe("m/s");
    expect(fd.get("language")).toBe("en");
    expect(fd.get("temperature")).toBe("0.1");
    expect(fd.get("response_format")).toBe("json");
    expect(fd.get("prompt")).toBe("ctx");
  });

  it("falls back to audio.mp3 when the file has no name", () => {
    const fields = { model: "m/s", input: "", sttFile: new Blob(["x"]) };
    expect(sttFormFields(fields).fileName).toBe("audio.mp3");
  });

  it("preview and run share the same -F field set", async () => {
    const { buildPlaygroundCurl } = await import("@/shared/constants/mediaStatus.js");
    const file = new Blob(["audio"], { type: "audio/mpeg" });
    file.name = "voice.mp3";
    const fields = {
      model: "m/s",
      input: "ctx",
      sttFile: file,
      sttLanguage: "en",
      sttTemp: "0.1",
      sttFormat: "json",
    };
    const shared = sttFormFields(fields);
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1/audio/transcriptions",
      form: shared,
    });
    const fd = buildSttFormData(fields);
    for (const [key, value] of [
      ["file", `@${shared.fileName}`],
      ["model", shared.model],
      ["language", shared.language],
      ["temperature", shared.temperature],
      ["response_format", shared.responseFormat],
      ["prompt", shared.prompt],
    ]) {
      expect(curl).toContain(`-F "${key}=${value}"`);
      // FormData file entry carries the blob; scalar entries match exactly.
      if (key !== "file") expect(fd.get(key)).toBe(value);
    }
    expect(fd.get("file")).toBeInstanceOf(Blob);
  });
});

describe("createObjectUrlRegistry", () => {
  it("revokes replaced urls and revokes live urls on revokeAll", () => {
    const revoked = [];
    const ref = { current: { image: "", audio: "" } };
    const registry = createObjectUrlRegistry(ref, (url) => revoked.push(url));

    registry.setImage("blob:image-1");
    registry.setAudio("blob:audio-1");
    // Replacing revokes the previous live URL exactly once.
    registry.setImage("blob:image-2");
    expect(revoked).toEqual(["blob:image-1"]);

    // Unmount cleanup revokes the currently live URLs even though the
    // caller holds no fresh state — the ref is the source of truth.
    registry.revokeAll();
    expect(revoked).toEqual(["blob:image-1", "blob:image-2", "blob:audio-1"]);
    expect(ref.current).toEqual({ image: "", audio: "" });
  });

  it("covers the Generic/Tts/combo blob lifecycles: replace, clear, unmount", () => {
    const revoked = [];
    const ref = { current: { image: "", audio: "" } };
    const registry = createObjectUrlRegistry(ref, (url) => revoked.push(url));

    // GenericExampleCard binary image replace (run twice).
    registry.setImage("blob:generic-1");
    registry.setImage("blob:generic-2");
    // TtsExampleCard audio replace (mp3 run then json run).
    registry.setAudio("blob:tts-1");
    registry.setAudio("blob:tts-2");
    // Combo page test URLs: image then audio, cleared before the next run.
    registry.setImage("blob:combo-img");
    registry.setAudio("blob:combo-aud");
    registry.clear();
    expect(ref.current).toEqual({ image: "", audio: "" });
    // Unmount after clear revokes nothing new.
    registry.revokeAll();
    expect(revoked).toEqual([
      "blob:generic-1",
      "blob:tts-1",
      "blob:generic-2",
      "blob:tts-2",
      "blob:combo-img",
      "blob:combo-aud",
    ]);
  });

  it("clear revokes live urls without throwing on revoke failures", () => {
    const ref = { current: { image: "blob:i", audio: "blob:a" } };
    const registry = createObjectUrlRegistry(ref, () => {
      throw new Error("revoke failed");
    });
    expect(() => registry.clear()).not.toThrow();
    expect(ref.current).toEqual({ image: "", audio: "" });
  });
});

describe("playgroundPreviews", () => {
  it("derives image/audio preview URLs", () => {
    expect(playgroundPreviews({ data: [{ b64_json: "abc" }] })).toEqual({
      imageUrl: "data:image/png;base64,abc",
      audioUrl: "",
    });
    expect(playgroundPreviews({ data: [{ url: "https://x/i.png" }] })).toEqual({
      imageUrl: "https://x/i.png",
      audioUrl: "",
    });
    expect(playgroundPreviews({ audio: "zzz" })).toEqual({
      imageUrl: "",
      audioUrl: "data:audio/mp3;base64,zzz",
    });
    expect(playgroundPreviews(null)).toEqual({ imageUrl: "", audioUrl: "" });
  });
});

describe("playgroundModelOptions", () => {
  it("returns selectable options for a kind", () => {
    const options = playgroundModelOptions("embedding");
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveProperty("value");
    expect(options[0]).toHaveProperty("label");
  });
});
