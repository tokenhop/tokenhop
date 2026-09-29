import { describe, it, expect } from "vitest";
import {
  getListingHref,
  kindLabelFor,
  parseModelEntry,
  validateMediaComboName,
  exampleBodyFor,
  buildCurl,
  EXAMPLE_PATHS,
} from "@/app/(dashboard)/dashboard/media-providers/combo/[id]/mediaComboConfig.js";

describe("getListingHref", () => {
  it("sends web kinds to the shared web listing", () => {
    expect(getListingHref("webSearch")).toBe("/dashboard/media-providers/web");
    expect(getListingHref("webFetch")).toBe("/dashboard/media-providers/web");
  });

  it("sends other kinds to their own listing", () => {
    expect(getListingHref("image")).toBe("/dashboard/media-providers/image");
    expect(getListingHref("tts")).toBe("/dashboard/media-providers/tts");
    expect(getListingHref(undefined)).toBe("/dashboard/media-providers/undefined");
  });
});

describe("kindLabelFor", () => {
  it("derives labels from the shared registry, no-arg included", () => {
    expect(kindLabelFor("tts")).toBe("Text to speech");
    expect(kindLabelFor("webSearch")).toBe("Web search");
    expect(kindLabelFor("imageToText")).toBe("Image to text");
    expect(kindLabelFor("music")).toBe("Music");
    expect(kindLabelFor("video")).toBe("Video");
  });

  it("falls back to the passed kinds, then Combo", () => {
    const kinds = [{ id: "custom", label: "Custom" }];
    expect(kindLabelFor("custom", kinds)).toBe("Custom");
    expect(kindLabelFor("unknown", kinds)).toBe("Combo");
  });
});

describe("parseModelEntry", () => {
  it("splits on the first slash", () => {
    expect(parseModelEntry("openai/gpt-image-1")).toEqual({
      providerId: "openai",
      model: "gpt-image-1",
    });
    expect(parseModelEntry("a/b/c")).toEqual({ providerId: "a", model: "b/c" });
  });

  it("handles a bare provider and non-strings", () => {
    expect(parseModelEntry("openai")).toEqual({ providerId: "openai", model: "" });
    expect(parseModelEntry(null)).toEqual({ providerId: "", model: "" });
  });
});

describe("validateMediaComboName", () => {
  it("keeps the local wording and no trim", () => {
    expect(validateMediaComboName("my-combo.2")).toEqual({ ok: true, value: "my-combo.2" });
    expect(validateMediaComboName("")).toEqual({ ok: false, error: "Name is required" });
    expect(validateMediaComboName("a b")).toEqual({
      ok: false,
      error: "Only letters, numbers, -, _ and .",
    });
  });
});

describe("exampleBodyFor", () => {
  it("builds a body from the combo name", () => {
    expect(exampleBodyFor("image", "mix")).toEqual({
      model: "mix",
      prompt: "A cute cat playing piano",
      n: 1,
      size: "1024x1024",
    });
  });

  it("returns null for unknown kinds", () => {
    expect(exampleBodyFor("nope", "mix")).toBe(null);
    expect(exampleBodyFor("", "mix")).toBe(null);
  });
});

describe("buildCurl", () => {
  it("renders a preview-safe curl with the placeholder key", () => {
    const curl = buildCurl({
      origin: "http://localhost:9router",
      kind: "image",
      name: "mix",
      apiKey: "live-secret",
    });
    expect(curl).toContain("curl -X POST http://localhost:9router/v1/images/generations");
    expect(curl).toContain('"Authorization: Bearer YOUR_KEY"');
    expect(curl).not.toContain("live-secret");
  });

  it("is empty without an origin or a known kind", () => {
    expect(buildCurl({ origin: "", kind: "image", name: "mix", apiKey: "" })).toBe("");
    expect(buildCurl({ origin: "http://x", kind: "nope", name: "mix", apiKey: "" })).toBe("");
  });

  it("covers every example path with a matching body", () => {
    for (const kind of Object.keys(EXAMPLE_PATHS)) {
      const curl = buildCurl({ origin: "http://x", kind, name: "mix", apiKey: "" });
      expect(curl).toContain(`http://x${EXAMPLE_PATHS[kind]}`);
      expect(curl).toContain('"model":"mix"');
    }
  });
});
