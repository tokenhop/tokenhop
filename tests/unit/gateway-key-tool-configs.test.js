// YAN-363 hashed-mode credential handling for the Claude + OpenCode CLI-tool
// config routes: GET sanitizes the targeted credential copy, POST keeps the
// disk secret for same-destination edits, requires an explicit replacement
// when the destination changes, and never substitutes a brand default in
// hashed mode. Legacy storage keeps today's exact behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
import { getAdapter } from "@/lib/db/driver.js";
import { CLIENT_KEY } from "@/lib/cliToolBrand.js";
import { ACTIVE } from "@/shared/brand";

const home = assertIsolatedHome();
const KID = "0123456789abcdef";
const SECRET = "th_SECRET_DISK_CREDENTIAL";
const BASE = "http://127.0.0.1:20128";

const claudePath = () => path.join(home, ".claude", "settings.json");
const openCodePath = () => path.join(home, ".config", "opencode", "opencode.json");

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf-8"));
const raw = async (file) => fs.readFile(file, "utf-8");

const post = (body) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

let claude;
let opencode;
let claudeRoutes;
let openCodeRoutes;

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

beforeEach(async () => {
  await fs.rm(path.join(home, ".claude"), { recursive: true, force: true });
  await fs.rm(path.join(home, ".config"), { recursive: true, force: true });
  await setStorage("hashed");
  claudeRoutes = await import("@/app/api/cli-tools/claude-settings/route.js");
  openCodeRoutes = await import("@/app/api/cli-tools/opencode-settings/route.js");
  claude = claudeRoutes.POST;
  opencode = openCodeRoutes.POST;
});

const seededClaude = () =>
  writeJson(claudePath(), {
    env: { ANTHROPIC_BASE_URL: `${BASE}/v1`, ANTHROPIC_AUTH_TOKEN: SECRET, OTHER: "keep" },
    customField: true,
  });

