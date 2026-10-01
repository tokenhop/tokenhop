// YAN-331: TOML/YAML tool configs. Under the tokenhop brand Apply writes
// tokenhop entries and migrates legacy ones in place; the default brand keeps
// writing what it always did. Detect and Reset accept both everywhere.
// HOME is a per-file temp dir (tests/setup), never the real one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTOML } from "confbox";
import {
  LEGACY,
  OLD,
  OLD_NAME,
  clearHome,
  exists,
  fixture,
  json,
  load,
  loadModule,
  post,
  read,
  restoreBrand,
  write,
} from "../helpers/cliToolsBrand.js";

const OLD_JCODE_ENV = LEGACY.jcodeApiKeyEnv;

beforeEach(() => clearHome([".codex", ".jcode", ".config", ".grok", ".deepseek", ".hermes"]));
afterEach(restoreBrand);

describe("codex", () => {
  const rel = ".codex/config.toml";
  const apply = (codex) =>
    codex.POST(post({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", model: "cx/gpt-5" }));

  it("fresh file: tokenhop brand writes a tokenhop provider", async () => {
    const codex = await load("tokenhop", "codex-settings");
    expect((await apply(codex)).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.model_provider).toBe("tokenhop");
    expect(cfg.model_providers.tokenhop.name).toBe("tokenhop");
    expect(await json(await codex.GET())).toMatchObject({ hasTokenhop: true });
  });

  it("legacy → apply migrates in place and keeps unrelated config", async () => {
    await write(rel, await fixture("codex-config.toml"));
    const before = parseTOML(await fixture("codex-config.toml"));
    const codex = await load("tokenhop", "codex-settings");
    expect(await json(await codex.GET())).toMatchObject({ hasTokenhop: true });

    expect((await apply(codex)).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.model_providers[OLD]).toBeUndefined();
    expect(cfg.model_provider).toBe("tokenhop");
    expect(cfg.profiles.fast.model_provider).toBe("tokenhop");
    expect(cfg.model_providers.tokenhop).toEqual({
      name: "tokenhop",
      base_url: "http://127.0.0.1:20128/v1",
      wire_api: "responses",
      request_max_retries: 4,
      http_headers: { Authorization: "Bearer sk-new", "X-Team": "core" },
    });
    expect(cfg.profiles.direct).toEqual(before.profiles.direct);
    expect(cfg.model_providers["openai-direct"]).toEqual(before.model_providers["openai-direct"]);
    expect(cfg.projects).toEqual(before.projects);
    expect(cfg.approval_policy).toBe("on-request");
  });

  it("legacy → reset removes our entries under any brand", async () => {
    await write(rel, await fixture("codex-config.toml"));
    const codex = await load("tokenhop", "codex-settings");
    expect((await codex.DELETE()).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.model_provider).toBeUndefined();
    expect(cfg.model_providers).toEqual({
      "openai-direct": { name: "OpenAI", base_url: "https://api.openai.com/v1" },
    });
    expect(cfg.profiles.fast).toEqual({ model: "cc/claude-sonnet-4-6" });
    expect(cfg.profiles.direct.model_provider).toBe("openai-direct");
  });

  it("default brand keeps writing the legacy provider", async () => {
    await write(rel, await fixture("codex-config.toml"));
    const codex = await load("", "codex-settings");
    expect((await apply(codex)).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.model_provider).toBe(OLD);
    expect(cfg.model_providers.tokenhop).toBeUndefined();
    // Same entry as before this change: rewritten whole, no carry-over
    expect(cfg.model_providers[OLD]).toEqual({
      name: OLD_NAME,
      base_url: "http://127.0.0.1:20128/v1",
      wire_api: "responses",
      http_headers: { Authorization: "Bearer sk-new" },
    });
  });

  it("parse failure leaves the file untouched", async () => {
    const bad = `model_provider = "${OLD}"\n[a]\nx = 1\nx = 2\n`;
    await write(rel, bad);
    const codex = await load("tokenhop", "codex-settings");
    const res = await apply(codex);
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/tokenhop will not overwrite it/);
    expect(await read(rel)).toBe(bad);
  });
});

describe("jcode", () => {
  const rel = ".jcode/config.toml";
  const legacyEnv = `.config/jcode/provider-${OLD}.env`;
  const newEnv = ".config/jcode/provider-tokenhop.env";
  const apply = (jcode, models = ["cc/claude-sonnet-5"]) =>
    jcode.POST(post({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", models }));
  const seed = async () => {
    await write(rel, await fixture("jcode-config.toml"));
    await write(legacyEnv, await fixture("jcode-provider.env"));
  };

  it("legacy → apply migrates the entry, default provider and env file", async () => {
    await seed();
    const jcode = await load("tokenhop", "jcode-settings");
    expect(await json(await jcode.GET())).toMatchObject({
      hasTokenhop: true,
      envApiKey: "sk-legacy",
    });

    expect((await apply(jcode)).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.providers[OLD]).toBeUndefined();
    expect(cfg.provider).toEqual({
      default_provider: "tokenhop",
      default_model: "cc/claude-opus-4-7",
    });
    expect(cfg.providers.tokenhop).toMatchObject({
      api_key_env: "JCODE_TOKENHOP_API_KEY",
      env_file: "provider-tokenhop.env",
      default_model: "cc/claude-sonnet-5",
      models: [{ id: "cc/claude-opus-4-7", context_window: 200000 }],
    });
    expect(cfg.providers["local-vllm"]).toEqual({
      type: "openai-compatible",
      base_url: "http://127.0.0.1:8000/v1",
    });
    expect(await exists(legacyEnv)).toBe(false);
    const env = await read(newEnv);
    expect(env).toContain('JCODE_TOKENHOP_API_KEY="sk-new"');
    expect(env).toContain('HTTPS_PROXY="http://proxy.local:3128"');
    expect(env).not.toContain(OLD_JCODE_ENV);
  });

  it("keeps the legacy default model when Apply sends none", async () => {
    await seed();
    const jcode = await load("tokenhop", "jcode-settings");
    expect((await apply(jcode, [])).status).toBe(200);
    expect(parseTOML(await read(rel)).providers.tokenhop.default_model).toBe("cc/claude-opus-4-7");
  });

  it("legacy → reset removes the entry, default provider and key", async () => {
    await seed();
    const jcode = await load("tokenhop", "jcode-settings");
    expect((await jcode.DELETE()).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(Object.keys(cfg.providers)).toEqual(["local-vllm"]);
    expect(cfg.provider).toEqual({ default_model: "cc/claude-opus-4-7" });
    const env = await read(legacyEnv);
    expect(env).not.toContain(OLD_JCODE_ENV);
    expect(env).toContain("HTTPS_PROXY");
  });

  it("default brand writes the legacy entry and env file", async () => {
    const jcode = await load("", "jcode-settings");
    expect((await apply(jcode)).status).toBe(200);
    const cfg = parseTOML(await read(rel));
    expect(cfg.providers[OLD].api_key_env).toBe(OLD_JCODE_ENV);
    expect(await read(legacyEnv)).toContain(`${OLD_JCODE_ENV}="sk-new"`);
    expect(await exists(newEnv)).toBe(false);
  });

  it("parse failure leaves config and env file untouched", async () => {
    const bad = `[providers.${OLD}]\nx = 1\nx = 2\n`;
    await write(rel, bad);
    await write(legacyEnv, await fixture("jcode-provider.env"));
    const jcode = await load("tokenhop", "jcode-settings");
    expect((await apply(jcode)).status).toBe(422);
    expect(await read(rel)).toBe(bad);
    expect(await read(legacyEnv)).toBe(await fixture("jcode-provider.env"));
    expect(await exists(newEnv)).toBe(false);
  });
});

describe("grok build", () => {
  const rel = ".grok/config.toml";
  const loadLib = (brand) => loadModule(brand, "@/lib/grokBuildConfig.js");

  it("legacy → apply renames slots and keeps models and markers", async () => {
    const grok = await loadLib("tokenhop");
    const out = grok.applyGrokBuildConfig(await fixture("grok-config.toml"), {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-new",
      model: "cx/gpt-5.6-sol",
      contextWindow: 400000,
    });
    expect(out).not.toMatch(new RegExp(OLD, "i"));
    const parsed = grok.parseGrokBuildConfig(out);
    expect(parsed.default).toBe("tokenhop");
    expect(parsed.model).toMatchObject({ name: "tokenhop", api_key: "sk-new" });
    expect(parsed.subagentMappings).toEqual({
      "general-purpose": "tokenhop-general-purpose",
      explore: "tokenhop-explore",
      plan: "grok-4.5",
    });
    expect(parsed.subagentModels.explore.model).toBe("gemini/gemini-3-flash");
    expect(out).toContain('# tokenhop-prev-default = "grok-4.5"');
    expect(out).toContain('# tokenhop-prev-subagent-explore = "__tokenhop_unset__"');
    expect(out).toContain('[mcp_servers.example]\nurl = "https://example.com/mcp"');
  });

  it.each(["", "tokenhop"])(
    "applied by the legacy brand, reset by brand %j: previous values come back",
    async (brand) => {
      await write(rel, await fixture("grok-config.toml"));
      const route = await load(brand, "grok-build-settings");
      expect(await json(await route.GET())).toMatchObject({ hasTokenhop: true });
      expect((await route.DELETE()).status).toBe(200);
      const out = await read(rel);
      expect(out).not.toMatch(new RegExp(`${OLD}|tokenhop`, "i"));
      const cfg = parseTOML(out);
      expect(cfg.models.default).toBe("grok-4.5");
      expect(cfg.subagents.models).toEqual({ "general-purpose": "grok-4.5", plan: "grok-4.5" });
      expect(cfg.mcp_servers.example.enabled).toBe(true);
    },
  );

  it("migrated then reset still restores the user's previous default", async () => {
    const grok = await loadLib("tokenhop");
    const applied = grok.applyGrokBuildConfig(await fixture("grok-config.toml"), {
      baseUrl: "http://127.0.0.1:20128/v1",
      model: "cx/gpt-5.6-sol",
      subagentModels: {},
    });
    const cfg = parseTOML(grok.resetGrokBuildConfig(applied));
    expect(cfg.models.default).toBe("grok-4.5");
    expect(cfg.subagents.models).toEqual({ "general-purpose": "grok-4.5", plan: "grok-4.5" });
  });
});

describe("deepseek tui and hermes report hasTokenhop", () => {
  it("deepseek tui", async () => {
    await write(
      ".deepseek/config.toml",
      'provider = "openai"\n\n[providers.openai]\nbase_url = "http://127.0.0.1:20128/v1"\n',
    );
    const route = await load("tokenhop", "deepseek-tui-settings");
    expect(await json(await route.GET())).toMatchObject({ hasTokenhop: true });
  });

  it("hermes", async () => {
    await write(
      ".hermes/config.yaml",
      'model:\n  default: "cc/x"\n  provider: "custom"\n  base_url: "http://127.0.0.1:20128/v1"\n',
    );
    const route = await load("tokenhop", "hermes-settings");
    expect(await json(await route.GET())).toMatchObject({ hasTokenhop: true });
  });
});
