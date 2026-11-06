// YAN-1831 budget webhook egress policy: literal URL rules at save time and
// the pinned fetch (single c-ares resolution of A + AAAA, every record
// checked, metadata and link-local always blocked, private networks only with
// the opt-in, redirects refused and never followed, one deadline for DNS,
// connect and response).
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

// c-ares Resolver stand-in: `dns.a` / `dns.aaaa` are address lists, an Error
// (rejects) or "hang" (never answers). Construction options are recorded.
const dns = vi.hoisted(() => ({ a: [], aaaa: [], options: [], queried: [] }));
vi.mock("node:dns/promises", () => {
  const answer = (v) =>
    v === "hang"
      ? new Promise(() => {})
      : v instanceof Error
        ? Promise.reject(v)
        : Promise.resolve(v);
  class Resolver {
    constructor(options) {
      dns.options.push(options);
    }
    resolve4(host) {
      dns.queried.push(host);
      return answer(dns.a);
    }
    resolve6(host) {
      dns.queried.push(host);
      return answer(dns.aaaa);
    }
    cancel() {}
  }
  return { Resolver, lookup: () => Promise.reject(new Error("lookup must not be used")) };
});

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
  Object.assign(dns, { a: [], aaaa: [], options: [], queried: [] });
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
const resolveTo = (...addresses) => {
  dns.a = addresses.filter((a) => !a.includes(":"));
  dns.aaaa = addresses.filter((a) => a.includes(":"));
};

// Opt-in decides: refused without it, allowed with it.
const PRIVATE_NETWORK_IPS = ["172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fc00::1"];
// Refused whatever the opt-in says.
const ALWAYS_BLOCKED_IPS = [
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fe80::1",
  "fd00:ec2::254",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
  "::ffff:169.254.169.254",
  "0.0.0.0",
  "::",
];
const ALWAYS_BLOCKED_HOSTS = [
  "metadata.goog",
  "metadata",
  "instance-data",
  "metadata.google.internal",
];
const urlHost = (ip) => (ip.includes(":") ? `[${ip}]` : ip);

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

  it("table: private-network literals need the opt-in, metadata never passes", () => {
    for (const ip of PRIVATE_NETWORK_IPS) {
      expect(egressUrlError(`https://${urlHost(ip)}/`), ip).toBe("blocked_destination");
      expect(egressUrlError(`https://${urlHost(ip)}/`, PRIVATE), ip).toBeNull();
    }
    for (const ip of ALWAYS_BLOCKED_IPS) {
      for (const opts of [undefined, PRIVATE]) {
        expect(egressUrlError(`https://${urlHost(ip)}/`, opts), ip).toBe("blocked_destination");
      }
    }
    for (const host of ALWAYS_BLOCKED_HOSTS) {
      for (const opts of [undefined, PRIVATE]) {
        expect(egressUrlError(`https://${host}/`, opts), host).toBe("blocked_destination");
      }
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

  it("table: private networks only with the opt-in", () => {
    for (const ip of PRIVATE_NETWORK_IPS) {
      expect(isEgressAllowedIp(ip), ip).toBe(false);
      expect(isEgressAllowedIp(ip, PRIVATE), ip).toBe(true);
    }
  });

  it("table: link-local, metadata and unspecified addresses never", () => {
    for (const ip of ALWAYS_BLOCKED_IPS) {
      expect(isEgressAllowedIp(ip), ip).toBe(false);
      expect(isEgressAllowedIp(ip, PRIVATE), ip).toBe(false);
    }
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

  it("table: resolved private records refused without the opt-in, reached with it", async () => {
    const { port, hits } = await serve((_q, s) => s.end("ok"));
    for (const ip of PRIVATE_NETWORK_IPS) {
      resolveTo(ip);
      expect(await post(`https://hook.test:${port}/`), ip).toEqual({
        ok: false,
        reason: "blocked_destination",
      });
    }
    expect(hits.count).toBe(0);
    // With the opt-in the policy passes them; only loopback is reachable here.
    resolveTo("127.0.0.1");
    expect(await post(`http://hook.test:${port}/`, PRIVATE)).toEqual({ ok: true, status: 200 });
  });

  it("table: resolved metadata/link-local/unspecified records refused even with the opt-in", async () => {
    const { port, hits } = await serve((_q, s) => s.end("ok"));
    for (const ip of ALWAYS_BLOCKED_IPS) {
      resolveTo(ip);
      for (const opts of [undefined, PRIVATE]) {
        expect((await post(`https://hook.test:${port}/`, opts)).reason, ip).toBe(
          "blocked_destination",
        );
      }
    }
    // A mapped metadata address hidden in an AAAA answer next to a public A.
    dns.a = ["93.184.216.34"];
    dns.aaaa = ["::ffff:169.254.169.254"];
    expect((await post("https://hook.test/", PRIVATE)).reason).toBe("blocked_destination");
    for (const host of ALWAYS_BLOCKED_HOSTS) {
      resolveTo("93.184.216.34");
      expect((await post(`https://${host}/`, PRIVATE)).reason, host).toBe("blocked_destination");
    }
    expect(hits.count).toBe(0);
  });

  it("fails closed on a DNS error or an empty answer", async () => {
    dns.a = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    dns.aaaa = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    expect((await post("https://hook.test/")).reason).toBe("dns");
    resolveTo();
    expect((await post("https://hook.test/")).reason).toBe("dns");
  });

  it("uses c-ares with one try and a bounded timeout; localhost never hits DNS", async () => {
    resolveTo("93.184.216.34", "10.0.0.5");
    await post("https://hook.test/", { timeoutMs: 300 });
    expect(dns.options).toEqual([{ timeout: 300, tries: 1 }]);
    expect(dns.queried).toEqual(["hook.test", "hook.test"]);
    const { port } = await serve((_q, s) => s.end("ok"));
    dns.queried = [];
    expect(await post(`http://localhost:${port}/`, PRIVATE)).toEqual({ ok: true, status: 200 });
    expect(dns.queried).toEqual([]);
  });

  it("a resolver that never answers ends the attempt within timeoutMs", async () => {
    dns.a = "hang";
    dns.aaaa = "hang";
    const started = Date.now();
    const result = await post("https://hook.test/", { timeoutMs: 150 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
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
