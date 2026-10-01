import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import { withV1 } from "./shared";

// Exa MCP def — reuse from coworkPlugins (DRY).
const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");

/**
 * Claude Code: `~/.claude/settings.json` plus, when Exa is on, `~/.claude.json`.
 * `autoCompactWindow`: truthy sets CLAUDE_CODE_AUTO_COMPACT_WINDOW, anything
 * else defined (e.g. "") drops it, `undefined` leaves `env` as given.
 */
export const buildClaudeConfig = ({ env, exaMcpEnabled, autoCompactWindow } = {}) => {
  if (!env || typeof env !== "object") return null;

  const settingsEnv = { ...env };
  if (settingsEnv.ANTHROPIC_BASE_URL) {
    settingsEnv.ANTHROPIC_BASE_URL = withV1(settingsEnv.ANTHROPIC_BASE_URL);
  }
  if (autoCompactWindow) {
    settingsEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
  } else if (autoCompactWindow !== undefined) {
    delete settingsEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }

  const fragments = [
    {
      file: "~/.claude/settings.json",
      format: "json",
      merge: true,
      value: { hasCompletedOnboarding: true, env: settingsEnv },
    },
  ];
  // Claude Code reads mcpServers from ~/.claude.json, not settings.json.
  if (exaMcpEnabled && EXA_PLUGIN) {
    fragments.push({
      file: "~/.claude.json",
      format: "json",
      merge: true,
      value: { mcpServers: { exa: { type: EXA_PLUGIN.transport, url: EXA_PLUGIN.url } } },
    });
  }
  return fragments;
};
