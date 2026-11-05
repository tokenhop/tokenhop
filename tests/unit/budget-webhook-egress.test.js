// YAN-1831 budget webhook egress policy: literal URL rules at save time and
// the pinned fetch (single DNS resolution, every record checked, metadata and
// link-local always blocked, private networks only with the opt-in, redirects
// refused and never followed, bounded by a timeout).
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

const { egressUrlError, fetchPinned } = await import("../../open-sse/utils/pinnedFetch.js");
const { isEgressAllowedIp } = await import("../../open-sse/utils/ipPolicy.js");

const servers = [];
async function serve(handler) {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count++;
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { port: server.address().port, hits };
}

afterEach(async () => {
  lookupMock.mockReset();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections?.();
          s.close(() => r());
        }),
    ),
  );
});

const PRIVATE = { allowPrivate: true };
const resolveTo = (...addresses) =>
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));

describe("egressUrlError", () => {
  it("accepts https and refuses http unless private networks are allowed", () => {
    expect(egressUrlError("https://hooks.example.com/x")).toBeNull();
    expect(egressUrlError("http://hooks.example.com/x")).toBe("invalid_url");
    expect(egressUrlError("http://hooks.example.com/x", PRIVATE)).toBeNull();
  });

  it("refuses malformed URLs, userinfo, fragments and oversize URLs", () => {
    for (const url of [
      "not a url",
      "ftp://hooks.example.com/",
      "https://user:pw@hooks.example.com/",
      "https://hooks.example.com/#frag",
      `https://hooks.example.com/${"a".repeat(2000)}`,
    ]) {
      expect(egressUrlError(url), url).toBe("invalid_url");
    }
  });

  it("blocks metadata and link-local destinations even with the opt-in", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/",
      "https://[fe80::1]/",
      "https://[fd00:ec2::254]/",
      "https://100.100.100.200/",
    ]) {
      expect(egressUrlError(url), url).toBe("blocked_destination");
      expect(egressUrlError(url, PRIVATE), url).toBe("blocked_destination");
    }
  });

  it("blocks RFC1918, loopback and localhost without the opt-in only", () => {
    for (const url of ["https://10.0.0.5/", "https://127.0.0.1/", "https://localhost/"]) {
      expect(egressUrlError(url), url).toBe("blocked_destination");
      expect(egressUrlError(url, PRIVATE), url).toBeNull();
    }
  });
});

describe("isEgressAllowedIp", () => {
  it("normalizes IPv4-mapped IPv6 spellings", () => {
    expect(isEgressAllowedIp("::ffff:169.254.169.254", PRIVATE)).toBe(false);
    expect(isEgressAllowedIp("::ffff:10.0.0.5")).toBe(false);
    expect(isEgressAllowedIp("::ffff:10.0.0.5", PRIVATE)).toBe(true);
    expect(isEgressAllowedIp("8.8.8.8")).toBe(true);
    expect(isEgressAllowedIp("192.0.2.1", PRIVATE)).toBe(false); // TEST-NET stays blocked
  });
});

describe("fetchPinned", () => {
  const post = (url, opts) => fetchPinned(url, { body: "{}" }, { timeoutMs: 1000, ...opts });

  it("refuses a hostname resolving to the metadata IP, even with the opt-in", async () => {
    const { port, hits } = await serve((_q, s) => s.end("ok"));
    resolveTo("169.254.169.254");
    expect(await post(`http://hook.test:${port}/`, PRIVATE)).toEqual({
      ok: false,
      reason: "blocked_destination",
    });
    expect(hits.count).toBe(0);
  });

  it("refuses RFC1918 and loopback records without the opt-in", async () => {
    const { port, hits } = await serve((_q, s) => s.end("ok"));
    resolveTo("10.0.0.5");
    expect((await post(`https://hook.test:${port}/`)).reason).toBe("blocked_destination");
    resolveTo("127.0.0.1");
    expect((await post(`https://hook.test:${port}/`)).reason).toBe("blocked_destination");
    expect(hits.count).toBe(0);
  });

  it("refuses when any record of a multi-A answer is private", async () => {
    resolveTo("93.184.216.34", "10.0.0.5");
    expect((await post("https://hook.test/")).reason).toBe("blocked_destination");
  });

  it("fails closed on a DNS error", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    expect((await post("https://hook.test/")).reason).toBe("dns");
  });

  it("delivers to an allowed private destination and reports HTTP failures", async () => {
    const ok = await serve((_q, s) => s.end("ok"));
    const bad = await serve((_q, s) => {
      s.statusCode = 500;
      s.end();
    });
    resolveTo("127.0.0.1");
    expect(await post(`http://hook.test:${ok.port}/`, PRIVATE)).toEqual({ ok: true, status: 200 });
    expect(await post(`http://hook.test:${bad.port}/`, PRIVATE)).toEqual({
      ok: false,
      reason: "http",
      status: 500,
    });
  });

  it("refuses a 302 and never follows it", async () => {
    const target = await serve((_q, s) => s.end("ok"));
    const redirect = await serve((_q, s) => {
      s.writeHead(302, { location: `http://127.0.0.1:${target.port}/` });
      s.end();
    });
    resolveTo("127.0.0.1");
    expect(await post(`http://hook.test:${redirect.port}/`, PRIVATE)).toEqual({
      ok: false,
      reason: "redirect",
      status: 302,
    });
    expect(redirect.hits.count).toBe(1);
    expect(target.hits.count).toBe(0);
  });

  it("times out on a hanging server", async () => {
    const { port } = await serve(() => {}); // never answers
    resolveTo("127.0.0.1");
    const started = Date.now();
    const result = await post(`http://hook.test:${port}/`, { ...PRIVATE, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
