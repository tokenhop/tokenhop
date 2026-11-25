// Headroom payload size cap (headroomMaxBodyBytes) and proxy token
// (HEADROOM_PROXY_TOKEN → x-headroom-proxy-token) on every server-side call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({ headroomUrl: "http://headroom:8787" }),
}));

const { compressWithHeadroom, DEFAULT_HEADROOM_MAX_BODY_BYTES } = await import(
  "../../open-sse/rtk/headroom.js"
);
const { HEADROOM_PROXY_TOKEN_HEADER, headroomRequestHeaders } = await import(
  "../../open-sse/rtk/headroomAuth.js"
);
const { probeProxyRunning } = await import("../../src/lib/headroom/detect.js");
const proxyRoute = await import("../../src/app/api/headroom/proxy/[...path]/route.js");

const TOKEN = "s3cret-proxy-token";
const MODEL = "gpt-4o";

const okCompress = () =>
  vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    return new Response(JSON.stringify({ messages, tokens_before: 10, tokens_saved: 0 }), {
      status: 200,
    });
  });

const bodyOf = (chars) => ({ messages: [{ role: "user", content: "x".repeat(chars) }] });
// Exact bytes callCompress would POST for this body (OpenAI shape).
const payloadBytes = (body) =>
  new TextEncoder().encode(JSON.stringify({ messages: body.messages, model: MODEL })).length;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("HEADROOM_PROXY_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("headroomMaxBodyBytes", () => {
  it("defaults to 256 KB", () => {
    expect(DEFAULT_HEADROOM_MAX_BODY_BYTES).toBe(262144);
  });

  it("skips above the cap without calling Headroom and records why", async () => {
    global.fetch = okCompress();
    const body = bodyOf(812 * 1024);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      maxBodyBytes: 262144,
      diagnostics,
    });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diagnostics.reason).toBe("payload 813KB > cap 256KB");
    expect(diagnostics.endpoint).toBeUndefined();
    expect(body.messages[0].content).toHaveLength(812 * 1024);
  });

  it("applies the default cap when the setting is missing", async () => {
    global.fetch = okCompress();
    const diagnostics = {};
    await compressWithHeadroom(bodyOf(300 * 1024), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      diagnostics,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diagnostics.reason).toMatch(/^payload \d+KB > cap 256KB$/);
  });

  it("calls Headroom at exactly the cap and below it", async () => {
    const body = bodyOf(1000);
    const exact = payloadBytes(body);
    for (const cap of [exact, exact + 1]) {
      global.fetch = okCompress();
      const stats = await compressWithHeadroom(structuredClone(body), {
        enabled: true,
        url: "http://headroom:8787",
        model: MODEL,
        maxBodyBytes: cap,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(stats).not.toBeNull();
    }

    global.fetch = okCompress();
    const diagnostics = {};
    await compressWithHeadroom(structuredClone(body), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      maxBodyBytes: exact - 1,
      diagnostics,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diagnostics.oversize).toEqual({ payloadBytes: exact, maxBodyBytes: exact - 1 });
  });

  it("treats 0 as no cap", async () => {
    global.fetch = okCompress();
    const stats = await compressWithHeadroom(bodyOf(2 * 1024 * 1024), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      maxBodyBytes: 0,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(stats).not.toBeNull();
  });

  it("measures the projected Claude messages, not the raw body", async () => {
    global.fetch = okCompress();
    const diagnostics = {};
    const body = {
      system: [{ type: "text", text: "s".repeat(400 * 1024) }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      format: "claude",
      maxBodyBytes: 262144,
      diagnostics,
    });
    // system is never projected, so the tiny messages payload goes through.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("HEADROOM_PROXY_TOKEN", () => {
  it("headroomRequestHeaders adds the header only when the env is set", () => {
    expect(headroomRequestHeaders({ a: "1" })).toEqual({ a: "1" });
    vi.stubEnv("HEADROOM_PROXY_TOKEN", `  ${TOKEN}  `);
    expect(headroomRequestHeaders({ a: "1" })).toEqual({
      a: "1",
      [HEADROOM_PROXY_TOKEN_HEADER]: TOKEN,
    });
    expect(HEADROOM_PROXY_TOKEN_HEADER).toBe("x-headroom-proxy-token");
  });

  it("/v1/compress sends x-headroom-proxy-token when set", async () => {
    vi.stubEnv("HEADROOM_PROXY_TOKEN", TOKEN);
    global.fetch = okCompress();
    await compressWithHeadroom(bodyOf(10), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
    });
    const { headers } = global.fetch.mock.calls[0][1];
    expect(headers["x-headroom-proxy-token"]).toBe(TOKEN);
    expect(headers.Authorization).toBeUndefined();
  });

  it("/v1/compress omits the header when unset, and never logs the token", async () => {
    global.fetch = okCompress();
    await compressWithHeadroom(bodyOf(10), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
    });
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty("x-headroom-proxy-token");

    vi.stubEnv("HEADROOM_PROXY_TOKEN", TOKEN);
    global.fetch = vi.fn(async () => new Response("no", { status: 401 }));
    const diagnostics = {};
    await compressWithHeadroom(bodyOf(10), {
      enabled: true,
      url: "http://headroom:8787",
      model: MODEL,
      diagnostics,
    });
    expect(diagnostics.reason).toBe("proxy returned HTTP 401");
    expect(JSON.stringify(diagnostics)).not.toContain(TOKEN);
  });

  it("the /health probe sends the header when set", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await probeProxyRunning("http://headroom:8787");
    expect(global.fetch.mock.calls[0][1].headers).toEqual({});

    vi.stubEnv("HEADROOM_PROXY_TOKEN", TOKEN);
    await probeProxyRunning("http://headroom:8787");
    expect(global.fetch.mock.calls[1][0]).toBe("http://headroom:8787/health");
    expect(global.fetch.mock.calls[1][1].headers).toEqual({ "x-headroom-proxy-token": TOKEN });
  });

  const proxyGet = (headers) =>
    proxyRoute.GET(new Request("http://localhost/api/headroom/proxy/stats", { headers }), {
      params: Promise.resolve({ path: ["stats"] }),
    });

  it("dashboard proxy replaces a browser-supplied token with the server one", async () => {
    vi.stubEnv("HEADROOM_PROXY_TOKEN", TOKEN);
    global.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await proxyGet({
      "x-headroom-proxy-token": "browser-token",
      authorization: "Bearer browser-token",
      accept: "application/json",
    });
    const [target, init] = global.fetch.mock.calls[0];
    expect(String(target)).toBe("http://headroom:8787/stats");
    expect(init.headers.get("x-headroom-proxy-token")).toBe(TOKEN);
    expect(init.headers.get("authorization")).toBeNull();
    expect(init.headers.get("accept")).toBe("application/json");
  });

  it("dashboard proxy strips a browser-supplied token when no server token is set", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await proxyGet({ "x-headroom-proxy-token": "browser-token" });
    expect(global.fetch.mock.calls[0][1].headers.get("x-headroom-proxy-token")).toBeNull();
  });
});
