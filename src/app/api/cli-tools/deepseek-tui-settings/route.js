"use server";

import { NextResponse } from "next/server";
import {
  boundaryError,
  configCopy,
  hashedStorageMode,
  resolveCredential,
} from "@/lib/cliToolConfigs/credentialBoundary";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { CLIENT_NAME } from "@/lib/cliToolBrand";
import { buildDeepSeekTuiConfig } from "@/lib/cliToolConfigs/deepseekTui";
import { renderFragment } from "@/lib/cliToolConfigs/shared";

const execAsync = promisify(exec);

const getDeepSeekDir = () => path.join(os.homedir(), ".deepseek");
const getDeepSeekConfigPath = () => path.join(getDeepSeekDir(), "config.toml");

// Simple TOML parser for key = "value" and [section] patterns
const parseToml = (content) => {
  const result = {};
  let currentSection = result;

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1];
      if (!result[sectionName]) result[sectionName] = {};
      currentSection = result[sectionName];
      continue;
    }

    // Key = "value" or key = value
    const keyValueMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/);
    if (keyValueMatch) {
      currentSection[keyValueMatch[1]] = keyValueMatch[2];
      continue;
    }

    // Key = value (unquoted)
    const unquotedMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (unquotedMatch) {
      currentSection[unquotedMatch[1]] = unquotedMatch[2].trim();
    }
  }

  return result;
};

// Default DeepSeek config (reset state)
const DEFAULT_CONFIG = `provider = "deepseek"
`;

const checkDeepSeekInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where deepseek" : "which deepseek";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getDeepSeekConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigToml = async () => {
  try {
    return await fs.readFile(getDeepSeekConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// Detect our config by checking if provider is "openai" and base_url points to localhost/127.0.0.1
const hasTokenhopConfig = (config) => {
  if (!config) return false;
  const provider = config.provider;
  if (provider !== "openai") return false;
  const openaiSection = config["providers.openai"];
  if (!openaiSection?.base_url) return false;
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(openaiSection.base_url);
};

export async function GET() {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const installed = await checkDeepSeekInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "DeepSeek TUI is not installed",
      });
    }
    const toml = await readConfigToml();
    const config = parseToml(toml);
    if (hashed) {
      // Targeted sanitization: withhold only the providers.openai api_key copy.
      const copy = configCopy(config);
      const section = copy?.["providers.openai"];
      const configured = typeof section?.api_key === "string" && section.api_key.length > 0;
      if (section) delete section.api_key;
      return NextResponse.json({
        installed: true,
        settings: copy,
        hasTokenhop: hasTokenhopConfig(config),
        credentialConfigured: configured,
        storage: "hashed",
        configPath: getDeepSeekConfigPath(),
      });
    }
    return NextResponse.json({
      installed: true,
      settings: config,
      hasTokenhop: hasTokenhopConfig(config),
      configPath: getDeepSeekConfigPath(),
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    console.log("Error checking deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to check deepseek-tui settings" }, { status: 500 });
  }
}

export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    // Hashed storage: reuse the stored key only for the SAME destination; a
    // changed or missing one is an actionable 400 before the file is written —
    // never the default-key fallback.
    let effectiveApiKey = apiKey;
    if (hashed) {
      let record = null;
      try {
        record = parseToml(await readConfigToml());
      } catch {
        record = null;
      }
      const section = record?.["providers.openai"];
      effectiveApiKey = resolveCredential({
        provided: apiKey,
        baseUrl,
        existing: section?.api_key ? [{ key: section.api_key, url: section.base_url }] : [],
      });
    }

    const dir = getDeepSeekDir();

    const [fragment] = buildDeepSeekTuiConfig({ baseUrl, apiKey: effectiveApiKey, model });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(getDeepSeekConfigPath(), renderFragment(fragment));

    return NextResponse.json({
      success: true,
      message: "DeepSeek TUI settings applied successfully!",
      configPath: getDeepSeekConfigPath(),
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    console.log("Error updating deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to update deepseek-tui settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getDeepSeekConfigPath();
    try {
      await fs.access(configPath);
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    await fs.writeFile(configPath, DEFAULT_CONFIG);
    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} config reset to DeepSeek defaults`,
    });
  } catch (error) {
    console.log("Error resetting deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to reset deepseek-tui settings" }, { status: 500 });
  }
}
