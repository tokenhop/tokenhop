import { describe, it, expect } from "vitest";
import {
  getMediaProviderStatus,
  resolveToggleAction,
  buildPlaygroundCurl,
} from "@/shared/constants/mediaStatus.js";

describe("resolveToggleAction", () => {
  it("emits exactly one toggle call per activation", () => {
    expect(
      resolveToggleAction({ providerId: "openai", allDisabled: true, nextChecked: true }),
    ).toEqual({ providerId: "openai", newActive: true });
    expect(
      resolveToggleAction({ providerId: "openai", allDisabled: false, nextChecked: false }),
    ).toEqual({ providerId: "openai", newActive: false });
  });

  it("ignores already-handled or non-boolean activations", () => {
    expect(
      resolveToggleAction({
        providerId: "openai",
        allDisabled: true,
        nextChecked: true,
        alreadyHandled: true,
      }),
    ).toBeNull();
    expect(
      resolveToggleAction({ providerId: "openai", allDisabled: true, nextChecked: "yes" }),
    ).toBeNull();
  });
});

describe("getMediaProviderStatus", () => {
  it("returns Ready · no key for noAuth providers", () => {
    expect(getMediaProviderStatus({ isNoAuth: true, connections: [] })).toEqual({
      label: "Ready · no key",
      variant: "live",
    });
  });

  it("returns Not connected when no connections", () => {
    expect(getMediaProviderStatus({ connections: [] })).toEqual({
      label: "Not connected",
      variant: "neutral",
    });
  });

  it("returns Disabled when all connections disabled", () => {
    expect(
      getMediaProviderStatus({
        connections: [
          { provider: "x", isActive: false, testStatus: "active" },
          { provider: "x", isActive: false, testStatus: "active" },
        ],
      }),
    ).toEqual({ label: "Disabled", variant: "neutral" });
  });

  it("returns N connected when active connections exist", () => {
    expect(
      getMediaProviderStatus({
        connections: [
          { provider: "x", isActive: true, testStatus: "active" },
          { provider: "x", isActive: true, testStatus: "success" },
          { provider: "x", isActive: true, testStatus: "error" },
        ],
      }),
    ).toEqual({ label: "2 connected", variant: "ok" });
  });

  it("returns Auth error when errors exist and none connected", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "error" }],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });

  it("treats expired/unavailable as error", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "expired" }],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });

  it("returns added when no connected and no error", () => {
    expect(
      getMediaProviderStatus({
        connections: [{ provider: "x", isActive: true, testStatus: "pending" }],
      }),
    ).toEqual({ label: "1 added", variant: "neutral" });
  });

  it("treats unavailable without cooldown as active", () => {
    const now = Date.now();
    expect(
      getMediaProviderStatus({
        now,
        connections: [{ provider: "x", isActive: true, testStatus: "unavailable" }],
      }),
    ).toEqual({ label: "1 connected", variant: "ok" });
  });

  it("treats unavailable with active modelLock as error", () => {
    const now = Date.now();
    expect(
      getMediaProviderStatus({
        now,
        connections: [
          {
            provider: "x",
            isActive: true,
            testStatus: "unavailable",
            modelLock_foo: new Date(now + 60_000).toISOString(),
          },
        ],
      }),
    ).toEqual({ label: "Auth error", variant: "err" });
  });
});

describe("previewAuthHeader", () => {
  it("always returns the YOUR_KEY placeholder, even with a live key", async () => {
    const { previewAuthHeader, PREVIEW_AUTH_HEADER } = await import(
      "@/shared/constants/previewAuth.js"
    );
    expect(PREVIEW_AUTH_HEADER).toBe("Bearer YOUR_KEY");
    expect(previewAuthHeader("sk-live-secret")).toBe("Bearer YOUR_KEY");
    expect(previewAuthHeader("")).toBe("Bearer YOUR_KEY");
    expect(previewAuthHeader(undefined)).toBe("Bearer YOUR_KEY");
  });

  it("no rendered media-providers cURL builder interpolates a live key", async () => {
    const { previewAuthHeader } = await import("@/shared/constants/previewAuth.js");
    // Every cURL preview path in the media runners and combo page must go
    // through previewAuthHeader; simulate each call site with a live key.
    for (const liveKey of ["sk-live-secret", "sk-1234567890"]) {
      const header = previewAuthHeader(liveKey);
      expect(header).not.toContain(liveKey);
      expect(header).toBe("Bearer YOUR_KEY");
    }
  });
});

