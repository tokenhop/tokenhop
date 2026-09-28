import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_PROVIDERS,
  PROXY_OAUTH_PROVIDERS,
  buildDeviceExtraData,
  buildProxyRegisterBody,
  buildRedirectUri,
  classifyDevicePoll,
  devicePollTimeoutMs,
  flowCancelled,
  isLocalhostHostname,
  isTrustedCallbackOrigin,
  nextDevicePollInterval,
  parseManualCallback,
  parseSocialCallback,
  resolveProxyPollProvider,
} from "../../src/shared/components/oauth/authFlowHelpers.js";

describe("isLocalhostHostname", () => {
  it("accepts only localhost and 127.0.0.1", () => {
    expect(isLocalhostHostname("localhost")).toBe(true);
    expect(isLocalhostHostname("127.0.0.1")).toBe(true);
    expect(isLocalhostHostname("0.0.0.0")).toBe(false);
    expect(isLocalhostHostname("example.com")).toBe(false);
    expect(isLocalhostHostname("")).toBe(false);
  });
});

describe("buildRedirectUri", () => {
  it("uses fixed ports for codex and xai", () => {
    expect(buildRedirectUri("codex", "20128", "http:")).toBe("http://localhost:1455/auth/callback");
    expect(buildRedirectUri("xai", "20128", "http:")).toBe("http://127.0.0.1:56121/callback");
  });

  it("uses the app port otherwise", () => {
    expect(buildRedirectUri("gitlab", "20128", "http:")).toBe("http://localhost:20128/callback");
    expect(buildRedirectUri("gitlab", "", "https:")).toBe("http://localhost:443/callback");
  });
});

describe("device code flow", () => {
  it("covers the wired providers", () => {
    for (const p of [
      "github",
      "kiro",
      "kimi",
      "kimi-coding",
      "kilocode",
      "codebuddy-cn",
      "codebuddy-intl",
      "qoder",
      "grok-cli",
      "meta-code",
    ])
      expect(DEVICE_CODE_PROVIDERS.has(p)).toBe(true);
    expect(DEVICE_CODE_PROVIDERS.has("gitlab")).toBe(false);
  });

  it("builds provider extraData", () => {
    expect(
      buildDeviceExtraData("kiro", {
        _clientId: "c",
        _clientSecret: "s",
        _region: "r",
        _authMethod: "m",
        _startUrl: "u",
      }),
    ).toEqual({
      _clientId: "c",
      _clientSecret: "s",
      _region: "r",
      _authMethod: "m",
      _startUrl: "u",
    });
    expect(
      buildDeviceExtraData("qoder", {
        _qoderNonce: "n",
        _qoderMachineId: "m",
        codeVerifier: "v",
      }),
    ).toEqual({ _qoderNonce: "n", _qoderMachineId: "m", _qoderVerifier: "v" });
    expect(buildDeviceExtraData("kimi", { _kimiDeviceId: "d" })).toEqual({ _kimiDeviceId: "d" });
    expect(buildDeviceExtraData("kimi-coding", { _kimiDeviceId: "d" })).toEqual({
      _kimiDeviceId: "d",
    });
    expect(buildDeviceExtraData("github", {})).toBe(null);
  });

  it("honors upstream expires_in with a 120s default", () => {
    expect(devicePollTimeoutMs(300)).toBe(300_000);
    expect(devicePollTimeoutMs(undefined)).toBe(120_000);
    expect(devicePollTimeoutMs(0)).toBe(120_000);
    expect(devicePollTimeoutMs(Number.NaN)).toBe(120_000);
  });

  it("backs off on slow_down capped at 30s", () => {
    expect(nextDevicePollInterval(5, true)).toBe(10);
    expect(nextDevicePollInterval(28, true)).toBe(30);
    expect(nextDevicePollInterval(5, false)).toBe(5);
  });

  it("classifies poll responses", () => {
    expect(classifyDevicePoll({ success: true }).kind).toBe("done");
    expect(classifyDevicePoll({ error: "slow_down" }).kind).toBe("slow-down");
    expect(classifyDevicePoll({ error: "expired_token", errorDescription: "gone" })).toEqual({
      kind: "fatal",
      message: "gone",
    });
    expect(classifyDevicePoll({ error: "access_denied" })).toEqual({
      kind: "fatal",
      message: "access_denied",
    });
    expect(classifyDevicePoll({ error: "authorization_pending" }).kind).toBe("pending");
    expect(classifyDevicePoll({}).kind).toBe("pending");
  });
});

describe("proxy poll provider resolution", () => {
  it("prefers codex, then xai, then the dynamic proxy", () => {
    expect(resolveProxyPollProvider({ codexServerSide: true, state: "s" })).toBe("codex");
    expect(resolveProxyPollProvider({ xaiServerSide: true, state: "s" })).toBe("xai");
    expect(resolveProxyPollProvider({ proxyProvider: "zed", state: "s" })).toBe("zed");
    expect(resolveProxyPollProvider({ state: "s" })).toBe(null);
    expect(resolveProxyPollProvider({ proxyProvider: "zed" })).toBe(null);
    expect(resolveProxyPollProvider(null)).toBe(null);
  });

  it("knows the dynamic-port proxy providers", () => {
    expect(PROXY_OAUTH_PROVIDERS.has("trae")).toBe(true);
    expect(PROXY_OAUTH_PROVIDERS.has("windsurf")).toBe(true);
    expect(PROXY_OAUTH_PROVIDERS.has("zed")).toBe(true);
    expect(PROXY_OAUTH_PROVIDERS.has("codex")).toBe(false);
  });

  it("threads attempt material into register-session", () => {
    expect(buildProxyRegisterBody({ state: "s" })).toEqual({ state: "s" });
    expect(buildProxyRegisterBody({ state: "s", codeVerifier: "v", systemId: "i" })).toEqual({
      state: "s",
      codeVerifier: "v",
      systemId: "i",
    });
  });
});

