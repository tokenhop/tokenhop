import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertIsolatedHome, removeUnderHome } from "../helpers/isolatedHome.js";

const require = createRequire(import.meta.url);
const runtimePath = "../../src/mitm/runtimeCredentials.js";
const basePath = "../../src/mitm/handlers/base.js";
const credentialFile = () => path.join(assertIsolatedHome(), "mitm-credential-test");
const remote = (source, env = {}) =>
  require(runtimePath).readRemoteCredential({
    routerBaseUrl: "https://ROUTER.example:443/gateway/",
    source,
    env,
  });

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete require.cache[require.resolve(basePath)];
  await removeUnderHome(["mitm-credential-test"]);
});

describe("MITM runtime credentials", () => {
  it.each([
    [" HTTP://LOCALHOST:80/ ", "http://localhost"],
    ["https://Router.example:443/gateway/api///", "https://router.example/gateway/api"],
    ["http://[::1]:20128/base", "http://[::1]:20128/base"],
  ])("canonicalizes %s while preserving base paths", (input, expected) => {
    expect(require(runtimePath).normalizeRouterBaseUrl(input)).toBe(expected);
  });

  it.each([
    null,
    {},
    "",
    "ftp://host",
    "/relative",
    "https://user:secret@host",
    "https://host?",
    "https://host#",
    "https://ho\nst",
  ])("rejects unsafe router URL %j without echoing input", (input) => {
    expect(() => require(runtimePath).normalizeRouterBaseUrl(input)).toThrow(
      "Invalid MITM router base URL",
    );
  });

  it("reads env fresh each call without mutating or retaining credentials", async () => {
    const env = { OPERATOR_KEY: "first-key" };
    expect(await remote({ type: "env", name: "OPERATOR_KEY" }, env)).toEqual({
      routerBaseUrl: "https://router.example/gateway",
      apiKey: "first-key",
    });
    env.OPERATOR_KEY = "second-key";
    expect((await remote({ type: "env", name: "OPERATOR_KEY" }, env)).apiKey).toBe("second-key");
    expect(env).toEqual({ OPERATOR_KEY: "second-key" });
    vi.stubEnv("MITM_TEST_OPERATOR_KEY", "default-env-key");
    expect(
      (
        await require(runtimePath).readRemoteCredential({
          routerBaseUrl: "http://localhost",
          source: { type: "env", name: "MITM_TEST_OPERATOR_KEY" },
        })
      ).apiKey,
    ).toBe("default-env-key");
  });

  it.each([
    undefined,
    "",
    "   ",
    "one\ntwo",
    "key\n",
    "key\r\n",
    "key\t",
    "key\0",
    "key\u007f",
    "key\u0085",
    "x".repeat(4097),
    "é".repeat(2049),
  ])("rejects invalid env credential without disclosing value", async (value) => {
    await expect(
      remote({ type: "env", name: "OPERATOR_KEY" }, { OPERATOR_KEY: value }),
    ).rejects.toThrow("Invalid MITM remote credential");
  });

  it.each(["", "\n", "\r\n"])("accepts only one optional file line ending %j", async (ending) => {
    await fs.writeFile(credentialFile(), `file-key${ending}`);
    expect((await remote({ type: "file", path: credentialFile() })).apiKey).toBe("file-key");
    expect(await fs.readFile(credentialFile(), "utf8")).toBe(`file-key${ending}`);
  });

  it("strips a leading UTF-8 BOM from file credentials", async () => {
    await fs.writeFile(
      credentialFile(),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("file-key")]),
    );
    expect((await remote({ type: "file", path: credentialFile() })).apiKey).toBe("file-key");
  });

  it.each([
    "",
    "\n",
    "key\n\n",
    "key\r",
    "one\r\ntwo",
    "x".repeat(4097),
    Buffer.from([0xff]),
    "key\u2028other",
  ])("rejects invalid file credential %j", async (value) => {
    await fs.writeFile(credentialFile(), value);
    await expect(remote({ type: "file", path: credentialFile() })).rejects.toThrow(
      "Invalid MITM remote credential",
    );
  });

  it("enforces byte limits including file line endings", async () => {
    expect(
      (await remote({ type: "env", name: "KEY" }, { KEY: "é".repeat(2048) })).apiKey.length,
    ).toBe(2048);
    await fs.writeFile(credentialFile(), `${"x".repeat(4095)}\n`);
    expect((await remote({ type: "file", path: credentialFile() })).apiKey.length).toBe(4095);
    await fs.writeFile(credentialFile(), `${"x".repeat(4096)}\n`);
    await expect(remote({ type: "file", path: credentialFile() })).rejects.toThrow(
      "Invalid MITM remote credential",
    );
  });

  it("rejects invalid sources and masks file paths and OS errors", async () => {
    for (const source of [
      null,
      {},
      { type: "browser", path: "/secret" },
      { type: "env", name: "" },
      { type: "file", path: "" },
      { type: "file", path: `${credentialFile()}-missing` },
    ]) {
      await expect(remote(source)).rejects.toThrow("Invalid MITM remote credential");
    }
    await expect(remote({ type: "file", path: assertIsolatedHome() })).rejects.toThrow(
      "Invalid MITM remote credential",
    );
  });

  it("creates fresh 256-bit keys with SHA256 verifiers and safely checks malformed input", () => {
    const { createLocalCredential, matchesLocalCredential } = require(runtimePath);
    const first = createLocalCredential();
    const second = createLocalCredential();
    expect(first.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.apiKey, "base64url").length).toBe(32);
    expect(first.apiKey).not.toBe(second.apiKey);
    expect(first.verifierHash).toBe(createHash("sha256").update(first.apiKey).digest("hex"));
    expect(matchesLocalCredential(first.apiKey, first.verifierHash)).toBe(true);
    expect(matchesLocalCredential(second.apiKey, first.verifierHash)).toBe(false);
    for (const input of [null, undefined, {}, "", "x".repeat(4097)]) {
      expect(matchesLocalCredential(input, first.verifierHash)).toBe(false);
      expect(matchesLocalCredential(first.apiKey, input)).toBe(false);
    }
    expect(matchesLocalCredential(first.apiKey, `${first.verifierHash.slice(0, 62)}zz`)).toBe(
      false,
    );
  });
});

