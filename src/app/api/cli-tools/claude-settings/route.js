"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";

const execAsync = promisify(exec);

// Exa MCP def — reuse from coworkPlugins (DRY).
const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");
const buildExaMcpEntry = () => ({
  type: EXA_PLUGIN.transport,
  url: EXA_PLUGIN.url,
});

// Get claude settings path based on OS
const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};

// Claude Code CLI reads mcpServers from ~/.claude.json (NOT settings.json).
const getClaudeJsonPath = () => path.join(os.homedir(), ".claude.json");

const readClaudeJson = async () => {
  try {
    const content = await fs.readFile(getClaudeJsonPath(), "utf-8");
    return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

// Reads and updates ~/.claude.json in memory; returns a writer. Split so callers
// can fail on an unparseable file before writing anything else.
const prepareClaudeJsonMcp = async (mcpServers) => {
  const filePath = getClaudeJsonPath();
  const data = (await readJsonConfig(filePath)) ?? {};
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    data.mcpServers = { ...(data.mcpServers || {}), ...mcpServers };
  } else if (data.mcpServers) {
    delete data.mcpServers.exa;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  return () => fs.writeFile(filePath, JSON.stringify(data, null, 2));
};

// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const hasTokenhop = !!settings?.env?.ANTHROPIC_BASE_URL;
    const claudeJson = await readClaudeJson();

    return NextResponse.json({
      installed: true,
      settings: settings,
      hasTokenhop: hasTokenhop,
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json({ error: "Failed to check claude settings" }, { status: 500 });
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const body = await request.json();
    const { env, exaMcpEnabled, autoCompactWindow } = body;

    if (!env || typeof env !== "object") {
      return NextResponse.json({ error: "Invalid env object" }, { status: 400 });
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings (unparseable file → 422, left untouched)
    const currentSettings = (await readJsonConfig(settingsPath)) ?? {};

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1")
        ? env.ANTHROPIC_BASE_URL
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // CLAUDE_CODE_AUTO_COMPACT_WINDOW — the token threshold that triggers
    // auto-compact. Only set when a concrete value is chosen; "Default" removes
    // the key so Claude Code derives the window from the model. Omitted field
    // (e.g. terminal UI posts only env) leaves the key as-is.
    if ("autoCompactWindow" in body) {
      if (autoCompactWindow) {
        newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
      } else {
        delete newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      }
    }

    // Exa MCP toggle — ~/.claude.json (CLI reads mcpServers from here). Prepared
    // before any write so an unparseable file aborts without a partial apply.
    // Omitted field leaves the existing MCP entry untouched.
    const writeMcp =
      EXA_PLUGIN && "exaMcpEnabled" in body
        ? await prepareClaudeJsonMcp(exaMcpEnabled ? { exa: buildExaMcpEntry() } : null)
        : null;

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    if (writeMcp) await writeMcp();

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    const parseError = configErrorResponse(error);
    if (parseError) return parseError;
    return NextResponse.json({ error: "Failed to update claude settings" }, { status: 500 });
  }
}

// Fields to remove when resetting: every model key Apply can write, plus the rest.
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  ...CLI_TOOLS.claude.defaultModels.map((m) => m.envKey),
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    const currentSettings = await readJsonConfig(settingsPath);
    if (!currentSettings) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });

      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Remove injected MCP servers (Exa) from ~/.claude.json
    await (await prepareClaudeJsonMcp(null))();

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    const parseError = configErrorResponse(error);
    if (parseError) return parseError;
    return NextResponse.json({ error: "Failed to reset claude settings" }, { status: 500 });
  }
}
