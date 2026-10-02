// YAN-332: JSON tool configs (Kilo, Droid, Copilot, Cline). Under the tokenhop
// brand Apply writes tokenhop entries and migrates legacy ones; the legacy
// brand keeps writing what it always did. Detect and Reset accept both everywhere.
// HOME is a per-file temp dir (tests/setup), never the real one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY,
  OLD,
  OLD_NAME,
  clearHome,
  fixture,
  json,
  load,
  post,
  readJson,
  restoreBrand,
  write,
} from "../helpers/cliToolsBrand.js";

beforeEach(() => clearHome([".factory", ".local", ".config", ".cline"]));
afterEach(restoreBrand);

describe("kilo", () => {
  const authRel = ".local/share/kilo/auth.json";
  const vscodeRel = ".config/Code/User/settings.json";
  const apply = (kilo) =>
    kilo.POST(post({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", model: "cx/gpt-5" }));
  const seed = async () => {
    await write(authRel, await fixture("kilo-auth.json"));
    await write(vscodeRel, JSON.stringify({ "editor.fontSize": 14 }));
  };

  it("legacy → apply migrates: legacy auth key gone, unrelated kept, provider named tokenhop", async () => {
    await seed();
    const kilo = await load("tokenhop", "kilo-settings");
    expect(await json(await kilo.GET())).toMatchObject({ hasTokenhop: true });

    expect((await apply(kilo)).status).toBe(200);
    const auth = await readJson(authRel);
    expect(auth[OLD]).toBeUndefined();
    expect(auth.anthropic).toEqual({ type: "api-key", apiKey: "sk-ant" });
    expect(auth["openai-compatible"]).toEqual({
      type: "api-key",
      apiKey: "sk-new",
      baseUrl: "http://127.0.0.1:20128/v1",
      model: "cx/gpt-5",
    });
    const vscode = await readJson(vscodeRel);
    expect(vscode["kilocode.customProvider"].name).toBe("tokenhop");
    expect(vscode["editor.fontSize"]).toBe(14);
  });

  it.each([LEGACY.slug, "tokenhop"])(
    "legacy → reset removes our entries under brand %j",
    async (brand) => {
      await seed();
      const kilo = await load(brand, "kilo-settings");
      expect((await kilo.DELETE()).status).toBe(200);
      expect(await readJson(authRel)).toEqual({
        anthropic: { type: "api-key", apiKey: "sk-ant" },
      });
    },
  );

  it("legacy brand writes the legacy provider name and leaves legacy auth keys", async () => {
    await seed();
    const kilo = await load(LEGACY.slug, "kilo-settings");
    expect((await apply(kilo)).status).toBe(200);
    expect((await readJson(authRel))[OLD]).toBeDefined();
    expect((await readJson(vscodeRel))["kilocode.customProvider"].name).toBe(OLD_NAME);
  });
});

describe("droid", () => {
  const rel = ".factory/settings.json";
  const apply = (droid) =>
    droid.POST(
      post({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk-new", models: ["cx/a", "cx/b"] }),
    );
  const seed = async () => write(rel, await fixture("droid-settings.json"));

  it("legacy → apply migrates ids and keeps unrelated models", async () => {
    await seed();
    const droid = await load("tokenhop", "droid-settings");
    expect(await json(await droid.GET())).toMatchObject({ hasTokenhop: true });

    expect((await apply(droid)).status).toBe(200);
    const { customModels, theme } = await readJson(rel);
    expect(theme).toBe("dark");
    // The pre-existing reorder quirk: without activeModel the surviving
    // unrelated entry becomes the default and moves to the front.
    expect(customModels.map((m) => m.id)).toEqual([
      "custom:openai-direct-1",
      "custom:tokenhop-0",
      "custom:tokenhop-1",
    ]);
    expect(customModels.map((m) => m.model)).toEqual(["gpt-4o", "cx/a", "cx/b"]);
    expect(customModels.some((m) => m.id.startsWith(`custom:${OLD_NAME}`))).toBe(false);
  });

  it.each([LEGACY.slug, "tokenhop"])(
    "legacy → reset removes our models under brand %j",
    async (brand) => {
      await seed();
      const droid = await load(brand, "droid-settings");
      expect((await droid.DELETE()).status).toBe(200);
      const { customModels } = await readJson(rel);
      expect(customModels.map((m) => m.id)).toEqual(["custom:openai-direct-1"]);
    },
  );

  it("legacy brand writes legacy ids", async () => {
    await seed();
    const droid = await load(LEGACY.slug, "droid-settings");
    expect((await apply(droid)).status).toBe(200);
    const { customModels } = await readJson(rel);
    expect(customModels.map((m) => m.id)).toEqual([
      "custom:openai-direct-1",
      `custom:${OLD_NAME}-0`,
      `custom:${OLD_NAME}-1`,
    ]);
  });
});

describe("copilot", () => {
  const rel = ".config/Code/User/chatLanguageModels.json";
  const apply = (copilot) =>
    copilot.POST(
      post({ baseUrl: "http://127.0.0.1:20128/v1", apiKey: "sk-new", models: ["cx/gpt-5"] }),
    );
  const seed = async () => write(rel, await fixture("copilot-models.json"));

  it("legacy → apply replaces the entry in place, carries extras, drops duplicates", async () => {
    await seed();
    const copilot = await load("tokenhop", "copilot-settings");
    expect(await json(await copilot.GET())).toMatchObject({
      hasTokenhop: true,
      currentModel: "cc/claude-opus-4-7",
    });

    expect((await apply(copilot)).status).toBe(200);
    const config = await readJson(rel);
    expect(config.map((e) => e.name)).toEqual(["Ollama", "tokenhop"]);
    expect(config[1]).toMatchObject({
      vendor: "azure",
      apiKey: "sk-new",
      note: "keep-me",
      models: [{ id: "cx/gpt-5" }],
    });
  });

  it.each([LEGACY.slug, "tokenhop"])(
    "legacy → reset removes our entries under brand %j",
    async (brand) => {
      await seed();
      const copilot = await load(brand, "copilot-settings");
      expect((await copilot.DELETE()).status).toBe(200);
      expect((await readJson(rel)).map((e) => e.name)).toEqual(["Ollama"]);
    },
  );

  it("legacy brand writes the legacy name and keeps the existing shape", async () => {
    await seed();
    const copilot = await load(LEGACY.slug, "copilot-settings");
    expect((await apply(copilot)).status).toBe(200);
    const config = await readJson(rel);
    expect(config.map((e) => e.name)).toEqual(["Ollama", OLD_NAME, OLD]);
    expect(config[1].note).toBeUndefined();
  });
});

describe("cline", () => {
  it("GET detects a base URL naming a legacy key under tokenhop", async () => {
    await write(
      ".cline/data/globalState.json",
      JSON.stringify({
        actModeApiProvider: "openai",
        openAiBaseUrl: `https://gw.example.com/${OLD}`,
      }),
    );
    const cline = await load("tokenhop", "cline-settings");
    expect(await json(await cline.GET())).toMatchObject({ hasTokenhop: true });
  });
});
