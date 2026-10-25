// YAN-1577: Cloudflare Workers AI caller-supplied image/mask URLs go
// through the hardened image fetcher (DNS pinning, non-public address
// rejection, redirect:"manual", byte cap, magic-byte check) while still
// using the connection proxy.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

// Capture upstream/image fetch calls without touching the network.
const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const IMG2IMG = "@cf/runwayml/stable-diffusion-v1-5-img2img";
const CF_URL = `https://api.cloudflare.com/client/v4/accounts/cf-account/ai/run/${IMG2IMG}`;
const PUBLIC_IP = { address: "93.184.216.34", family: 4 };

// Valid PNG signature plus padding so the magic-byte check passes.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);

const PROXY_PSD = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

const credentials = {
  apiKey: "cf-token",
  providerSpecificData: { ...PROXY_PSD, accountId: "cf-account" },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const run = (body) =>
  handleImageGenerationCore({
    body: { prompt: "make it a lion", ...body },
    modelInfo: { provider: "cloudflare-ai", model: IMG2IMG },
    credentials,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });

const imageFetchCalls = () => mocks.proxyAwareFetch.mock.calls.filter(([url]) => url !== CF_URL);

beforeEach(() => {
  // A plain (proxy-bypassing) fetch is a failure, and must never reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("direct fetch bypassed the hardened image fetcher");
    }),
  );
  mocks.proxyAwareFetch.mockReset();
  mocks.proxyAwareFetch.mockImplementation(async (url) => {
    if (url === CF_URL) return json({ result: { image: "b64out" }, success: true });
    throw new Error("unexpected upstream fetch");
  });
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([PUBLIC_IP]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare input image URLs use the hardened image fetcher", () => {
  it("rejects a host resolving to a link-local address before any fetch", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    const result = await run({ image: "http://metadata.example/x.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects the blocked hostname localhost", async () => {
    const result = await run({ image: "http://localhost/x.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(imageFetchCalls()).toHaveLength(0);
  });

  it("rejects a host resolving to a loopback IP", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const result = await run({ image: "http://loopback.example/x.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(imageFetchCalls()).toHaveLength(0);
  });

  it("rejects hosts resolving to private 10.x and 192.168.x ranges", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const ten = await run({ image: "http://internal.example/x.png" });
    expect(ten.success).toBe(false);
    expect(ten.status).toBe(400);

    lookupMock.mockResolvedValue([{ address: "192.168.0.10", family: 4 }]);
    const oneNineTwo = await run({ image: "http://lan.example/x.png" });
    expect(oneNineTwo.success).toBe(false);
    expect(oneNineTwo.status).toBe(400);

    expect(imageFetchCalls()).toHaveLength(0);
  });

  it("rejects a host resolving to a link-local IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "fe80::1", family: 6 }]);

    const result = await run({ image: "http://v6.example/x.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(imageFetchCalls()).toHaveLength(0);
  });

  it("rejects a mask URL resolving to a private IP", async () => {
    lookupMock.mockResolvedValue([{ address: "10.9.9.9", family: 4 }]);

    const result = await run({ mask: "http://internal.example/mask.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(imageFetchCalls()).toHaveLength(0);
  });

  it("rejects a public URL that redirects to a private target, without following it", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://example.com/redir.png"
        ? new Response(null, {
            status: 302,
            headers: { Location: "http://blocked.example/x.png" },
          })
        : url === CF_URL
          ? json({ result: { image: "b64out" }, success: true })
          : (() => {
              throw new Error(`unexpected fetch: ${url}`);
            })(),
    );

    // The page URL is public; the redirect target resolves to a non-public address.
    lookupMock.mockImplementation(async (hostname) =>
      hostname === "blocked.example" ? [{ address: "169.254.169.254", family: 4 }] : [PUBLIC_IP],
    );

    const result = await run({ image: "https://example.com/redir.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    // The image fetch refused to follow redirects…
    const [imageCall] = imageFetchCalls();
    expect(imageCall[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    // …and the redirect target was never fetched.
    const redirectTarget = mocks.proxyAwareFetch.mock.calls.find(([url]) =>
      String(url).includes("blocked.example"),
    );
    expect(redirectTarget).toBeUndefined();
  });

  it("rejects a non-image payload from a public URL", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://example.com/not-image.png"
        ? new Response(Buffer.from("<html><body>not an image</body></html>"), { status: 200 })
        : url === CF_URL
          ? json({ result: { image: "b64out" }, success: true })
          : (() => {
              throw new Error(`unexpected fetch: ${url}`);
            })(),
    );

    const result = await run({ image: "https://example.com/not-image.png" });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("downloads a public PNG through the connection proxy and forwards it as image_b64", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://example.com/source.png"
        ? new Response(PNG_BYTES, { status: 200 })
        : url === CF_URL
          ? json({ result: { image: "b64out" }, success: true })
          : (() => {
              throw new Error(`unexpected fetch: ${url}`);
            })(),
    );

    const result = await run({ image: "https://example.com/source.png" });

    expect(result.success).toBe(true);

    // The image fetch went through proxyAwareFetch with the connection proxy and no redirects.
    const [imageCall] = imageFetchCalls();
    expect(imageCall[0]).toBe("https://example.com/source.png");
    expect(imageCall[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    expect(imageCall[2]).toEqual(
      expect.objectContaining({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://pool.example:8080",
        strictProxy: true,
      }),
    );

    // The upstream Cloudflare request carries the validated image as base64.
    const cfCall = mocks.proxyAwareFetch.mock.calls.find(([url]) => url === CF_URL);
    const upstreamBody = JSON.parse(cfCall[1].body);
    expect(upstreamBody.image_b64).toBe(PNG_BYTES.toString("base64"));
  });

  it("accepts an uppercase HTTPS scheme", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://example.com/a.png"
        ? new Response(PNG_BYTES, { status: 200 })
        : url === CF_URL
          ? json({ result: { image: "b64out" }, success: true })
          : (() => {
              throw new Error(`unexpected fetch: ${url}`);
            })(),
    );

    const result = await run({ image: "HTTPS://example.com/a.png" });

    expect(result.success).toBe(true);
    const [imageCall] = imageFetchCalls();
    expect(imageCall[0]).toBe("https://example.com/a.png");
  });
});