describe("isTrustedCallbackOrigin", () => {
  const app = "http://x:1";

  it("trusts the exact app origin and loopback hosts on any port", () => {
    expect(isTrustedCallbackOrigin(app, app)).toBe(true);
    expect(isTrustedCallbackOrigin("http://localhost:1455", app)).toBe(true); // codex
    expect(isTrustedCallbackOrigin("http://127.0.0.1:56121", app)).toBe(true); // xai
    expect(isTrustedCallbackOrigin("http://[::1]:1455", app)).toBe(true);
    expect(isTrustedCallbackOrigin("http://localhost", app)).toBe(true);
    expect(isTrustedCallbackOrigin("https://localhost", app)).toBe(true);
    expect(isTrustedCallbackOrigin("https://127.0.0.1:9", app)).toBe(true);
  });

  it("rejects substring lookalikes and non-loopback hosts", () => {
    expect(isTrustedCallbackOrigin("http://localhost.evil.com", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://127.0.0.1.evil.com", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://evil.com?localhost", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://localhostx.com", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://127.0.0.10", app)).toBe(false);
    expect(isTrustedCallbackOrigin("https://evil.test", app)).toBe(false);
  });

  it("rejects malformed, opaque and non-http origins", () => {
    expect(isTrustedCallbackOrigin("null", app)).toBe(false);
    expect(isTrustedCallbackOrigin("", app)).toBe(false);
    expect(isTrustedCallbackOrigin("not a url", app)).toBe(false);
    expect(isTrustedCallbackOrigin(null, app)).toBe(false);
    expect(isTrustedCallbackOrigin(undefined, app)).toBe(false);
    expect(isTrustedCallbackOrigin("file://localhost/x", app)).toBe(false);
    expect(isTrustedCallbackOrigin("ftp://localhost:21", app)).toBe(false);
  });

  it("only accepts exact origin strings, not paths or credentials", () => {
    expect(isTrustedCallbackOrigin("http://localhost:1455/", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://localhost:1455/auth/callback", app)).toBe(false);
    expect(isTrustedCallbackOrigin("http://user@localhost:1455", app)).toBe(false);
  });
});

describe("flowCancelled", () => {
  it("is cancelled only when the modal is closed", () => {
    expect(flowCancelled({ current: true })).toBe(false);
    expect(flowCancelled({ current: false })).toBe(true);
    expect(flowCancelled(null)).toBe(true);
    expect(flowCancelled(undefined)).toBe(true);
  });
});

describe("parseManualCallback", () => {
  const auth = { state: "st", redirectUri: "r", codeVerifier: "v", systemId: "i" };

  it("detects raw JWT access tokens", () => {
    expect(parseManualCallback("gitlab", "eyJ.hdr.pay", {})).toEqual({
      kind: "exchange",
      code: "eyJ.hdr.pay",
      state: null,
    });
  });

  it("routes bare xAI codes and bare kimchi tokens", () => {
    expect(parseManualCallback("xai", "abc123", {})).toEqual({
      kind: "xai-manual",
      code: "abc123",
    });
    expect(parseManualCallback("kimchi", "tok", {})).toEqual({
      kind: "exchange",
      code: "tok",
      state: null,
    });
  });

  it("routes proxy providers to the manual proxy exchange", () => {
    expect(parseManualCallback("zed", "http://127.0.0.1:9/?x=1", auth)).toEqual({
      kind: "proxy-manual",
      code: "http://127.0.0.1:9/?x=1",
    });
  });

  it("parses callback URLs, preferring token over code", () => {
    expect(parseManualCallback("gitlab", "http://h/cb?code=c&state=s", auth)).toEqual({
      kind: "exchange",
      code: "c",
      state: "s",
    });
    expect(parseManualCallback("gitlab", "http://h/cb?code=c&token=t", auth)).toEqual({
      kind: "exchange",
      code: "t",
      state: null,
    });
  });

  it("reports provider-specific errors", () => {
    expect(parseManualCallback("gitlab", "http://h/cb?error=nope", auth)).toEqual({
      kind: "error",
      message: "nope",
    });
    expect(
      parseManualCallback("gitlab", "http://h/cb?error=e&error_description=why", auth).message,
    ).toBe("why");
    expect(parseManualCallback("gitlab", "http://h/cb", auth).message).toBe(
      "No authorization code found in URL",
    );
    expect(parseManualCallback("xai", "http://h/cb", auth).message).toBe(
      "Paste the callback URL or copied xAI code",
    );
    expect(parseManualCallback("kimchi", "http://h/cb", auth).message).toBe(
      "No Kimchi token found in URL",
    );
  });

  it("surfaces the URL parser error for unparseable input", () => {
    const result = parseManualCallback("gitlab", "not a url", auth);
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/Invalid URL/);
  });
});

describe("parseSocialCallback", () => {
  it("extracts the code from kiro:// and http callbacks", () => {
    expect(
      parseSocialCallback("kiro://kiro.kiroAgent/authenticate-success?code=c&state=s"),
    ).toEqual({ kind: "code", code: "c" });
    expect(parseSocialCallback("http://localhost/cb?code=x")).toEqual({ kind: "code", code: "x" });
  });

  it("reports malformed, errored and code-less callbacks", () => {
    expect(parseSocialCallback("nope").message).toBe("Invalid callback URL format");
    expect(parseSocialCallback("http://h/?error=e&error_description=d").message).toBe("d");
    expect(parseSocialCallback("http://h/?error=e").message).toBe("e");
    expect(parseSocialCallback("http://h/").message).toBe("No authorization code found in URL");
  });
});
