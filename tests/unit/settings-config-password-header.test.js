// YAN-1248: config export/import read the password from the encoding-safe
// `x-tokenhop-password-b64` header (base64url of the UTF-8 bytes), so a
// non-Latin-1 password or one with edge whitespace authenticates; the legacy
// raw `x-9r-password` header still works for ASCII passwords.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "  pässwörd-日本語-😀  ";
const b64 = (pw) => Buffer.from(pw, "utf8").toString("base64url");

const originalDataDir = process.env.DATA_DIR;
const originalInitial = process.env.INITIAL_PASSWORD;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-config-pw-"));
  process.env.DATA_DIR = tempDir;
  process.env.INITIAL_PASSWORD = PASSWORD;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalInitial === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = originalInitial;
});

const exportWith = async (headers) => {
  const { GET } = await import("@/app/api/settings/config/export/route.js");
  return GET(new Request("http://localhost/api/settings/config/export", { headers }));
};

const importWith = async (headers, body) => {
  const { POST } = await import("@/app/api/settings/config/import/route.js");
  return POST(
    new Request("http://localhost/api/settings/config/import", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
};

describe("YAN-1248 config transfer password header", () => {
  it("export accepts a non-Latin-1, edge-whitespace password via the b64 header", async () => {
    const res = await exportWith({ "x-tokenhop-password-b64": b64(PASSWORD) });
    expect(res.status).toBe(200);
    expect((await res.json()).schemaVersion).toBe(1);
  });

  it("export rejects a wrong or trimmed password and a malformed b64 header", async () => {
    expect((await exportWith({ "x-tokenhop-password-b64": b64(PASSWORD.trim()) })).status).toBe(
      401,
    );
    expect((await exportWith({ "x-tokenhop-password-b64": "!!" })).status).toBe(400);
    expect((await exportWith({})).status).toBe(401);
  });

  it("import accepts the b64 header when the body carries no password", async () => {
    const doc = await (await exportWith({ "x-tokenhop-password-b64": b64(PASSWORD) })).json();
    const res = await importWith({ "x-tokenhop-password-b64": b64(PASSWORD) }, { doc });
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
    expect((await importWith({ "x-tokenhop-password-b64": "!!" }, { doc })).status).toBe(400);
    expect((await importWith({}, { doc, password: PASSWORD })).status).toBe(200);
  });
});

describe("YAN-1248 CLI token", () => {
  it("authenticates even when a malformed password header is present", async () => {
    const { getCliToken } = await import("@/lib/auth/cliToken");
    const token = await getCliToken();
    const headers = { "x-9r-cli-token": token, "x-tokenhop-password-b64": "!!" };
    const res = await exportWith(headers);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect((await importWith(headers, { doc })).status).toBe(200);
  });
});

describe("YAN-1248 leading U+FEFF", () => {
  it("is kept as part of the password, not stripped as a BOM", async () => {
    const { readPasswordHeader } = await import("@/lib/users/snapshotUpload.js");
    const pw = "\uFEFFpassword123";
    const headers = new Headers({ "x-tokenhop-password-b64": b64(pw) });
    expect(readPasswordHeader(headers)).toEqual({ value: pw });
    process.env.INITIAL_PASSWORD = pw;
    try {
      expect((await exportWith({ "x-tokenhop-password-b64": b64(pw) })).status).toBe(200);
      expect((await exportWith({ "x-tokenhop-password-b64": b64("password123") })).status).toBe(
        401,
      );
    } finally {
      process.env.INITIAL_PASSWORD = PASSWORD;
    }
  });
});

describe("YAN-1248 legacy x-9r-password header", () => {
  it("is still accepted for ASCII passwords", async () => {
    process.env.INITIAL_PASSWORD = "ascii-pw";
    try {
      expect((await exportWith({ "x-9r-password": "ascii-pw" })).status).toBe(200);
      const doc = await (await exportWith({ "x-9r-password": "ascii-pw" })).json();
      expect((await importWith({ "x-9r-password": "ascii-pw" }, { doc })).status).toBe(200);
      expect((await exportWith({ "x-9r-password": "wrong" })).status).toBe(401);
    } finally {
      process.env.INITIAL_PASSWORD = PASSWORD;
    }
  });
});

describe("YAN-1248 ConfigTransfer client", () => {
  it("sends the export password through passwordHeaders, not the raw header", () => {
    const source = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../src/app/(dashboard)/dashboard/settings/sections/ConfigTransfer.js",
      ),
      "utf8",
    );
    expect(source).toContain("headers: passwordHeaders(password)");
    expect(source).not.toContain('"x-9r-password"');
  });
});
