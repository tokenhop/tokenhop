// YAN-363: hashed durable mode boundaries for the remaining host-tool Apply
// routes. For every route: a hashed GET returns a sanitized copy of the on-disk
// config (targeted tokenhop-owned secret slots only, unrelated external
// provider data preserved) plus a credentialConfigured hint, never the raw
// secret; a hashed POST without an apiKey reuses the stored secret only for the
// SAME normalized destination and refuses with an actionable 400 (no mutation,
// no default-key fallback) when it is missing or the destination changed; an
// explicit key lands only in the intended client config and is never echoed.
// Legacy storage keeps today's exact behavior. Real routes + real files under
// an isolated HOME — no policy mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { masterKeyId } from "@/lib/security/masterKey.js";
import { clearHome, load, post, read, restoreBrand, write } from "../helpers/cliToolsBrand.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const secret = "sentinel-local-gateway-secret";
const other = "unrelated-external-secret";
const base = "http://localhost:20128";
const setMarker = async (hashed) => {
  const db = await getAdapter();
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  if (hashed) {
    db.run(
      "INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
      [masterKeyId(Buffer.alloc(32, 7))],
    );
  }
};
// Read a response body exactly once, asserting none of the secrets leak in it.
const readBody = async (res, ...secrets) => {
  const text = await res.text();
  for (const s of secrets) expect(text).not.toContain(s);
  return JSON.parse(text);
};

beforeEach(async () => {
  await clearHome([".jcode", ".config", ".factory", ".openclaw", ".deepseek", ".grok", ".hermes"]);
  await setMarker(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  restoreBrand();
});

describe("jcode hashed client config", () => {
  const rel = ".jcode/config.toml";
  const envRel = ".config/jcode/provider-tokenhop.env";
  let route;
  const seed = async () => {
    await write(
      rel,
      `[provider]\ndefault_provider = "tokenhop"\n\n[providers.tokenhop]\ntype = "openai-compatible"\nbase_url = "${base}/v1"\napi_key = "${secret}"\n\n[providers.openai]\ntype = "openai-compatible"\nbase_url = "https://api.openai.com/v1"\napi_key = "${other}"\n`,
    );
    await write(
      envRel,
      `# jcode provider environment variables\nJCODE_TOKENHOP_API_KEY="${secret}"\n`,
    );
  };
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, apiKey: "fresh", models: ["m1"], ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "jcode-settings");
    await seed();
  });

  it("GET sanitizes config slots and the env-backed key without touching disk", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect("envApiKey" in body).toBe(false);
    expect(body.config.providers.openai.api_key).toBe(other);
    expect(await read(rel)).toBe(before);
    expect(await read(envRel)).toContain(secret);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined, models: ["m2"] });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    expect(await read(rel)).not.toContain(secret);
    expect(await read(envRel)).toContain(secret);
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const envBefore = await read(envRel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
    expect(await read(envRel)).toBe(envBefore);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await clearHome([".config"]);
    const before = await read(rel);
    const res = await route.POST(post({ baseUrl: base, models: ["m2"] }));
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST still requires apiKey", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.config.providers.tokenhop.api_key).toBe(secret);
    expect(body.envApiKey).toBe(secret);
    expect("credentialConfigured" in body).toBe(false);
    expect((await route.POST(post({ baseUrl: base, models: ["m2"] }))).status).toBe(400);
    expect((await apply()).status).toBe(200);
    expect(await read(envRel)).toContain("fresh");
  });
});

