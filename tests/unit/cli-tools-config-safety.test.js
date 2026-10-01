// cli-tools Apply/Reset must never overwrite a user's config it can't parse,
// and must only touch what 9Router owns (GH #60–#63). HOME is a per-file temp
// dir (tests/setup), so these routes write under it, not the real home.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as opencode from "@/app/api/cli-tools/opencode-settings/route.js";
import * as codex from "@/app/api/cli-tools/codex-settings/route.js";
import * as claude from "@/app/api/cli-tools/claude-settings/route.js";
import { ACTIVE, BRAND, LEGACY } from "@/shared/brand";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

const home = os.homedir();
const req = (body) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const write = async (rel, content) => {
  const p = path.join(home, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
};
const read = (p) => fs.readFile(p, "utf-8");

beforeEach(async () => {
  for (const d of [".config", ".codex", ".claude", ".claude.json"])
    await fs.rm(path.join(home, d), { recursive: true, force: true });
});

describe("opencode-settings (GH #60)", () => {
  const rel = ".config/opencode/opencode.json";
  const apply = () =>
    opencode.POST(req({ baseUrl: "http://localhost:20128", models: ["cc/claude"] }));

  it("merges into a JSONC config instead of wiping it", async () => {
    const p = await write(rel, '{ // mine\n "mcp": { "gh": { "type": "local" } },\n}');
    expect((await apply()).status).toBe(200);
    const cfg = JSON.parse(await read(p));
    expect(cfg.mcp.gh.type).toBe("local");
    expect(cfg.provider[ACTIVE.clientConfigKey]).toBeDefined();
  });

  it("refuses to write an unparseable config", async () => {
    const bad = '{ "mcp": { "gh": 1 } "x" }';
    const p = await write(rel, bad);
    expect((await apply()).status).toBe(422);
    expect(await read(p)).toBe(bad);
  });
});

describe("codex-settings", () => {
  const apply = () =>
    codex.POST(req({ baseUrl: "http://localhost:20128", apiKey: "sk-x", model: "gpt-5" }));

  it("refuses to overwrite invalid TOML (GH #62)", async () => {
    const bad = 'model = "o3"\n[projects."/a"]\ntrust_level = "x"\ntrust_level = "y"\n';
    const p = await write(".codex/config.toml", bad);
    expect((await apply()).status).toBe(422);
    expect(await read(p)).toBe(bad);
  });

  it("Reset keeps the user's own auth.json key (GH #61)", async () => {
    await write(".codex/config.toml", 'model = "o3"\n');
    expect((await apply()).status).toBe(200);
    const auth = JSON.stringify({ OPENAI_API_KEY: "sk-user-real", auth_mode: "apikey" });
    const p = await write(".codex/auth.json", auth);
    expect((await codex.DELETE()).status).toBe(200);
    expect(JSON.parse(await read(p))).toEqual(JSON.parse(auth));
  });

  // legacy(9router): remove in v2 — older installs wrote the legacy placeholder key.
  it.each([LEGACY.defaultApiKey, BRAND.defaultApiKey])(
    "Reset removes our %s placeholder from auth.json",
    async (key) => {
      await write(".codex/config.toml", 'model = "o3"\n');
      expect((await apply()).status).toBe(200);
      const p = await write(
        ".codex/auth.json",
        JSON.stringify({ OPENAI_API_KEY: key, auth_mode: "apikey" }),
      );
      expect((await codex.DELETE()).status).toBe(200);
      expect(JSON.parse(await read(p))).toEqual({});
    },
  );
});

describe("claude-settings (GH #63)", () => {
  it("an env-only POST keeps the Exa MCP server and auto-compact window", async () => {
    const settings = await write(
      ".claude/settings.json",
      JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } }),
    );
    const claudeJson = await write(
      ".claude.json",
      JSON.stringify({ mcpServers: { exa: { url: "e" }, github: { url: "g" } } }),
    );
    const res = await claude.POST(req({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/sonnet" } }));
    expect(res.status).toBe(200);
    const env = JSON.parse(await read(settings)).env;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("cc/sonnet");
    expect(Object.keys(JSON.parse(await read(claudeJson)).mcpServers)).toEqual(["exa", "github"]);
  });

  it("Reset removes every env key Apply can write (YAN-627)", async () => {
    const settings = await write(".claude/settings.json", JSON.stringify({ env: { MINE: "1" } }));
    const env = { ANTHROPIC_BASE_URL: "http://localhost:20128", ANTHROPIC_AUTH_TOKEN: "sk-x" };
    for (const m of CLI_TOOLS.claude.defaultModels) env[m.envKey] = "cc/model";
    const res = await claude.POST(req({ env, autoCompactWindow: 200000 }));
    expect(res.status).toBe(200);
    expect((await claude.DELETE()).status).toBe(200);
    expect(JSON.parse(await read(settings)).env).toEqual({ MINE: "1" });
  });
});
