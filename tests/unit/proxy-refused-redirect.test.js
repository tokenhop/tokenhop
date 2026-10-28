// YAN-1599: when the caller asks for redirect: "error" and the proxied fetch
// reports a refused redirect, proxyAwareFetch must surface that refusal
// instead of retrying direct or wrapping it as a generic strictProxy failure.
// proxyFetch captures globalThis.fetch at import as its direct path, so stub
// it before importing and keep the test offline.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.fn(async (_url, options = {}) => {
  if (options?.dispatcher) {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: new Error("unexpected redirect"),
    });
  }
  return new Response("direct", { status: 200 });
});
globalThis.fetch = fetchStub;

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const POOL = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:9",
  connectionNoProxy: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

// The refusal is identified by its error chain, not its wording.
function expectRefusedRedirect(err) {
  expect(err).toBeInstanceOf(TypeError);
  expect(err.code).toBe("ERR_REDIRECT_REFUSED");
  expect(err.cause).toBeInstanceOf(TypeError);
  expect(err.cause.cause.message).toBe("unexpected redirect");
}

describe("refused redirect through a proxy (YAN-1599)", () => {
  beforeEach(() => {
    fetchStub.mockClear();
  });

  it("strictProxy: surfaces the refused redirect, not a strictProxy failure", async () => {
    const err = await proxyAwareFetch("https://fal.run/x", { redirect: "error" }, POOL).catch(
      (e) => e,
    );
    expectRefusedRedirect(err);
    expect(err.message).not.toContain("strictProxy=true");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("non-strict: surfaces the refused redirect without a direct retry", async () => {
    const err = await proxyAwareFetch(
      "https://fal.run/x",
      { redirect: "error" },
      { ...POOL, strictProxy: false },
    ).catch((e) => e);
    expectRefusedRedirect(err);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("MITM-bypass proxy branch: surfaces the refused redirect", async () => {
    const err = await proxyAwareFetch(
      "https://api2.cursor.sh/aiserver.v1",
      { redirect: "error" },
      POOL,
    ).catch((e) => e);
    expectRefusedRedirect(err);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("control: without redirect error mode, non-strict still falls back direct", async () => {
    const res = await proxyAwareFetch("https://fal.run/x", {}, { ...POOL, strictProxy: false });
    expect(await res.text()).toBe("direct");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
