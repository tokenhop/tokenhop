// Guards the Google OAuth clients (Antigravity, Gemini): read from env in one place
// (shared.js), spread into registry + src/lib/oauth, never hard-coded in source.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadOAuthClientDefaults } = createRequire(import.meta.url)("../../custom-server.js");

const writeDefaultsFile = (data) => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "oauth-clients-")),
    "oauth-clients.json",
  );
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};

const ENV = {
  ANTIGRAVITY_OAUTH_CLIENT_ID: "ag-test-client.apps.example",
  ANTIGRAVITY_OAUTH_CLIENT_SECRET: "ag-test-secret",
  GEMINI_OAUTH_CLIENT_ID: "gemini-test-client.apps.example",
  GEMINI_OAUTH_CLIENT_SECRET: "gemini-test-secret",
  META_CODE_OAUTH_CLIENT_ID: "meta-code-test-client",
};
const EXPECTED = {
  clientId: ENV.ANTIGRAVITY_OAUTH_CLIENT_ID,
  clientSecret: ENV.ANTIGRAVITY_OAUTH_CLIENT_SECRET,
};
const GOOGLE = {
  clientId: ENV.GEMINI_OAUTH_CLIENT_ID,
  clientSecret: ENV.GEMINI_OAUTH_CLIENT_SECRET,
};

let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  vi.resetModules();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("google oauth clients (env-sourced)", () => {
  it("shared source reads the antigravity client from env", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual(EXPECTED);
  });

  it("registry transport keeps clientId/clientSecret", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport.clientId).toBe(EXPECTED.clientId);
    expect(ag.transport.clientSecret).toBe(EXPECTED.clientSecret);
  });

  it("google client shared by gemini + gemini-cli", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT).toEqual(GOOGLE);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(GOOGLE.clientSecret);
    expect(gc.transport.clientSecret).toBe(GOOGLE.clientSecret);
  });

  it("is undefined when env is unset and assertOAuthClient names the missing vars", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT, assertOAuthClient } = await import(
      "../../open-sse/providers/shared.js"
    );
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual({ clientId: undefined, clientSecret: undefined });
    expect(() => assertOAuthClient(GOOGLE_OAUTH_CLIENT, "gemini")).toThrow(
      /GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET/,
    );
    expect(() => assertOAuthClient(ANTIGRAVITY_OAUTH_CLIENT, "antigravity")).toThrow(
      /ANTIGRAVITY_OAUTH_CLIENT_ID/,
    );
  });

  // Cold-imports the whole OAuth login path (registry + src/lib/oauth) and can
  // exceed the 5s default under full-suite load — allow extra time.
  it("OAuth login fails fast before building an auth URL when unconfigured", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const { generateAuthData } = await import("../../src/lib/oauth/providers/index.js");
    await expect(generateAuthData("gemini-cli", "http://localhost/callback")).rejects.toThrow(
      /GEMINI_OAUTH_CLIENT_ID/,
    );
    await expect(generateAuthData("antigravity", "http://localhost/callback")).rejects.toThrow(
      /ANTIGRAVITY_OAUTH_CLIENT_ID/,
    );
  }, 20_000);

  it("OAuth login builds the auth URL with the env client id", async () => {
    const { generateAuthData } = await import("../../src/lib/oauth/providers/index.js");
    const { authUrl } = await generateAuthData("gemini-cli", "http://localhost/callback");
    expect(new URL(authUrl).searchParams.get("client_id")).toBe(GOOGLE.clientId);
  }, 20_000);

  it("token refresh returns null and logs when the client is unconfigured", async () => {
    const { refreshGoogleToken } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );
    const log = { error: vi.fn(), info: vi.fn() };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      refreshGoogleToken("refresh-token", undefined, undefined, log),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringMatching(/GEMINI_OAUTH_CLIENT_ID/),
    );
    fetchSpy.mockRestore();
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain(
      'import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"',
    );
    expect(src).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("...GOOGLE_OAUTH_CLIENT");
    // authorizeUrl now lives in registry; oauth.js derives via PROVIDER_OAUTH spread
    expect(src).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(src).toContain('PROVIDER_OAUTH["gemini-cli"]');
  });

  it("no Google OAuth client credentials are hard-coded in source", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    // Split so this file does not match its own search.
    const pattern = ["GOC", "SPX-|[0-9]{6,}-[a-z0-9]{32}\\.apps\\.googleusercontent\\.com"].join(
      "",
    );
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          pattern,
          "--",
          "open-sse",
          "src",
          "cli",
          "tests",
          "scripts",
          ".github",
          "Dockerfile",
          "custom-server.js",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch (e) {
      if (e.status !== 1) throw e; // exit 1 = no matches
    }
    expect(hits).toBe("");
  });
});