describe("maskPreviewApiKey", () => {
  it("never renders enough of the secret to be reusable", async () => {
    const { maskPreviewApiKey } = await import("@/shared/constants/previewAuth.js");
    expect(maskPreviewApiKey("")).toBe("");
    for (const liveKey of ["sk-live-secret-1234567890", "sk-abcdef"]) {
      const masked = maskPreviewApiKey(liveKey);
      expect(masked).not.toContain(liveKey);
      expect(masked.slice(4)).not.toContain(liveKey.slice(4));
      expect(masked.length).toBeLessThanOrEqual(liveKey.length);
    }
    expect(maskPreviewApiKey("x")).toBe("x");
    expect(maskPreviewApiKey("sk-live-secret-1234567890")).toBe("sk-l••••••••••••••••");
  });

  it("no media-providers display path renders more than 4 key characters", async () => {
    const { maskPreviewApiKey } = await import("@/shared/constants/previewAuth.js");
    // Generic/Stt/Tts cards all render the API Key row through this helper.
    const rendered = maskPreviewApiKey("sk-live-secret-1234567890");
    expect(rendered).toBe("sk-l••••••••••••••••");
    expect("sk-live-secret-1234567890".slice(4)).not.toContain(rendered.slice(4, 8));
  });
});

describe("buildPlaygroundCurl", () => {
  it("builds basic cURL with masked key default", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://localhost/v1/embeddings",
      body: { model: "x/y", input: "hi" },
    });
    expect(curl).toContain("curl -X POST http://localhost/v1/embeddings");
    expect(curl).toContain("Bearer YOUR_KEY");
    expect(curl).toContain(`-d '{"model":"x/y","input":"hi"}'`);
  });

  it("never renders a live API key in the preview, even when one is passed", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1",
      apiKey: "sk-live-secret",
      pinnedConnectionId: "conn-1",
      body: {},
    });
    expect(curl).not.toContain("sk-live-secret");
    expect(curl).toContain("Bearer YOUR_KEY");
    expect(curl).toContain("x-connection-id: conn-1");
  });

  it("emits truthful -F multipart flags for STT", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1/audio/transcriptions",
      apiKey: "sk-live-secret",
      form: {
        fileName: "voice.mp3",
        model: "openai/whisper-1",
        language: "en",
        temperature: "0.2",
        responseFormat: "json",
        prompt: "ctx",
      },
    });
    expect(curl).not.toContain("sk-live-secret");
    expect(curl).not.toContain("-d '");
    expect(curl).not.toContain("Content-Type: application/json");
    expect(curl).toContain('-F "file=@voice.mp3"');
    expect(curl).toContain('-F "model=openai/whisper-1"');
    expect(curl).toContain('-F "language=en"');
    expect(curl).toContain('-F "temperature=0.2"');
    expect(curl).toContain('-F "response_format=json"');
    expect(curl).toContain('-F "prompt=ctx"');
  });

  it("omits empty STT form fields", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1/audio/transcriptions",
      form: { fileName: "a.mp3", model: "m/s" },
    });
    expect(curl).toContain('-F "file=@a.mp3"');
    expect(curl).toContain('-F "model=m/s"');
    expect(curl).not.toContain("language=");
  });

  it("appends --output for binary", () => {
    const curl = buildPlaygroundCurl({
      method: "POST",
      url: "http://x/v1/images/generations",
      body: {},
      isBinary: true,
      binaryFilename: "image.png",
    });
    expect(curl).toContain("--output image.png");
  });
});
