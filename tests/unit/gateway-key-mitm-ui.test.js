// YAN-363 MITM server UI: start-request contract against the REAL exported
// helper the component ships (mitmStartRequest.js) — no mirror, no source
// scan as sole proof. Source guards only pin UI wiring (status gating,
// retention behavior, error guidance). No real MITM/network/sudo.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  bindRemoteKey,
  buildMitmStartBody,
} from "../../src/app/(dashboard)/dashboard/cli-tools/components/mitmStartRequest.js";

const FILE = resolve(
  import.meta.dirname,
  "../../src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js",
);
const source = readFileSync(FILE, "utf8");

const baseBody = {
  sudoPassword: "pw",
  mitmRouterBaseUrl: "http://localhost:20128",
  forceKillPort443: false,
};

describe("buildMitmStartBody — hashed", () => {
  it("omits apiKey for a configured source so the server keeps it", () => {
    for (const status of [
      { needsCredential: false, credentialConfigured: true }, // internal/env/file/manual
      { needsCredential: undefined, credentialConfigured: true },
    ]) {
      const body = buildMitmStartBody({ hashed: true, status, ...baseBody });
      expect(body).not.toHaveProperty("apiKey");
      expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("apiKey");
    }
  });

  it("sends only the key pasted for the exact destination being started", () => {
    const binding = bindRemoteKey("  sk-pasted  ", "http://localhost:20128/");
    const body = buildMitmStartBody({
      hashed: true,
      status: { needsCredential: true, credentialConfigured: false },
      ...baseBody,
      remoteKeyBinding: binding,
    });
    expect(body.apiKey).toBe("sk-pasted");
  });

  it("rejects a paste retained across a destination change (wrong-host guard)", () => {
    const binding = bindRemoteKey("sk-pasted", "http://old-host:20128");
    const body = buildMitmStartBody({
      hashed: true,
      status: { needsCredential: true, credentialConfigured: false },
      ...baseBody,
      remoteKeyBinding: binding,
    });
    expect(body).not.toHaveProperty("apiKey");
  });

  it("never substitutes defaults, prefixes, or refs when no key is pasted", () => {
    const body = buildMitmStartBody({
      hashed: true,
      status: { needsCredential: true, credentialConfigured: false },
      ...baseBody,
      remoteKeyBinding: null,
    });
    expect(body).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toMatch(/sk_tokenhop|th_|apiKeyId/);
  });

  it("normalizes destinations the same way on paste and start", () => {
    const binding = bindRemoteKey("sk-pasted", "http://host:20128/");
    const body = buildMitmStartBody({
      hashed: true,
      status: { needsCredential: true, credentialConfigured: false },
      ...baseBody,
      mitmRouterBaseUrl: "http://host:20128",
      remoteKeyBinding: binding,
    });
    expect(body.apiKey).toBe("sk-pasted");
  });
});

describe("buildMitmStartBody — legacy byte-identical", () => {
  it("keeps selected → first → default fallback exactly", () => {
    expect(
      buildMitmStartBody({
        hashed: false,
        status: null,
        ...baseBody,
        legacyKey: "sk-selected",
        legacyFallback: { firstKey: "sk-first", defaultKey: "sk_tokenhop" },
      }).apiKey,
    ).toBe("sk-selected");
    expect(
      buildMitmStartBody({
        hashed: false,
        status: null,
        ...baseBody,
        legacyKey: "",
        legacyFallback: { firstKey: "sk-first", defaultKey: "sk_tokenhop" },
      }).apiKey,
    ).toBe("sk-first");
    expect(
      buildMitmStartBody({
        hashed: false,
        status: null,
        ...baseBody,
        legacyKey: "",
        legacyFallback: { firstKey: null, defaultKey: "sk_tokenhop" },
      }).apiKey,
    ).toBe("sk_tokenhop");
    expect(
      buildMitmStartBody({
        hashed: false,
        status: null,
        ...baseBody,
        legacyKey: "",
        legacyFallback: { firstKey: null, defaultKey: null },
      }),
    ).not.toHaveProperty("apiKey");
  });
});

describe("MitmServerCard wiring (source-level, real helper imported)", () => {
  it("imports and uses the real helper for start bodies", () => {
    expect(source).toContain(
      'import { buildMitmStartBody, bindRemoteKey } from "./mitmStartRequest"',
    );
    expect(source).toContain("buildMitmStartBody({");
    expect(source).toContain("bindRemoteKey(remoteKey, targetUrl)");
    expect(source).not.toContain("buildHashedStartBody");
  });

  it("destination change clears the paste for every hashed source, not just manual", () => {
    expect(source).toContain("onMitmRouterBaseUrlChange");
    expect(source).toContain('if (hashed && remoteKey) setRemoteKey("")');
    expect(source).not.toContain('status?.credentialSource === "manual"');
  });

  it("clears the transient key in finally on every outcome except the explicit retry", () => {
    expect(source).toContain("let retainKeyForRetry = false");
    expect(source).toContain("retainKeyForRetry = true");
    expect(source).toContain('if (!retainKeyForRetry) setRemoteKey("")');
    // The 409 guidance path does NOT keep the secret; retry copy lives in the
    // message, not the key.
    expect(source).toContain("MITM_STARTUP_SOURCE_LOCKED");
    expect(source).toContain("uses the operator startup source");
  });

  it("disables Start when the status is unknown or its refresh failed", () => {
    expect(source).toContain(
      "disabled={loading || !status || statusFailed || (serverIsWindows && !isAdmin)}",
    );
    expect(source).toContain(
      "Status unavailable — start is disabled until the server reports the storage mode",
    );
    expect(source).toMatch(/No\s+key\s+fallback\s+is\s+assumed\./);
  });

  it("keeps the legacy key row and fallback path byte-identical", () => {
    expect(source).toContain("legacyKey: !hashed ? selectedApiKey : null");
    expect(source).toContain("firstKey: apiKeys?.length > 0 ? apiKeys[0].key : null");
    expect(source).toContain("defaultKey: !cloudEnabled ? ACTIVE.defaultApiKey : null");
    expect(source).toContain(
      'placeholder={\n                      cloudEnabled ? "Enter or pick API key"',
    );
  });
});