describe("copilot hashed client config", () => {
  const rel = ".config/Code/User/chatLanguageModels.json";
  let route;
  const seed = () =>
    write(
      rel,
      JSON.stringify([
        {
          name: "tokenhop",
          vendor: "azure",
          apiKey: secret,
          models: [{ id: "old", name: "old", url: `${base}/chat/completions#models.ai.azure.com` }],
        },
        { name: "other-vendor", apiKey: other, models: [] },
      ]),
    );
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, models: ["m1"], apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "copilot-settings");
    await seed();
  });

  it("GET sanitizes only our entry's creds", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.config.find((e) => e.name === "tokenhop").apiKey).toBeUndefined();
    expect(body.config.find((e) => e.name === "other-vendor").apiKey).toBe(other);
    expect(await read(rel)).toBe(before);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const entry = JSON.parse(await read(rel)).find((e) => e.name === "tokenhop");
    expect(entry.apiKey).toBe(secret);
    expect(entry.models[0].id).toBe("m1");
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(rel, JSON.stringify([{ name: "other-vendor", apiKey: other, models: [] }]));
    const before = await read(rel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST falls back to the default key", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.config.find((e) => e.name === "tokenhop").apiKey).toBe(secret);
    expect("credentialConfigured" in body).toBe(false);
    expect((await apply({ apiKey: undefined })).status).toBe(200);
    const entry = JSON.parse(await read(rel)).find((e) => e.name === "tokenhop");
    expect(entry.apiKey).toBe("sk_tokenhop");
  });
});

describe("droid hashed client config", () => {
  const rel = ".factory/settings.json";
  let route;
  const seed = () =>
    write(
      rel,
      JSON.stringify({
        theme: "dark",
        customModels: [
          {
            model: "old",
            id: "custom:tokenhop-0",
            index: 0,
            baseUrl: `${base}/v1`,
            apiKey: secret,
          },
          {
            model: "ext",
            id: "custom:ext-0",
            index: 1,
            baseUrl: "https://ext.example/v1",
            apiKey: other,
          },
        ],
      }),
    );
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, models: ["m1"], apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "droid-settings");
    await seed();
  });

  it("GET sanitizes only our customModels creds", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(
      body.settings.customModels.find((m) => m.id === "custom:tokenhop-0").apiKey,
    ).toBeUndefined();
    expect(body.settings.customModels.find((m) => m.id === "custom:ext-0").apiKey).toBe(other);
    expect(await read(rel)).toBe(before);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const ours = JSON.parse(await read(rel)).customModels.find((m) =>
      m.id.startsWith("custom:tokenhop-"),
    );
    expect(ours.apiKey).toBe(secret);
    expect(ours.model).toBe("m1");
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(
      rel,
      JSON.stringify({
        customModels: [
          {
            model: "ext",
            id: "custom:ext-0",
            index: 0,
            baseUrl: "https://ext.example/v1",
            apiKey: other,
          },
        ],
      }),
    );
    const before = await read(rel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST falls back to the default key", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.settings.customModels.find((m) => m.id === "custom:tokenhop-0").apiKey).toBe(
      secret,
    );
    expect((await apply({ apiKey: undefined })).status).toBe(200);
    expect(
      JSON.parse(await read(rel)).customModels.find((m) => m.id.startsWith("custom:tokenhop-"))
        .apiKey,
    ).toBe("sk_tokenhop");
  });
});

