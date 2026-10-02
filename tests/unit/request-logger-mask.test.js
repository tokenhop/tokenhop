import { describe, expect, it } from "vitest";
import { maskSensitiveHeaders } from "../../open-sse/utils/requestLogger.js";

describe("maskSensitiveHeaders (YAN-650)", () => {
  it("masks credential headers, keeps others, handles Headers, and never mutates the input", () => {
    const headers = {
      Authorization: "Bearer ya29.a0ARrdaM-long-oauth-token-1234567890abcdef",
      "Proxy-Authorization": "Basic dXNlcjpwYXNzd29yZA==",
      "x-api-key": "sk-ant-api03-secret-key-value-1234567890",
      "X-Goog-Api-Key": "AIzaSyA-very-long-google-api-key-1234567890",
      Cookie: "session=short",
      "Set-Cookie": "session=deadbeefdeadbeefdeadbeefdeadbeef",
      "x-client-token": "tiny-token",
      "X-Shared-Secret": "topsecretvalue1234567890123",
      "X-Model-Key": "qoder-model-key-1234567890abcdef",
      "x-iflow-signature": "sig-1234567890abcdef1234",
      "chatgpt-account-id": "acct-1234",
      "Content-Type": "application/json",
    };
    const snapshot = { ...headers };
    const masked = maskSensitiveHeaders(headers);

    expect(headers).toEqual(snapshot); // caller's object untouched
    expect(masked.Authorization).not.toContain("ya29.a0ARrdaM");
    expect(masked.Authorization).toBe("Bear...cdef");
    expect(masked["Proxy-Authorization"]).toBe("Basi...ZA==");
    expect(masked["x-api-key"]).not.toContain("sk-ant-api03");
    expect(masked["X-Goog-Api-Key"]).not.toContain("AIzaSyA");
    expect(masked.Cookie).toBe("***"); // short value fully masked
    expect(masked["Set-Cookie"]).not.toContain("deadbeef");
    expect(masked["x-client-token"]).toBe("***"); // "token" substring match
    expect(masked["X-Shared-Secret"]).not.toContain("topsecret");
    expect(masked["X-Model-Key"]).not.toContain("qoder-model-key");
    expect(masked["x-iflow-signature"]).toBe("sig-...1234");
    expect(masked["chatgpt-account-id"]).toBe("***");
    expect(masked["Content-Type"]).toBe("application/json");
    expect(maskSensitiveHeaders(null)).toEqual({});

    const h = new Headers({ authorization: "Bearer tok-1234567890abcdefghijk" });
    const maskedH = maskSensitiveHeaders(h);
    expect(maskedH.authorization).not.toContain("tok-1234567890");
    expect(maskedH.authorization).toBe("Bear...hijk");
  });
});
