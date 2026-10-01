// YAN-332: JSON tool configs (OpenCode, OpenClaw). Under the tokenhop brand
// Apply writes tokenhop entries and migrates legacy ones in place; the default
// brand keeps writing what it always did. Detect and Reset accept both
// everywhere. HOME is a per-file temp dir (tests/setup), never the real one.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OLD,
  OLD_NAME,
  clearHome,
  fixture,
  home,
  json,
  load,
  post,
  readJson,
  restoreBrand,
  write,
} from "../helpers/cliToolsBrand.js";

beforeEach(() => clearHome([".config", ".openclaw"]));
afterEach(restoreBrand);

describe("opencode", () => {
  const rel = ".config/opencode/opencode.json";
  const apply = (route) =>
    route.POST(
      post({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "sk-new",
        models: ["cc/gpt-5"],
        activeModel: "cc/gpt-5",
        subagentModel: "cc/claude-sonnet-5",
      }),
    );

  it("legacy → apply migrates in place and keeps unrelated config", async () => {
    await write(rel, await fixture("opencode.json"));
    const before = JSON.parse(await fixture("opencode.json"));
    const route = await load("tokenhop", "opencode-settings");
    expect(await json(await route.GET())).toMatchObject({
      hasTokenhop: true,
      opencode: { activeModel: "cc/claude-sonnet-5" },
    });

    expect((await apply(route)).status).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.provider[OLD]).toBeUndefined();
    expect(cfg.provider.tokenhop.npm).toBe("@ai-sdk/openai-compatible");
    // Migrated models are kept; the requested one is added
    expect(Object.keys(cfg.provider.tokenhop.models).sort()).toEqual([
      "cc/claude-sonnet-5",
      "cc/gpt-5",
      "cc/legacy-only",
    ]);
    expect(cfg.provider.tokenhop.models["cc/legacy-only"]).toEqual(
      before.provider[OLD].models["cc/legacy-only"],
    );
    expect(cfg.provider.tokenhop.options).toEqual({
      baseURL: "http://127.0.0.1:20128/v1",
      apiKey: "sk-new",
      extraOption: true,
    });
    // References are repointed under any legacy spelling
    expect(cfg.model).toBe("tokenhop/cc/gpt-5");
    expect(cfg.agent.explorer.model).toBe("tokenhop/cc/claude-sonnet-5");
    expect(cfg.agent.builder).toEqual({
      model: "tokenhop/cc/builder-model",
      prompt: "stay on task",
    });
    // Unrelated config is untouched
    expect(cfg.provider["openai-direct"]).toEqual(before.provider["openai-direct"]);
    expect(cfg.theme).toBe(before.theme);
    expect(cfg.autoupdate).toBe(before.autoupdate);
    expect(cfg.$schema).toBe(before.$schema);

    const status = await json(await route.GET());
    expect(status.opencode.models.sort()).toEqual([
      "cc/claude-sonnet-5",
      "cc/gpt-5",
      "cc/legacy-only",
    ]);
    expect(status.opencode.activeModel).toBe("cc/gpt-5");
  });

  it.each(["tokenhop", ""])("legacy → reset removes our entries under brand %j", async (brand) => {
    await write(rel, await fixture("opencode.json"));
    const route = await load(brand, "opencode-settings");
    expect(await json(await route.GET())).toMatchObject({ hasTokenhop: true });

    expect((await route.DELETE(new Request("http://localhost/x"))).status).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.provider[OLD]).toBeUndefined();
    expect(cfg.provider.tokenhop).toBeUndefined();
    expect(Object.keys(cfg.provider)).toEqual(["openai-direct"]);
    expect(cfg.model).toBeUndefined();
    expect(cfg.agent.explorer).toBeUndefined();
    expect(cfg.agent.builder).toEqual({
      model: `${OLD_NAME}/cc/builder-model`,
      prompt: "stay on task",
    });
  });

  it("default brand writes the legacy provider and refs on a fresh file", async () => {
    const route = await load("", "opencode-settings");
    expect((await apply(route)).status).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.provider.tokenhop).toBeUndefined();
    expect(cfg.provider[OLD]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:20128/v1", apiKey: "sk-new" },
      models: {
        "cc/gpt-5": {
          name: "cc/gpt-5",
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    });
    expect(cfg.model).toBe(`${OLD}/cc/gpt-5`);
    expect(cfg.agent.explorer.model).toBe(`${OLD}/cc/claude-sonnet-5`);
  });

  it("apply merges ours and every legacy spelling without losing a model", async () => {
    const entry = (model) => ({ options: {}, models: { [model]: { name: model } } });
    await write(
      rel,
      JSON.stringify({
        provider: { [OLD]: entry("cc/a"), [OLD_NAME]: entry("cc/b"), tokenhop: entry("cc/c") },
      }),
    );
    const route = await load("tokenhop", "opencode-settings");
    expect((await apply(route)).status).toBe(200);
    const cfg = await readJson(rel);
    expect(Object.keys(cfg.provider)).toEqual(["tokenhop"]);
    expect(Object.keys(cfg.provider.tokenhop.models).sort()).toEqual([
      "cc/a",
      "cc/b",
      "cc/c",
      "cc/gpt-5",
    ]);
  });

  it("partial delete removes one model under the legacy key, same namespace", async () => {
    await write(rel, await fixture("opencode.json"));
    const route = await load("tokenhop", "opencode-settings");
    const del = (model) =>
      route.DELETE(new Request(`http://localhost/x?model=${encodeURIComponent(model)}`));

    // Removing the active model falls back to the first remaining one, under
    // the same (legacy) namespace rather than the active brand key
    expect((await del("cc/claude-sonnet-5")).status).toBe(200);
    let cfg = await readJson(rel);
    expect(Object.keys(cfg.provider[OLD].models)).toEqual(["cc/legacy-only"]);
    expect(cfg.model).toBe(`${OLD}/cc/legacy-only`);

    // Removing the last model removes the provider and the root model
    expect((await del("cc/legacy-only")).status).toBe(200);
    cfg = await readJson(rel);
    expect(cfg.provider[OLD]).toBeUndefined();
    expect(cfg.model).toBeUndefined();
  });
});