const seededOpenCode = () =>
  writeJson(openCodePath(), {
    provider: {
      [CLIENT_KEY]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${BASE}/v1`, apiKey: SECRET },
        models: { "cx/a": { name: "cx/a" } },
      },
      "external-provider": {
        options: { baseURL: "https://elsewhere.test", apiKey: "ext-keep" },
        models: { "x/y": { name: "x/y" } },
      },
    },
    model: `${CLIENT_KEY}/cx/a`,
  });

describe("claude-settings under hashed storage", () => {
  it("GET omits the credential sentinel, reports storage and credentialConfigured", async () => {
    await seededClaude();
    const res = await claudeRoutes.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage).toBe("hashed");
    expect(body.credentialConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.settings.env.ANTHROPIC_BASE_URL).toBe(`${BASE}/v1`);
    expect(body.settings.env.OTHER).toBe("keep");
    expect(body.settings.customField).toBe(true);
  });

  it("POST without the secret keeps the disk secret for the same destination", async () => {
    await seededClaude();
    const res = await claude(
      post({
        env: { ANTHROPIC_BASE_URL: BASE },
        autoCompactWindow: "398000",
      }),
    );
    expect(res.status).toBe(200);
    const disk = await readJson(claudePath());
    expect(disk.env.ANTHROPIC_AUTH_TOKEN).toBe(SECRET);
    expect(disk.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("398000");
    expect(disk.env.OTHER).toBe("keep");
  });

  it("POST with a changed base URL and no secret is 400 with zero disk mutation", async () => {
    await seededClaude();
    const before = await raw(claudePath());
    const res = await claude(post({ env: { ANTHROPIC_BASE_URL: "http://other-host:9" } }));
    expect(res.status).toBe(400);
    expect(await raw(claudePath())).toBe(before);
  });

  it("POST with an explicit replacement secret rewrites the credential", async () => {
    await seededClaude();
    const res = await claude(
      post({ env: { ANTHROPIC_BASE_URL: "http://other-host:9", ANTHROPIC_AUTH_TOKEN: "th_NEW" } }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(claudePath())).env.ANTHROPIC_AUTH_TOKEN).toBe("th_NEW");
  });

  it("claude fresh settings (no stored secret): actionable 400, zero mutation", async () => {
    await writeJson(claudePath(), { env: { ANTHROPIC_BASE_URL: `${BASE}/v1` } });
    const before = await raw(claudePath());
    const res = await claude(post({ env: { ANTHROPIC_BASE_URL: BASE } }));
    expect(res.status).toBe(400);
    expect(await raw(claudePath())).toBe(before);
  });

  it("claude same destination via casing/trailing slash reuses the disk secret", async () => {
    await seededClaude();
    const res = await claude(post({ env: { ANTHROPIC_BASE_URL: "HTTP://127.0.0.1:20128/" } }));
    expect(res.status).toBe(200);
    const disk = await readJson(claudePath());
    expect(disk.env.ANTHROPIC_AUTH_TOKEN).toBe(SECRET);
    expect(disk.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
  });
});

describe("opencode-settings under hashed storage", () => {
  it("GET sanitizes only our provider entry; unrelated providers pass through", async () => {
    await seededOpenCode();
    const res = await openCodeRoutes.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage).toBe("hashed");
    expect(body.credentialConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.config.provider[CLIENT_KEY].options.baseURL).toBe(`${BASE}/v1`);
    expect(body.config.provider[CLIENT_KEY].options).not.toHaveProperty("apiKey");
    expect(body.config.provider["external-provider"].options.apiKey).toBe("ext-keep");
  });

  it("POST model-only edit (no apiKey) preserves the disk secret", async () => {
    await seededOpenCode();
    const res = await opencode(
      post({ baseUrl: BASE, models: ["cx/a", "cx/new"], activeModel: "cx/new" }),
    );
    expect(res.status).toBe(200);
    const disk = await readJson(openCodePath());
    expect(disk.provider[CLIENT_KEY].options.apiKey).toBe(SECRET);
    expect(Object.keys(disk.provider[CLIENT_KEY].models)).toEqual(["cx/a", "cx/new"]);
    expect(disk.provider["external-provider"].options.apiKey).toBe("ext-keep");
  });

  it("POST with a changed baseUrl and no apiKey is 400 with zero disk mutation", async () => {
    await seededOpenCode();
    const before = await raw(openCodePath());
    const res = await opencode(post({ baseUrl: "http://other-host:9", models: ["cx/a"] }));
    expect(res.status).toBe(400);
    expect(await raw(openCodePath())).toBe(before);
  });

  it("POST with an explicit apiKey applies the replacement", async () => {
    await seededOpenCode();
    const res = await opencode(
      post({ baseUrl: "http://other-host:9", apiKey: "th_NEW", models: ["cx/a"] }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(openCodePath())).provider[CLIENT_KEY].options.apiKey).toBe("th_NEW");
  });

  it("fresh config (no stored secret, none provided): actionable 400, no file written", async () => {
    await writeJson(openCodePath(), {});
    const res = await opencode(post({ baseUrl: BASE, models: ["cx/a"] }));
    expect(res.status).toBe(400);
    expect(await readJson(openCodePath())).toEqual({}); // zero mutation
    expect((await res.json()).error).toContain("apiKey");
  });

  it("same destination accepts host-casing/trailing-slash equivalence and reuses the secret", async () => {
    await seededOpenCode();
    const res = await opencode(
      post({ baseUrl: "HTTP://127.0.0.1:20128/", models: ["cx/a", "cx/b"] }),
    );
    expect(res.status).toBe(200);
    const disk = await readJson(openCodePath());
    expect(disk.provider[CLIENT_KEY].options.apiKey).toBe(SECRET);
    expect(disk.provider[CLIENT_KEY].options.baseURL).toBe("http://127.0.0.1:20128/v1");
  });

  it("different normalized path (/v1/../other) never inherits the secret", async () => {
    await seededOpenCode();
    const before = await raw(openCodePath());
    const res = await opencode(post({ baseUrl: `${BASE}/v1/../other`, models: ["cx/a"] }));
    expect(res.status).toBe(400);
    expect(await raw(openCodePath())).toBe(before);
  });

  it("localhost is not 127.0.0.1: no silent cross-host credential reuse", async () => {
    await seededOpenCode();
    const res = await opencode(post({ baseUrl: "http://localhost:20128", models: ["cx/a"] }));
    expect(res.status).toBe(400);
  });

  it.each([
    `${BASE}/v1?x=1`,
    `${BASE}/v1#frag`,
    `http://user:pass@localhost:20128/v1`,
    "not-a-url",
  ])("malformed or credential-bearing URL %s is 400", async (baseUrl) => {
    await seededOpenCode();
    const before = await raw(openCodePath());
    expect((await opencode(post({ baseUrl, models: ["cx/a"] }))).status).toBe(400);
    expect(await raw(openCodePath())).toBe(before);
  });

  it("deny paths log nothing: no sentinel in any console output", async () => {
    await seededOpenCode();
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    try {
      await opencode(post({ baseUrl: "http://other-host:9", models: ["cx/a"] }));
      await opencode(post({ baseUrl: "http://user@localhost:20128/v1", models: ["cx/a"] }));
      await opencode(post({ baseUrl: BASE, models: ["cx/a"] })); // fresh-key deny below
    } finally {
      console.log = orig;
    }
    await writeJson(openCodePath(), {});
    const logs2 = [];
    console.log = (...args) => logs2.push(args.map(String).join(" "));
    try {
      await opencode(post({ baseUrl: BASE, models: ["cx/a"] }));
    } finally {
      console.log = orig;
    }
    expect([...logs, ...logs2].join("\n")).not.toContain(SECRET);
  });
});

describe("legacy storage stays pristine", () => {
  beforeEach(async () => {
    await setStorage("legacy");
  });

  it("claude GET returns the raw settings with no storage/credential fields", async () => {
    await seededClaude();
    const body = await (await claudeRoutes.GET()).json();
    expect(body.settings.env.ANTHROPIC_AUTH_TOKEN).toBe(SECRET);
    expect(body).not.toHaveProperty("storage");
    expect(body).not.toHaveProperty("credentialConfigured");
  });

  it("opencode GET returns the raw apiKey; POST omitted apiKey keeps the builder default", async () => {
    await seededOpenCode();
    const body = await (await openCodeRoutes.GET()).json();
    expect(body.config.provider[CLIENT_KEY].options.apiKey).toBe(SECRET);
    expect(body).not.toHaveProperty("storage");
    // Pristine POST: omitted apiKey falls back to the builder's brand default.
    await opencode(post({ baseUrl: "http://other-host:9", models: ["cx/a"] }));
    expect((await readJson(openCodePath())).provider[CLIENT_KEY].options.apiKey).toBe(
      ACTIVE.defaultApiKey,
    );
  });
});