describe("openclaw hashed client config", () => {
  const rel = ".openclaw/openclaw.json";
  const agentRel = ".openclaw/agents/a1/models.json";
  let route;
  let home;
  const seed = async (homeDir) => {
    await write(
      rel,
      JSON.stringify({
        agents: {
          defaults: { model: { primary: "tokenhop/old" } },
          list: [{ id: "a1", agentDir: `${homeDir}/.openclaw/agents/a1` }],
        },
        models: {
          providers: {
            tokenhop: { baseUrl: `${base}/v1`, apiKey: secret, models: [{ id: "old" }] },
            openai: { baseUrl: "https://api.openai.com/v1", apiKey: other, models: [] },
          },
        },
      }),
    );
    await write(
      agentRel,
      JSON.stringify({
        providers: {
          tokenhop: { baseUrl: `${base}/v1`, apiKey: secret, models: [{ id: "old" }] },
        },
      }),
    );
  };
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, model: "m1", apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "openclaw-settings");
    home = (await import("../helpers/cliToolsBrand.js")).home;
    // Containment assert: the per-agent models.json fragment is written under
    // the isolated HOME only, never a literal `~` directory or the real HOME.
    assertIsolatedHome(home);
    await seed(home);
  });

  it("writes per-agent models.json inside the isolated HOME only", async () => {
    const res = await apply({});
    expect(res.status).toBe(200);
    await readBody(res, secret, "fresh");
    const agentConfig = JSON.parse(await read(agentRel));
    expect(agentConfig.providers.tokenhop.apiKey).toBe("fresh");
    expect(agentConfig.providers.tokenhop.models).toContainEqual(
      expect.objectContaining({ id: "m1" }),
    );
    expect(JSON.stringify(agentConfig)).not.toContain(secret);
    const root = process.env.TOKENHOP_TEST_ROOT;
    expect(home.startsWith(root)).toBe(true);
    const fs = await import("node:fs/promises");
    // Literal-`~` directory left over from an earlier run must be absent; the
    // per-test isolated HOME is a fresh fork-pool temp dir per file, so only
    // the current run's own files can exist under it.
    const stale = "./~/.openclaw/agents/a1/models.json";
    let staleExists = false;
    try {
      await fs.access(stale);
      staleExists = true;
    } catch {}
    expect(staleExists, "stale ./~ artifact from an earlier run").toBe(false);
  });

  it("GET sanitizes only our provider creds", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.settings.models.providers.tokenhop.apiKey).toBeUndefined();
    expect(body.settings.models.providers.openai.apiKey).toBe(other);
    expect(await read(rel)).toBe(before);
  });
  it("GET removes every current and legacy provider credential from the response copy", async () => {
    const { ALL_CLIENT_KEYS } = await import("@/lib/cliToolBrand.js");
    const settings = JSON.parse(await read(rel));
    const sentinels = ALL_CLIENT_KEYS.map((key) => `sentinel-openclaw-${key}-secret`);
    for (const [index, key] of ALL_CLIENT_KEYS.entries()) {
      settings.models.providers[key] = {
        baseUrl: `${base}/v1`,
        apiKey: sentinels[index],
        models: [{ id: "old" }],
      };
    }
    await write(rel, JSON.stringify(settings));
    const before = await read(rel);
    const agentBefore = await read(agentRel);

    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, ...sentinels);
    expect(body.credentialConfigured).toBe(true);
    for (const key of ALL_CLIENT_KEYS) {
      expect(body.settings.models.providers[key]).not.toHaveProperty("apiKey");
    }
    expect(body.settings.models.providers.openai.apiKey).toBe(other);
    expect(await read(rel)).toBe(before);
    expect(await read(agentRel)).toBe(agentBefore);
  });
  it("GET sanitizes legacy owned slots too", async () => {
    const settings0 = JSON.parse(await read(rel));
    settings0.models.providers[/* legacy(9router) */ "9router"] = {
      baseUrl: `${base}/v1`,
      apiKey: secret,
      models: [{ id: "old" }],
    };
    await write(rel, JSON.stringify(settings0));
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body.settings.models.providers.tokenhop.apiKey).toBeUndefined();
    expect(body.settings.models.providers["9router"].apiKey).toBeUndefined(); // legacy(9router)
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const settings = JSON.parse(await read(rel));
    expect(settings.models.providers.tokenhop.apiKey).toBe(secret);
    expect(settings.models.providers.tokenhop.models.some((m) => m.id === "m1")).toBe(true);
    const agent = JSON.parse(await read(agentRel));
    expect(agent.providers.tokenhop.apiKey).toBe(secret);
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const agentBefore = await read(agentRel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
    expect(await read(agentRel)).toBe(agentBefore);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(
      rel,
      JSON.stringify({
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", apiKey: other, models: [] },
          },
        },
      }),
    );
    const before = await read(rel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST falls back to the default key", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.settings.models.providers.tokenhop.apiKey).toBe(secret);
    expect((await apply({ apiKey: undefined })).status).toBe(200);
    expect(JSON.parse(await read(rel)).models.providers.tokenhop.apiKey).toBe("sk_tokenhop");
  });
});

