// YAN-605 / YAN-606 / YAN-607: settings routes must not leak credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalInitial = process.env.INITIAL_PASSWORD;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-settings-secrets-"));
  process.env.DATA_DIR = tempDir;
  process.env.INITIAL_PASSWORD = "initial-pw";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalInitial === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = originalInitial;
});

const req = (url, init = {}) => new Request(`http://localhost${url}`, init);

describe("database export/import re-auth (YAN-605)", () => {
  const exportWith = async (headers) => {
    const { GET } = await import("@/app/api/settings/database/route.js");
    return GET(req("/api/settings/database", { headers }));
  };
  const importWith = async (headers, body) => {
    const { POST } = await import("@/app/api/settings/database/route.js");
    return POST(
      req("/api/settings/database", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  };

  it("rejects a missing or wrong CLI token without a password", async () => {
    expect((await exportWith({})).status).toBe(401);
    expect((await exportWith({ "x-9r-cli-token": "x" })).status).toBe(401);
    expect((await exportWith({ "x-9r-password": "wrong" })).status).toBe(401);
    expect((await importWith({ "x-9r-cli-token": "x" }, {})).status).toBe(401);
  });

  it("accepts the real CLI token or the dashboard password", async () => {
    const { getCliToken } = await import("@/lib/auth/cliToken");
    const token = await getCliToken();
    expect((await exportWith({ "x-9r-cli-token": token })).status).toBe(200);
    expect((await exportWith({ "x-9r-password": "initial-pw" })).status).toBe(200);
    const payload = await (await exportWith({ "x-9r-password": "initial-pw" })).json();
    expect((await importWith({ "x-9r-cli-token": token }, payload)).status).toBe(200);
    expect((await importWith({}, { ...payload, password: "initial-pw" })).status).toBe(200);
  });
});

describe("public require-login response (YAN-606)", () => {
  it("returns only requireLogin, never tunnel or Tailscale URLs", async () => {
    await db.updateSettings({
      tunnelUrl: "https://secret.trycloudflare.com",
      tailscaleUrl: "https://box.tail123.ts.net",
    });
    const { GET } = await import("@/app/api/settings/require-login/route.js");
    expect(await (await GET()).json()).toEqual({ requireLogin: true });
  });
});

describe("settings API omits credentials (YAN-607)", () => {
  it("GET and PATCH responses contain no secret keys", async () => {
    await db.updateSettings({
      mitmSudoEncrypted: "enc:sudo",
      samlPrivateKey: "-----BEGIN PRIVATE KEY-----",
      oidcIssuerUrl: "https://idp.example",
      oidcClientId: "client",
      oidcClientSecret: "shh",
    });
    const { GET, PATCH } = await import("@/app/api/settings/route.js");
    const { SECRET_SETTING_KEYS } = await import("@/lib/settingsConfigDoc");
    const got = await (await GET()).json();
    const patched = await (
      await PATCH(
        req("/api/settings", { method: "PATCH", body: JSON.stringify({ requireLogin: true }) }),
      )
    ).json();
    for (const body of [got, patched]) {
      for (const key of SECRET_SETTING_KEYS) expect(body).not.toHaveProperty(key);
      expect(body.oidcConfigured).toBe(true);
    }
  });
});
