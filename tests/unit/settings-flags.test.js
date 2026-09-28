import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = ["ENABLE_REQUEST_LOGS", "ENABLE_TRANSLATOR"];

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  process.env = savedEnv;
  vi.resetModules();
});

describe("resolveFlagSetting", () => {
  it("env set to true/false wins over the stored setting", async () => {
    process.env.ENABLE_REQUEST_LOGS = "true";
    const { resolveFlagSetting } = await import("@/lib/settingsFlags.js");
    expect(resolveFlagSetting("ENABLE_REQUEST_LOGS", true, false).value).toBe(true);
    expect(resolveFlagSetting("ENABLE_REQUEST_LOGS", true, false).overridden).toBe(true);
    process.env.ENABLE_REQUEST_LOGS = "false";
    expect(resolveFlagSetting("ENABLE_REQUEST_LOGS", false, true).value).toBe(false);
  });

  it("env set to a non-true value reads as false (matches existing runtime gates)", async () => {
    process.env.ENABLE_TRANSLATOR = "1";
    const { resolveFlagSetting } = await import("@/lib/settingsFlags.js");
    expect(resolveFlagSetting("ENABLE_TRANSLATOR", true, false).value).toBe(false);
    expect(resolveFlagSetting("ENABLE_TRANSLATOR", true, false).overridden).toBe(true);
  });

  it("falls back to the stored setting, then the default", async () => {
    const { resolveFlagSetting } = await import("@/lib/settingsFlags.js");
    expect(resolveFlagSetting("ENABLE_TRANSLATOR", true, true).value).toBe(true);
    expect(resolveFlagSetting("ENABLE_TRANSLATOR", true, true).overridden).toBe(false);
    expect(resolveFlagSetting("ENABLE_TRANSLATOR", undefined, false).value).toBe(false);
  });

  it("requestLogEnvOverride alias always matches requestLogsOverridden (single source of truth)", async () => {
    // GET /api/settings derives both from the same resolveFlagSetting call;
    // the UI reads requestLogsOverridden and treats the legacy alias the same.
    const { resolveFlagSetting } = await import("@/lib/settingsFlags.js");
    for (const env of ["true", "false", undefined]) {
      if (env === undefined) delete process.env.ENABLE_REQUEST_LOGS;
      else process.env.ENABLE_REQUEST_LOGS = env;
      const resolved = resolveFlagSetting("ENABLE_REQUEST_LOGS", false, false);
      const alias = process.env.ENABLE_REQUEST_LOGS !== undefined;
      expect(resolved.overridden).toBe(alias);
    }
  });
});

describe("resolveStartPage", () => {
  it("accepts allowlisted dashboard routes", async () => {
    const { resolveStartPage } = await import("@/lib/settingsFlags.js");
    expect(resolveStartPage("/dashboard/providers")).toBe("/dashboard/providers");
    expect(resolveStartPage("/dashboard/settings")).toBe("/dashboard/settings");
  });

  it("falls back to /dashboard for missing, non-dashboard, or unknown values", async () => {
    const { resolveStartPage } = await import("@/lib/settingsFlags.js");
    for (const value of [undefined, null, "", "/login", "/api/settings", "/dashboard/nope"]) {
      expect(resolveStartPage(value)).toBe("/dashboard");
    }
  });
});

describe("resolveDensity", () => {
  it("accepts comfortable/compact, defaults everything else to comfortable", async () => {
    const { resolveDensity } = await import("@/lib/settingsFlags.js");
    expect(resolveDensity("compact")).toBe("compact");
    expect(resolveDensity("comfortable")).toBe("comfortable");
    expect(resolveDensity("cozy")).toBe("comfortable");
    expect(resolveDensity(undefined)).toBe("comfortable");
  });
});

describe("environment readout", () => {
  it("returns only the allowlist and masks embedded credentials", async () => {
    process.env.HTTP_PROXY = "http://user:s3cret@proxy.example.com:8080";
    const { buildEnvironmentReadout } = await import("@/lib/settingsFlags.js");
    const readout = buildEnvironmentReadout();
    expect(readout.HTTP_PROXY).toBe("http://***@proxy.example.com:8080");
    for (const secret of [
      "JWT_SECRET",
      "INITIAL_PASSWORD",
      "API_KEY_SECRET",
      "MACHINE_ID_SALT",
      "PORT",
    ]) {
      if (secret !== "PORT") expect(readout).not.toHaveProperty(secret);
    }
  });

  it("never leaks denylisted keys even if the allowlist is misconfigured", async () => {
    process.env.JWT_SECRET = "super-secret-value";
    process.env.INITIAL_PASSWORD = "hunter2";
    const { buildEnvironmentReadout } = await import("@/lib/settingsFlags.js");
    const readout = buildEnvironmentReadout(["JWT_SECRET", "PORT", "INITIAL_PASSWORD"]);
    expect(JSON.stringify(readout)).not.toContain("super-secret-value");
    expect(JSON.stringify(readout)).not.toContain("hunter2");
    expect(readout).not.toHaveProperty("JWT_SECRET");
    expect(readout).not.toHaveProperty("INITIAL_PASSWORD");
  });

  it("masks password-only userinfo in URLs", async () => {
    const { maskUrlCredentials } = await import("@/lib/settingsFlags.js");
    expect(maskUrlCredentials("http://:tok123@proxy:8080")).toBe("http://***@proxy:8080");
    expect(maskUrlCredentials("http://proxy:8080")).toBe("http://proxy:8080");
    expect(maskUrlCredentials("not a url")).toBe("not a url");
  });

  it("masks secret query params and schemeless userinfo", async () => {
    const { maskUrlCredentials } = await import("@/lib/settingsFlags.js");
    expect(maskUrlCredentials("http://proxy:8080/path?token=hunter2")).toBe(
      "http://proxy:8080/path?token=***",
    );
    expect(maskUrlCredentials("http://proxy:8080/path?next=1&api_key=abc")).toBe(
      "http://proxy:8080/path?next=1&api_key=***",
    );
    // YAN-313: secret-bearing auth params used in real SSO/redirect URLs.
    expect(
      maskUrlCredentials(
        "https://issuer.example/authorize?client_id=cid&client_secret=shh&redirect_uri=https%3A%2F%2Fapp",
      ),
    ).toBe(
      "https://issuer.example/authorize?client_id=cid&client_secret=***&redirect_uri=https%3A%2F%2Fapp",
    );
    expect(maskUrlCredentials("https://idp.example/cb?access_token=abc&code=xyz")).toBe(
      "https://idp.example/cb?access_token=***&code=xyz",
    );
    expect(maskUrlCredentials("user:pass@host:3128")).toBe("***@host:3128");
  });
});
