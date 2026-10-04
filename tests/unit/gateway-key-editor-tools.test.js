// YAN-363 editor-tool routes (Cline, Kilo Code): hashed storage adds
// storage/credentialConfigured metadata without ever returning the raw
// secret; POST reuses the disk secret only for the SAME normalized endpoint,
// requires an explicit replacement otherwise, and invents no default key.
// Legacy storage keeps the exact prior contract (apiKey required).
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import { getAdapter } from "@/lib/db/driver.js";

const home = assertIsolatedHome();
const KID = "0123456789abcdef";
const SECRET = "th_EDITOR_DISK_SECRET";
const BASE = "http://127.0.0.1:20128";

const clineGlobal = () => path.join(home, ".cline", "data", "globalState.json");
const clineSecrets = () => path.join(home, ".cline", "data", "secrets.json");
const kiloAuth = () => path.join(home, ".local", "share", "kilo", "auth.json");

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf-8"));
const raw = (file) => fs.readFile(file, "utf-8");
const post = (body) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

async function setStorage(mode) {
  const db = await getAdapter();
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  if (mode === "hashed") {
    db.run(
      "INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
      [KID],
    );
  }
}

let cline;
let kilo;

function seedCline() {
  return Promise.all([
    writeJson(clineGlobal(), {
      actModeApiProvider: "openai",
      openAiBaseUrl: BASE,
      openAiModelId: "old-model",
      unrelated: "keep",
    }),
    writeJson(clineSecrets(), { openAiApiKey: SECRET, otherSecret: "keep" }),
  ]);
}

function seedKilo() {
  return writeJson(kiloAuth(), {
    "openai-compatible": { type: "api-key", apiKey: SECRET, baseUrl: `${BASE}/v1`, model: "old" },
    otherProvider: { apiKey: "ext-keep" },
  });
}

beforeEach(async () => {
  await fs.rm(path.join(home, ".cline"), { recursive: true, force: true });
  await fs.rm(path.join(home, ".local"), { recursive: true, force: true });
  await setStorage("hashed");
  cline = await import("@/app/api/cli-tools/cline-settings/route.js");
  kilo = await import("@/app/api/cli-tools/kilo-settings/route.js");
});

describe.each([
  [
    "cline",
    () => ({
      get: cline.GET,
      post: cline.POST,
      seed: seedCline,
      state: clineGlobal,
      secret: clineSecrets,
    }),
    (body) => post(body),
  ],
  [
    "kilo",
    () => ({ get: kilo.GET, post: kilo.POST, seed: seedKilo, state: kiloAuth, secret: kiloAuth }),
    (body) => post(body),
  ],
])("%s-settings under hashed storage", (_name, load, send) => {
  it("GET reports storage and credentialConfigured, never the raw secret", async () => {
    const t = load();
    await t.seed();
    const body = await (await t.get()).json();
    expect(body.storage).toBe("hashed");
    expect(body.credentialConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("POST omitted key on the SAME normalized endpoint reuses the disk secret", async () => {
    const t = load();
    await t.seed();
    const res = await t.post(send({ baseUrl: `${BASE}/v1/`, model: "new-model" }));
    expect(res.status).toBe(200);
    const secretFile = await readJson(t.secret());
    const value =
      _name === "cline" ? secretFile.openAiApiKey : secretFile["openai-compatible"].apiKey;
    expect(value).toBe(SECRET);
    expect(JSON.stringify(secretFile)).toContain("keep");
  });

  it("POST with an explicit pasted key applies the replacement", async () => {
    const t = load();
    await t.seed();
    const res = await t.post(
      send({ baseUrl: "http://other-host:9", apiKey: "th_NEW", model: "m" }),
    );
    expect(res.status).toBe(200);
    const secretFile = await readJson(t.secret());
    const value =
      _name === "cline" ? secretFile.openAiApiKey : secretFile["openai-compatible"].apiKey;
    expect(value).toBe("th_NEW");
  });

  it("POST changed endpoint without a key is 400 with zero disk mutation", async () => {
    const t = load();
    await t.seed();
    const before = await Promise.all([raw(t.state()), raw(t.secret())]);
    const res = await t.post(send({ baseUrl: "http://other-host:9", model: "m" }));
    expect(res.status).toBe(400);
    expect(await raw(t.state())).toBe(before[0]);
    expect(await raw(t.secret())).toBe(before[1]);
  });

  it("POST with no stored secret and none provided is actionable 400, no file created", async () => {
    const t = load();
    await writeJson(t.state(), {});
    const res = await t.post(send({ baseUrl: BASE, model: "m" }));
    expect(res.status).toBe(400);
    expect(await readJson(t.state())).toEqual({});
  });
});

describe("legacy storage stays pristine", () => {
  beforeEach(async () => {
    await setStorage("legacy");
    cline = await import("@/app/api/cli-tools/cline-settings/route.js");
    kilo = await import("@/app/api/cli-tools/kilo-settings/route.js");
  });

  it("cline: GET has no storage metadata; POST without apiKey still 400", async () => {
    await seedCline();
    const body = await (await cline.GET()).json();
    expect(body).not.toHaveProperty("storage");
    expect(body).not.toHaveProperty("credentialConfigured");
    expect((await cline.POST(post({ baseUrl: BASE, model: "m" }))).status).toBe(400);
    expect((await cline.POST(post({ baseUrl: BASE, apiKey: "k", model: "m" }))).status).toBe(200);
  });

  it("kilo: GET has no storage metadata; POST without apiKey still 400", async () => {
    await seedKilo();
    const body = await (await kilo.GET()).json();
    expect(body).not.toHaveProperty("storage");
    expect(body).not.toHaveProperty("credentialConfigured");
    expect((await kilo.POST(post({ baseUrl: BASE, model: "m" }))).status).toBe(400);
    expect((await kilo.POST(post({ baseUrl: BASE, apiKey: "k", model: "m" }))).status).toBe(200);
  });
});
