// YAN-617: what Apply writes on a clean HOME must equal the builder fragments the
// manual snippet shows. A key added to a route but not to its builder fails here.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseTOML } from "confbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHome,
  home,
  load,
  loadModule,
  post,
  read,
  restoreBrand,
} from "../helpers/cliToolsBrand.js";

const base = "http://127.0.0.1:20128";
const apiKey = "sk-parity";

// body: what the card POSTs; opts: what the card passes the builder (defaults to body).
const TOOLS = [
  {
    route: "claude-settings",
    builder: "claude",
    fn: "buildClaudeConfig",
    body: {
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: apiKey },
      exaMcpEnabled: true,
      autoCompactWindow: "398000",
    },
  },
  {
    route: "codex-settings",
    builder: "codex",
    fn: "buildCodexConfig",
    body: { baseUrl: base, apiKey, model: "cx/gpt-5", subagentModel: "cx/gpt-5-mini" },
  },
  {
    route: "copilot-settings",
    builder: "copilot",
    fn: "buildCopilotConfig",
    body: { baseUrl: base, apiKey, models: ["cx/gpt-5", "cc/claude-opus-5"] },
    opts: { platform: "linux" },
  },
  {
    route: "cline-settings",
    builder: "cline",
    fn: "buildClineConfig",
    body: { baseUrl: `${base}/v1`, apiKey, model: "cx/gpt-5" },
  },
  {
    route: "droid-settings",
    builder: "droid",
    fn: "buildDroidConfig",
    body: { baseUrl: base, apiKey, models: ["cx/a", "cx/b"], activeModel: "cx/b" },
  },
  {
    route: "kilo-settings",
    builder: "kilo",
    fn: "buildKiloConfig",
    body: { baseUrl: base, apiKey, model: "cx/gpt-5" },
    // Apply only updates VS Code settings when VS Code is there.
    dirs: [".config/Code/User"],
  },
  {
    route: "opencode-settings",
    builder: "opencode",
    fn: "buildOpenCodeConfig",
    body: {
      baseUrl: base,
      apiKey,
      models: ["cx/a", "cx/b"],
      activeModel: "cx/b",
      subagentModel: "cx/a",
    },
  },
  {
    route: "deepseek-tui-settings",
    builder: "deepseekTui",
    fn: "buildDeepSeekTuiConfig",
    body: { baseUrl: base, apiKey, model: "ds/deepseek-v4" },
  },
  {
    route: "hermes-settings",
    builder: "hermes",
    fn: "buildHermesConfig",
    body: { baseUrl: base, apiKey, model: "cx/gpt-5" },
  },
  {
    route: "jcode-settings",
    builder: "jcode",
    fn: "buildJcodeConfig",
    body: { baseUrl: base, apiKey, models: ["cc/claude-opus-5"] },
    opts: { model: "cc/claude-opus-5" },
  },
  {
    route: "grok-build-settings",
    builder: "grokBuild",
    fn: "buildGrokBuildConfig",
    body: {
      baseUrl: base,
      apiKey,
      model: "xai/grok-4.7",
      contextWindow: 256000,
      subagentModels: { explore: { model: "xai/grok-4.6", contextWindow: 128000 } },
    },
    // The route normalises the base URL and subagent entries before building.
    opts: {
      baseUrl: `${base}/v1`,
      subagentModels: { explore: { model: "xai/grok-4.6", contextWindow: 128000 } },
    },
  },
];

const HOME_DIRS = [
  ".claude",
  ".claude.json",
  ".codex",
  ".config",
  ".cline",
  ".factory",
  ".local",
  ".deepseek",
  ".hermes",
  ".jcode",
  ".grok",
];

// "~/x" display paths → the file Apply wrote under the test HOME.
const homePath = (file) => (file.startsWith("~/") ? file.slice(2) : path.relative(home, file));

afterEach(restoreBrand);

describe.each(["", "tokenhop"])("brand %j", (brand) => {
  it.each(TOOLS)("$route: Apply == builder", async ({ route, builder, fn, body, opts, dirs }) => {
    await clearHome(HOME_DIRS);
    for (const dir of dirs || []) await mkdir(path.join(home, dir), { recursive: true });

    const res = await (await load(brand, route)).POST(post(body));
    expect(res.status).toBe(200);

    const build = (await loadModule(brand, `@/lib/cliToolConfigs/${builder}.js`))[fn];
    const fragments = build({ ...body, ...opts });
    expect(fragments?.length).toBeGreaterThan(0);

    for (const { file, format, value } of fragments) {
      const written = await read(homePath(file));
      if (format === "json") expect(JSON.parse(written)).toEqual(value);
      else if (format === "toml") expect(parseTOML(written)).toEqual(value);
      else expect(written).toBe(value);
    }
  });

  it.each(TOOLS.filter((t) => t.route !== "claude-settings"))(
    "$route: no model → null",
    async ({ builder, fn }) => {
      const build = (await loadModule(brand, `@/lib/cliToolConfigs/${builder}.js`))[fn];
      expect(build({ baseUrl: base, apiKey, models: [] })).toBeNull();
    },
  );
});
