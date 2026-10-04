"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { buildClaudeConfig } from "@/lib/cliToolConfigs/claude";
import { withV1 } from "@/lib/cliToolConfigs/shared";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState";
import { getAdapter } from "@/lib/db/driver";

const execAsync = promisify(exec);

// YAN-363: hashed durable mode gates credential handling on these routes.
// Legacy storage keeps today's exact behavior; an invalid durable marker
// fails closed as 503, never silently legacy.
async function hashedStorageMode() {
  const state = readApiKeyStorageState(await getAdapter());
  return state.storage === "hashed";
}

// Compare the URL the builder will persist; URL resolves dot segments and
// normalizes host casing/default ports without equating distinct hostnames.
function destinationIdentity(raw, applyV1 = false) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid credential destination");
  }
  const pathname = url.pathname.replace(/\/$/, "");
  url.pathname = applyV1 ? withV1(pathname) : pathname;
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

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
  } catch {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
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

    if (hashed) {
      // Targeted sanitization: the gateway credential copy never leaves the
      // disk file. Everything else in the settings is returned as-is.
      const sanitized = settings ? JSON.parse(JSON.stringify(settings)) : null;
      const credentialConfigured =
        typeof sanitized?.env?.ANTHROPIC_AUTH_TOKEN === "string" &&
        sanitized.env.ANTHROPIC_AUTH_TOKEN.length > 0;
      if (sanitized?.env) delete sanitized.env.ANTHROPIC_AUTH_TOKEN;
      return NextResponse.json({
        installed: true,
        settings: sanitized,
        hasTokenhop,
        credentialConfigured,
        storage: "hashed",
        exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
        settingsPath: getClaudeSettingsPath(),
      });
    }

    return NextResponse.json({
      installed: true,
      settings: settings,
      hasTokenhop: hasTokenhop,
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", hashed ? "Config operation failed" : error);
    return NextResponse.json({ error: "Failed to check claude settings" }, { status: 500 });
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
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

    if (hashed) {
      const posted = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN : null;
      const existing =
        typeof currentSettings?.env?.ANTHROPIC_AUTH_TOKEN === "string"
          ? currentSettings.env.ANTHROPIC_AUTH_TOKEN
          : null;
      let existingBase = null;
      let intendedBase = null;
      try {
        existingBase =
          typeof currentSettings?.env?.ANTHROPIC_BASE_URL === "string" &&
          currentSettings.env.ANTHROPIC_BASE_URL
            ? destinationIdentity(currentSettings.env.ANTHROPIC_BASE_URL)
            : null;
        intendedBase =
          typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL
            ? destinationIdentity(env.ANTHROPIC_BASE_URL, true)
            : null;
      } catch {
        return NextResponse.json({ error: "Invalid ANTHROPIC_BASE_URL" }, { status: 400 });
      }
      if (intendedBase) env.ANTHROPIC_BASE_URL = intendedBase;
      if (!posted) {
        if (!existing) {
          // No stored credential and none provided: never write an
          // incomplete credential-free entry.
          return NextResponse.json(
            { error: "Provide ANTHROPIC_AUTH_TOKEN for this destination" },
            { status: 400 },
          );
        }
        if (!existingBase || (intendedBase && intendedBase !== existingBase)) {
          // The disk credential copy is bound to its destination: a different
          // origin or path never inherits it without an explicit replacement.
          return NextResponse.json(
            { error: "Provide ANTHROPIC_AUTH_TOKEN for this destination" },
            { status: 400 },
          );
        }
        // Same destination (or none posted): the disk credential is reused,
        // never echoed back.
        env.ANTHROPIC_AUTH_TOKEN = existing;
      }
    }

    // Builder normalises ANTHROPIC_BASE_URL (/v1) and sets/drops the auto-compact
    // key in env. An omitted autoCompactWindow (e.g. terminal UI posts only env)
    // leaves the existing key as-is.
    const [settingsFragment, mcpFragment] = buildClaudeConfig({
      env,
      exaMcpEnabled,
      autoCompactWindow,
    });

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      ...settingsFragment.value,
      env: {
        ...(currentSettings.env || {}),
        ...settingsFragment.value.env,
      },
    };
    // "Default" (empty) removes the key so Claude Code derives the window from the model.
    if ("autoCompactWindow" in body && !autoCompactWindow) {
      delete newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    // Exa MCP toggle — ~/.claude.json (CLI reads mcpServers from here). Prepared
    // before any write so an unparseable file aborts without a partial apply.
    // Omitted field leaves the existing MCP entry untouched.
    const writeMcp =
      "exaMcpEnabled" in body && (mcpFragment || !exaMcpEnabled)
        ? await prepareClaudeJsonMcp(mcpFragment?.value.mcpServers ?? null)
        : null;

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    if (writeMcp) await writeMcp();

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    if (hashed) {
      console.log("Error updating claude settings");
      return NextResponse.json({ error: "Failed to update claude settings" }, { status: 500 });
    }
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
