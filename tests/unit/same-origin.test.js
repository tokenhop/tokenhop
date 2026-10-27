import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";

const request = (origin, host = "pub.example:20128", extra = {}) =>
  new NextRequest("http://0.0.0.0:20127/api/users/user-1", {
    headers: { host, ...(origin === undefined ? {} : { origin }), ...extra },
  });

beforeEach(() => {
  vi.stubEnv("BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configured canonical origin", () => {
  it.each([
    ["https://pub.example:20128", false],
    ["https://pub.example", true],
    ["http://pub.example:20128", true],
    ["https://evil.example:20128", true],
    ["http://localhost:20127", true],
  ])("Origin %s denied=%s despite internal nextUrl", (origin, denied) => {
    vi.stubEnv("BASE_URL", "https://pub.example:20128");
    expect(isCrossSite(request(origin))).toBe(denied);
  });

  it("a loopback base URL accepts only its own form (YAN-1020)", () => {
    vi.stubEnv("BASE_URL", "http://localhost:20128");
    expect(isCrossSite(request("http://localhost:20128", "127.0.0.1:20128"))).toBe(false);
    expect(isCrossSite(request("http://127.0.0.1:20128", "127.0.0.1:20128"))).toBe(true);
  });

  it.each(["https://pub.example", "https://pub.example/app"])(
    "projects %s to normalized origin",
    (canonical) => {
      vi.stubEnv("BASE_URL", canonical);
      expect(isCrossSite(request("https://PUB.example:443"))).toBe(false);
    },
  );

  it("reads env at call time; BASE_URL wins; whitespace falls back to NEXT_PUBLIC", () => {
    vi.stubEnv("BASE_URL", " https://pub.example ");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://other.example");
    expect(isCrossSite(request("https://pub.example"))).toBe(false);
    expect(isCrossSite(request("https://other.example"))).toBe(true);
    for (const empty of ["", "  \t "]) {
      vi.stubEnv("BASE_URL", empty);
      expect(isCrossSite(request("https://other.example"))).toBe(false);
      expect(isCrossSite(request("https://pub.example"))).toBe(true);
    }
  });

  it("fails closed on malformed BASE_URL, without fallback or leaking values; warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://pub.example");
    const badValues = [
      "garbage",
      "ftp://x",
      "https://u:p@x",
      "https://x/?q",
      "https://x/#f",
      "op://Vault/BASE_URL_DEV/url",
    ];
    for (const value of badValues) {
      vi.stubEnv("BASE_URL", value);
      expect(isCrossSite(request(undefined))).toBe(false);
      expect(isCrossSite(request("https://pub.example"))).toBe(true);
      expect(isCrossSite(request("https://pub.example"))).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[auth] Invalid BASE_URL; rejecting Origin-bearing requests.",
    );
    for (const value of badValues) expect(warn.mock.calls[0][0]).not.toContain(value);
    expect(warn.mock.calls[0][0]).not.toContain("u:p");

    // Warn-once is per key: a bad NEXT_PUBLIC_BASE_URL still warns once, under its own name.
    vi.stubEnv("BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "ftp://x");
    for (let i = 0; i < 2; i++) expect(isCrossSite(request("https://pub.example"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      "[auth] Invalid NEXT_PUBLIC_BASE_URL; rejecting Origin-bearing requests.",
    );
    expect(warn.mock.calls[1][0]).not.toContain("ftp");
  });

  it("also denies malformed NEXT_PUBLIC when BASE_URL is unset", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "ftp://x");
    expect(isCrossSite(request("http://pub.example:20128"))).toBe(true);
    expect(isCrossSite(request(undefined))).toBe(false);
  });
});

describe("unconfigured Host comparison", () => {
  it.each([
    ["http://pub.example:20128", "pub.example:20128", false],
    ["https://pub.example:20128", "pub.example:20128", false],
    ["http://localhost:20127", "localhost:20127", false],
    ["https://localhost:20127", "localhost:20127", false],
    ["http://192.168.1.5:20127", "192.168.1.5:20127", false],
    ["https://192.168.1.5:20127", "192.168.1.5:20127", false],
    ["http://[::1]:20127", "[::1]:20127", false],
    ["https://[::1]:20127", "[::1]:20127", false],
    ["http://a:80", "a", false],
    ["https://a:443", "a", false],
    ["http://a", "a:80", false],
    ["https://a", "a:443", false],
    ["https://a:80", "a:80", false],
    ["http://a:443", "a:443", false],
    ["http://a", "A", false],
    ["https://a", "a:80", true],
    ["http://a", "a:443", true],
    ["https://evil.example:20128", "pub.example:20128", true],
    ["https://pub.example", "pub.example:20128", true],
  ])("Origin %s, Host %s denied=%s", (origin, host, denied) => {
    expect(isCrossSite(request(origin, host))).toBe(denied);
  });

  it.each(["", "a/x", "u@a", "a b", "a?x", "a#x", "[::1", "a:bad"])(
    "denies malformed Host %s",
    (host) => expect(isCrossSite(request("http://a", host))).toBe(true),
  );
});

// YAN-1020: Next's NextURL folds 127.x and [::1] to `localhost`, so with
// HOSTNAME=127.0.0.1 a route sees nextUrl `localhost:P` while the browser sent
// Origin `http://127.0.0.1:P`. The Host header decides; each loopback form only
// matches itself. Rows pass the request-URL host; NextRequest applies the fold.
describe("standalone loopback: Host header decides, never nextUrl", () => {
  // Same-origin fetch metadata on every row: it is never an allow signal.
  const standalone = (urlHost, origin, host) =>
    new NextRequest(`http://${urlHost}/api/workspaces/w1/budgets`, {
      method: "POST",
      headers: { host, origin, "sec-fetch-site": "same-origin" },
    });

  it.each([
    ["127.0.0.1:20991", "http://127.0.0.1:20991", "127.0.0.1:20991", false],
    ["[::1]:20991", "http://[::1]:20991", "[::1]:20991", false],
    ["0.0.0.0:20991", "http://127.0.0.1:20991", "127.0.0.1:20991", false],
    ["0.0.0.0:20991", "http://localhost:20991", "localhost:20991", false],
    ["127.0.0.1:20991", "http://localhost:20991", "127.0.0.1:20991", true],
    ["[::1]:20991", "http://localhost:20991", "[::1]:20991", true],
    ["0.0.0.0:20991", "http://[::1]:20991", "127.0.0.1:20991", true],
    ["localhost:20991", "http://127.0.0.1:20991", "localhost:20991", true],
    ["127.0.0.1:20991", "http://127.0.0.1:20992", "127.0.0.1:20991", true],
  ])("request URL %s, Origin %s, Host %s denied=%s", (urlHost, origin, host, denied) => {
    const req = standalone(urlHost, origin, host);
    // Allowed rows must differ from nextUrl, or they would not test the fix.
    if (!denied) expect(req.nextUrl.host).not.toBe(new URL(origin).host);
    expect(isCrossSite(req)).toBe(denied);
  });
});

describe("test environment setup (isolateDataDir.js)", () => {
  const setup = new URL("../setup/isolateDataDir.js", import.meta.url).href;
  // Child process imports the real setup file; reports booleans only, never values.
  const runSetup = (baseUrl) =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(setup)});
           console.log(JSON.stringify({ defined: process.env.BASE_URL !== undefined,
             kept: process.env.BASE_URL === ${JSON.stringify(baseUrl)} }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BASE_URL: baseUrl,
            TOKENHOP_TEST_TMP_PARENT: process.env.TOKENHOP_TEST_ROOT,
            TOKENHOP_TEST_REAL_PROJECT: "",
          },
        },
      ).stdout,
    );

  it("worker has no Vite '/' BASE_URL sentinel", () => {
    expect(process.env.BASE_URL).not.toBe("/");
    expect(isCrossSite(request("http://pub.example:20128"))).toBe(false);
  });

  it("deletes only the exact '/' sentinel; configured http(s) values survive", () => {
    expect(runSetup("/")).toEqual({ defined: false, kept: false });
    expect(runSetup("https://pub.example:20128")).toEqual({ defined: true, kept: true });
    expect(runSetup("//")).toEqual({ defined: true, kept: true });
  });
});

