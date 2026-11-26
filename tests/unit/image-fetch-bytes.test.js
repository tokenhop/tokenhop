// YAN-1597: fetchImageBytes holds the hardened fetch and returns raw bytes;
// fetchImageAsBase64 is a thin data-URI wrapper over it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import { fetchImageAsBase64, fetchImageBytes } from "../../open-sse/translator/concerns/image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  globalThis.fetch = vi.fn(async () => new Response(PNG, { status: 200 }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchImageBytes", () => {
  it("returns the fetched bytes as a Buffer with the detected mime", async () => {
    const r = await fetchImageBytes("https://example.com/a.png");
    expect(Buffer.isBuffer(r.buf)).toBe(true);
    expect(r.buf.equals(PNG)).toBe(true);
    expect(r.mimeType).toBe("image/png");
  });

  it("applies the same guards as fetchImageAsBase64", async () => {
    expect(await fetchImageBytes("ftp://x/y.png")).toBeNull();
    lookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect(await fetchImageBytes("https://internal.example/a.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("enforces the byte cap", async () => {
    expect(await fetchImageBytes("https://example.com/big.png", { maxBytes: 4 })).toBeNull();
  });

  it("requests with redirect: manual", async () => {
    await fetchImageBytes("https://example.com/a.png");
    expect(globalThis.fetch.mock.calls[0][1].redirect).toBe("manual");
  });
});

describe("fetchImageAsBase64 wrapper", () => {
  it("returns the same bytes as a data URI", async () => {
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).toEqual({
      url: `data:image/png;base64,${PNG.toString("base64")}`,
      mimeType: "image/png",
    });
  });

  it("returns null when fetchImageBytes refuses", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await fetchImageAsBase64("https://example.com/a.png")).toBeNull();
  });
});