describe("deepseek-tui hashed client config", () => {
  const rel = ".deepseek/config.toml";
  let route;
  const seed = () =>
    write(
      rel,
      `provider = "openai"\n\n[providers.openai]\nbase_url = "${base}/v1"\napi_key = "${secret}"\nmodel = "old"\n`,
    );
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, model: "m1", apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "deepseek-tui-settings");
    await seed();
  });

  it("GET sanitizes the api_key slot without touching disk", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.settings["providers.openai"].api_key).toBeUndefined();
    expect(body.settings["providers.openai"].base_url).toBe(`${base}/v1`);
    expect(await read(rel)).toBe(before);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const toml = await read(rel);
    expect(toml).toContain(`api_key = "${secret}"`);
    expect(toml).toContain('model = "m1"');
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(
      rel,
      'provider = "openai"\n\n[providers.openai]\nbase_url = "https://api.openai.com/v1"\nmodel = "old"\n',
    );
    const before = await read(rel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST falls back to the default key", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.settings["providers.openai"].api_key).toBe(secret);
    expect((await apply({ apiKey: undefined })).status).toBe(200);
    expect(await read(rel)).toContain('api_key = "sk_tokenhop"');
  });
});

describe("grok-build hashed client config", () => {
  const rel = ".grok/config.toml";
  let route;
  const seed = () =>
    write(
      rel,
      `[model.tokenhop]\nmodel = "old"\nbase_url = "${base}/v1"\nname = "tokenhop"\napi_key = "${secret}"\n\n[model.ext]\nmodel = "x"\nbase_url = "https://ext.example/v1"\napi_key = "${other}"\n`,
    );
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, model: "m1", apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "grok-build-settings");
    await seed();
  });

  it("GET sanitizes only our model slot creds", async () => {
    const before = await read(rel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.settings.model.api_key).toBeUndefined();
    expect(body.settings.model.base_url).toBe(`${base}/v1`);
    expect(await read(rel)).toBe(before);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const toml = await read(rel);
    expect(toml).toContain(`api_key = "${secret}"`);
    expect(toml).toContain('model = "m1"');
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(rel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(
      rel,
      `[model.ext]\nmodel = "x"\nbase_url = "https://ext.example/v1"\napi_key = "${other}"\n`,
    );
    const before = await read(rel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(rel)).toBe(before);
  });
  it("malformed baseUrl refuses with an actionable 400 and no mutation", async () => {
    const before = await read(".grok/config.toml");
    const res = await route.POST(post({ baseUrl: "not a url", model: "m1" }));
    expect(res.status).toBe(400);
    const body = await readBody(res, secret);
    expect(body.error).toMatch(/plain http/);
    expect(await read(".grok/config.toml")).toBe(before);
  });
  it("legacy GET stays byte-exact and POST falls back to the default key", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.settings.model.api_key).toBe(secret);
    expect((await apply({ apiKey: undefined })).status).toBe(200);
    expect(await read(rel)).toContain('api_key = "sk_tokenhop"');
  });
});