describe("shared hard denials", () => {
  it.each(["", "https://pub.example:20128"])(
    "ignores forwarded headers with BASE_URL=%s",
    (base) => {
      vi.stubEnv("BASE_URL", base);
      const forwarded = {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
        forwarded: "host=evil.example;proto=https",
      };
      expect(isCrossSite(request("https://evil.example", "pub.example:20128", forwarded))).toBe(
        true,
      );
    },
  );

  it.each([
    "null",
    "not a url",
    "",
    "https://pub.example:20128/app",
    "https://pub.example:20128/?q",
    "https://pub.example:20128/#f",
    "https://u:p@pub.example:20128",
    "ftp://pub.example:20128",
  ])("denies invalid Origin %s", (origin) => {
    for (const base of ["", "https://pub.example:20128"]) {
      vi.stubEnv("BASE_URL", base);
      expect(isCrossSite(request(origin))).toBe(true);
    }
  });

  it("cross-site fetch metadata wins even for matching or missing Origin", () => {
    for (const base of ["", "https://pub.example:20128"]) {
      vi.stubEnv("BASE_URL", base);
      for (const origin of ["https://pub.example:20128", undefined]) {
        expect(
          isCrossSite(request(origin, "pub.example:20128", { "sec-fetch-site": "cross-site" })),
        ).toBe(true);
      }
    }
  });

  it("no Origin stays allowed and unexpected request errors fail closed", () => {
    expect(isCrossSite(request(undefined, ""))).toBe(false);
    expect(isCrossSite(null)).toBe(true);
    expect(
      isCrossSite({
        headers: {
          get() {
            throw new Error("broken");
          },
        },
      }),
    ).toBe(true);
  });

  it("preserves isJson's case-insensitive content-type check", () => {
    expect(
      isJson(request(undefined, "", { "content-type": "Application/JSON; charset=utf-8" })),
    ).toBe(true);
    expect(isJson(request(undefined))).toBe(false);
  });
});