describe("openclaw", () => {
  const rel = ".openclaw/openclaw.json";
  const agentRel = ".openclaw/agents/coder/models.json";
  const seed = async () => {
    const settings = JSON.parse(await fixture("openclaw.json"));
    settings.agents.list[0].agentDir = path.join(home, ".openclaw/agents/coder");
    await write(rel, JSON.stringify(settings, null, 2));
    await write(agentRel, await fixture("openclaw-agent-models.json"));
  };
  const apply = (route) =>
    route.POST(
      post({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "sk-new",
        model: "cc/new-hotness",
        agentModels: { coder: "cc/coder-model" },
      }),
    );

  it("legacy → apply migrates in place and repoints references", async () => {
    await seed();
    const before = JSON.parse(await fixture("openclaw.json"));
    const route = await load("tokenhop", "openclaw-settings");
    expect(await json(await route.GET())).toMatchObject({ hasTokenhop: true });

    expect((await apply(route)).status).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.models.providers[OLD]).toBeUndefined();
    expect(cfg.models.providers.tokenhop).toMatchObject({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-new",
      api: "openai-completions",
    });
    // Apply sets the model list (as under the default brand)
    expect(cfg.models.providers.tokenhop.models.map((m) => m.id)).toEqual([
      "cc/new-hotness",
      "cc/coder-model",
    ]);
    expect(cfg.models.providers["openai-direct"]).toEqual(before.models.providers["openai-direct"]);
    // Defaults model, fallbacks and allowlist follow the new key
    expect(cfg.agents.defaults.model).toEqual({
      primary: "tokenhop/cc/new-hotness",
      fallbacks: ["tokenhop/cc/fallback-model", "openai/gpt-4o"],
    });
    expect(cfg.agents.defaults.models).toEqual({
      "tokenhop/cc/new-hotness": {},
      "tokenhop/cc/coder-model": {},
      "openai/gpt-4o": { label: "GPT" },
    });
    // agents.list: our override is set, other providers untouched, mixed
    // objects get only their legacy fallback repointed
    const [coder, reviewer, planner] = cfg.agents.list;
    expect(coder.model).toBe("tokenhop/cc/coder-model");
    expect(reviewer).toEqual(before.agents.list[1]);
    expect(planner.model).toEqual({
      primary: "openai/o3",
      fallbacks: ["tokenhop/cc/fallback-model"],
    });
    // Unrelated config is untouched
    expect(cfg.mcp).toEqual(before.mcp);
    expect(cfg.permissions).toEqual(before.permissions);

    // Per-agent models.json migrates its legacy provider under ours
    const agentModels = await readJson(agentRel);
    expect(agentModels.providers[OLD]).toBeUndefined();
    expect(agentModels.providers.tokenhop).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-new",
      api: "openai-completions",
      models: [{ id: "cc/coder-model", name: "coder-model" }],
    });
    expect(agentModels.providers.ollama).toEqual(
      JSON.parse(await fixture("openclaw-agent-models.json")).providers.ollama,
    );
  });

  it.each(["tokenhop", ""])("legacy → reset removes our entries under brand %j", async (brand) => {
    const settings = JSON.parse(await fixture("openclaw.json"));
    // Cover the second legacy spelling too
    settings.agents.defaults.model.primary = `${OLD_NAME}/cc/primary`;
    settings.agents.defaults.models[`${OLD_NAME}/cc/allowlisted`] = {};
    await write(rel, JSON.stringify(settings, null, 2));
    const route = await load(brand, "openclaw-settings");

    expect((await route.DELETE()).status).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.models.providers[OLD]).toBeUndefined();
    expect(cfg.models.providers.tokenhop).toBeUndefined();
    expect(Object.keys(cfg.models.providers)).toEqual(["openai-direct"]);
    expect(cfg.agents.defaults.models).toEqual({ "openai/gpt-4o": { label: "GPT" } });
    expect(cfg.agents.defaults.model.primary).toBeUndefined();
  });

  it("default brand writes the legacy provider and refs on a fresh file", async () => {
    const route = await load("", "openclaw-settings");
    expect(
      (
        await route.POST(
          post({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", model: "cc/fresh" }),
        )
      ).status,
    ).toBe(200);
    const cfg = await readJson(rel);
    expect(cfg.models.providers.tokenhop).toBeUndefined();
    expect(cfg.models.providers[OLD]).toEqual({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk-new",
      api: "openai-completions",
      models: [{ id: "cc/fresh", name: "fresh" }],
    });
    expect(cfg.agents.defaults.model.primary).toBe(`${OLD}/cc/fresh`);
    expect(cfg.agents.defaults.models).toEqual({ [`${OLD}/cc/fresh`]: {} });
  });
});