describe("MITM router header boundary", () => {
  it.each(["configured-child-key", undefined])(
    "strips incoming secrets and proofs with configured key %j",
    async (key) => {
      vi.stubEnv("MITM_ROUTER_BASE", "https://router.invalid/gateway");
      vi.stubEnv("ROUTER_API_KEY", key);
      delete require.cache[require.resolve(basePath)];
      const response = { status: 200 };
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetch);
      const sensitive = [
        "Authorization",
        "X-Api-Key",
        "X-Goog-Api-Key",
        "Api-Key",
        "Cookie",
        "Cookie2",
        "Proxy-Authorization",
        "Proxy-Authenticate",
        "X-9r-Cli-Token",
        "X-9r-Peer-Token",
        "X-9r-Real-Ip",
        "X-9r-Via-Proxy",
        "X-Forwarded-For",
        "X-Forwarded-Proto",
        "X-Forwarded-Host",
        "X-Real-Ip",
        "Forwarded",
        "X-Request-Source",
        "X-Skip-Api-Key-Check",
        "X-Amz-Security-Token",
        "X-Client-Token",
      ];
      const headers = {
        Accept: "application/json",
        "User-Agent": "test-client",
        "X-Request-Id": "req-1",
      };
      for (const name of sensitive) {
        headers[name] = "incoming-secret";
        headers[name.toLowerCase()] = "incoming-secret";
      }
      const original = { ...headers };
      expect(
        await require(basePath).fetchRouter({ model: "test" }, "/v1/chat/completions", headers),
      ).toBe(response);
      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe("https://router.invalid/gateway/v1/chat/completions");
      expect(options.headers).toEqual({
        Accept: "application/json",
        "User-Agent": "test-client",
        "X-Request-Id": "req-1",
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      });
      expect(headers).toEqual(original);
    },
  );
});