describe("cowork hashed client config", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const appliedRel = `.config/Claude-3p/configLibrary/${id}.json`;
  const metaRel = ".config/Claude-3p/configLibrary/_meta.json";
  let route;
  const seed = async () => {
    await write(
      appliedRel,
      JSON.stringify({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: base,
        inferenceGatewayApiKey: secret,
        inferenceModels: [{ name: "old" }],
      }),
    );
    await write(metaRel, JSON.stringify({ appliedId: id }));
  };
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, models: ["m1"], apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "cowork-settings");
    await seed();
  });

  it("GET sanitizes the gateway key slot without touching disk", async () => {
    const before = await read(appliedRel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.config.inferenceGatewayApiKey).toBeUndefined();
    expect(body.config.inferenceGatewayBaseUrl).toBe(base);
    expect(await read(appliedRel)).toBe(before);
  });
  it("model-only edit keeps the stored key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    const cfg = JSON.parse(await read(appliedRel));
    expect(cfg.inferenceGatewayApiKey).toBe(secret);
    expect(cfg.inferenceModels).toEqual([{ name: "m1" }]);
  });
  it("GET strips the machine-bound CLI token from bridge entries", async () => {
    const cfg = JSON.parse(await read(appliedRel));
    cfg.managedMcpServers = [
      {
        name: "x",
        url: "http://localhost:20128/api/mcp/x/sse",
        transport: "sse",
        headers: { "x-9r-cli-token": "machine-token", other: "keep" },
      },
    ];
    await write(appliedRel, JSON.stringify(cfg));
    const before = await read(appliedRel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret, "machine-token");
    expect(body.config.managedMcpServers[0].headers).toEqual({ other: "keep" });
    expect(await read(appliedRel)).toBe(before);
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(appliedRel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(appliedRel)).toBe(before);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await clearHome([".config"]);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(metaRel).catch(() => "")).toBe("");
  });
  it("legacy GET stays byte-exact and POST keeps requiring apiKey", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.config.inferenceGatewayApiKey).toBe(secret);
    expect((await route.POST(post({ baseUrl: base, models: ["m1"] }))).status).toBe(400);
    expect((await apply()).status).toBe(200);
    expect(JSON.parse(await read(appliedRel)).inferenceGatewayApiKey).toBe("fresh");
  });
});

describe("hermes hashed client config", () => {
  const configRel = ".hermes/config.yaml";
  const envRel = ".hermes/.env";
  let route;
  const seed = async () => {
    await write(
      configRel,
      `model:\n  default: "old"\n  provider: "custom"\n  base_url: "${base}/v1"\n  api_key: \${OPENAI_API_KEY}\n`,
    );
    await write(envRel, `OTHER=x\nOPENAI_API_KEY=${secret}\n`);
  };
  const apply = (body = {}) =>
    route.POST(post({ baseUrl: base, model: "m1", apiKey: "fresh", ...body }));

  beforeEach(async () => {
    route = await load("tokenhop", "hermes-settings");
    await seed();
  });

  it("GET sanitizes the inline api_key hint without touching disk", async () => {
    const before = await read(configRel);
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await readBody(res, secret);
    expect(body).toMatchObject({ storage: "hashed", credentialConfigured: true, installed: true });
    expect(body.settings.model.api_key).toBeUndefined();
    expect(body.settings.model.base_url).toBe(`${base}/v1`);
    expect(await read(configRel)).toBe(before);
  });
  it("model-only edit keeps the stored .env key on the same destination", async () => {
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(200);
    await readBody(res, secret);
    expect(await read(envRel)).toContain(`OPENAI_API_KEY=${secret}`);
    expect(await read(configRel)).toContain('default: "m1"');
  });
  it("changed destination without replacement denies without mutation", async () => {
    const before = await read(configRel);
    const envBefore = await read(envRel);
    const res = await apply({ baseUrl: "https://different.example", apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(configRel)).toBe(before);
    expect(await read(envRel)).toBe(envBefore);
  });
  it("missing stored key denies rather than writing an unusable config", async () => {
    await write(envRel, "OTHER=x\n");
    const before = await read(configRel);
    const res = await apply({ apiKey: undefined });
    expect(res.status).toBe(400);
    await readBody(res, secret);
    expect(await read(configRel)).toBe(before);
  });
  it("legacy GET stays byte-exact and POST omits the env write", async () => {
    await setMarker(false);
    const body = await readBody(await route.GET());
    expect(body.settings.model.api_key).toBe("${OPENAI_API_KEY}");
    const res = await route.POST(post({ baseUrl: base, model: "m1" }));
    expect(res.status).toBe(200);
    const envText = await read(envRel).catch(() => "");
    expect(envText).not.toContain("OPENAI_API_KEY=fresh");
  });
});