describe("loadOAuthClientDefaults", () => {
  const FILE_VALUES = {
    GEMINI_OAUTH_CLIENT_ID: "built-in-gemini.apps.example",
    GEMINI_OAUTH_CLIENT_SECRET: "built-in-gemini-secret",
    ANTIGRAVITY_OAUTH_CLIENT_ID: "built-in-ag.apps.example",
    ANTIGRAVITY_OAUTH_CLIENT_SECRET: "built-in-ag-secret",
    META_CODE_OAUTH_CLIENT_ID: "built-in-meta-code-client",
  };

  it("applies built-ins when env is unset", () => {
    const file = writeDefaultsFile(FILE_VALUES);
    const env = {};
    const applied = loadOAuthClientDefaults(file, env);
    expect(env).toMatchObject(FILE_VALUES);
    expect(applied).toEqual([
      "GEMINI_OAUTH_CLIENT_ID",
      "GEMINI_OAUTH_CLIENT_SECRET",
      "ANTIGRAVITY_OAUTH_CLIENT_ID",
      "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
      "META_CODE_OAUTH_CLIENT_ID",
    ]);
  });

  it("single-key group (META_CODE_OAUTH_CLIENT_ID) is applied and written", () => {
    const file = writeDefaultsFile({ META_CODE_OAUTH_CLIENT_ID: "built-in-meta-code-client" });
    const env = {};
    expect(loadOAuthClientDefaults(file, env)).toEqual(["META_CODE_OAUTH_CLIENT_ID"]);
    expect(env.META_CODE_OAUTH_CLIENT_ID).toBe("built-in-meta-code-client");

    const { writeOAuthClients, checkOAuthClients } = createRequire(import.meta.url)(
      "../../scripts/write-oauth-clients.cjs",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-writer-meta-"));
    expect(
      writeOAuthClients(dir, { META_CODE_OAUTH_CLIENT_ID: " built-in-meta-code-client " }),
    ).toEqual(["META_CODE_OAUTH_CLIENT_ID"]);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "oauth-clients.json"), "utf8"));
    expect(written.META_CODE_OAUTH_CLIENT_ID).toBe("built-in-meta-code-client");
    expect(checkOAuthClients(dir)).toBe(false); // other groups still missing
  });

  it("env wins pair-wise: gemini untouched, antigravity applied", () => {
    const file = writeDefaultsFile(FILE_VALUES);
    const env = { GEMINI_OAUTH_CLIENT_ID: "mine" };
    loadOAuthClientDefaults(file, env);
    expect(env.GEMINI_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.ANTIGRAVITY_OAUTH_CLIENT_ID).toBe(FILE_VALUES.ANTIGRAVITY_OAUTH_CLIENT_ID);
    expect(env.ANTIGRAVITY_OAUTH_CLIENT_SECRET).toBe(FILE_VALUES.ANTIGRAVITY_OAUTH_CLIENT_SECRET);
  });

  it("missing file is a no-op returning []", () => {
    expect(
      loadOAuthClientDefaults(path.join(os.tmpdir(), "oauth-clients-missing.json"), {}),
    ).toEqual([]);
  });

  it("shared client falls back to built-ins: env empty + loader + fresh import", async () => {
    const file = writeDefaultsFile(FILE_VALUES);
    for (const k of Object.keys(ENV)) delete process.env[k];
    loadOAuthClientDefaults(file, process.env);
    vi.resetModules();
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT).toEqual({
      clientId: FILE_VALUES.GEMINI_OAUTH_CLIENT_ID,
      clientSecret: FILE_VALUES.GEMINI_OAUTH_CLIENT_SECRET,
    });
  });

  it("writer round trip: complete pairs only, trimmed, values never logged", () => {
    const { writeOAuthClients, checkOAuthClients } = createRequire(import.meta.url)(
      "../../scripts/write-oauth-clients.cjs",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-writer-"));
    const logs = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    const warn = vi.spyOn(console, "warn").mockImplementation((...a) => logs.push(a.join(" ")));
    try {
      const partial = {
        GEMINI_OAUTH_CLIENT_ID: ` ${FILE_VALUES.GEMINI_OAUTH_CLIENT_ID} `,
        GEMINI_OAUTH_CLIENT_SECRET: FILE_VALUES.GEMINI_OAUTH_CLIENT_SECRET,
        ANTIGRAVITY_OAUTH_CLIENT_ID: FILE_VALUES.ANTIGRAVITY_OAUTH_CLIENT_ID,
      };
      expect(writeOAuthClients(dir, partial)).toEqual([
        "GEMINI_OAUTH_CLIENT_ID",
        "GEMINI_OAUTH_CLIENT_SECRET",
      ]);
      expect(checkOAuthClients(dir)).toBe(false); // publish needs both providers
      const env = {};
      loadOAuthClientDefaults(path.join(dir, "oauth-clients.json"), env);
      expect(env).toEqual({
        GEMINI_OAUTH_CLIENT_ID: FILE_VALUES.GEMINI_OAUTH_CLIENT_ID,
        GEMINI_OAUTH_CLIENT_SECRET: FILE_VALUES.GEMINI_OAUTH_CLIENT_SECRET,
      });

      writeOAuthClients(dir, FILE_VALUES);
      expect(checkOAuthClients(dir)).toBe(true);
      for (const value of Object.values(FILE_VALUES)) {
        expect(logs.join("\n")).not.toContain(value);
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
