"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { ACTIVE } from "@/shared/brand";
import { CLIENT_NAME, isClientKey, LEGACY_CLIENT_KEYS } from "@/lib/cliToolBrand";

// Resolve chatLanguageModels.json path per OS
const getConfigPath = () => {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "chatLanguageModels.json",
    );
  }
  return path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const hasTokenhopConfig = (config) => {
  if (!Array.isArray(config)) return false;
  return config.some((entry) => isClientKey(entry.name));
};

// Our entry, preferring the active name
const getOurEntry = (config) => {
  if (!Array.isArray(config)) return null;
  return (
    config.find((entry) => entry.name === CLIENT_NAME) ||
    config.find((entry) => isClientKey(entry.name)) ||
    null
  );
};

// GET - Read current copilot config
export async function GET() {
  try {
    const config = await readConfig();
    const entry = getOurEntry(config);

    return NextResponse.json({
      installed: true,
      config,
      hasTokenhop: hasTokenhopConfig(config),
      configPath: getConfigPath(),
      currentModel: entry?.models?.[0]?.id || null,
      currentUrl: entry?.models?.[0]?.url || null,
    });
  } catch (error) {
    console.log("Error checking copilot settings:", error);
    return NextResponse.json({ error: "Failed to check copilot settings" }, { status: 500 });
  }
}

// POST - Apply our config to chatLanguageModels.json
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !models?.length) {
      return NextResponse.json({ error: "baseUrl and models are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    // Read existing config array
    let config = (await readJsonConfig(configPath, "array")) ?? [];

    const endpointUrl = `${baseUrl}/chat/completions#models.ai.azure.com`;
    const keyToUse = apiKey || ACTIVE.defaultApiKey;

    const newEntry = {
      name: CLIENT_NAME,
      vendor: "azure",
      apiKey: keyToUse,
      models: models.map((id) => ({
        id,
        name: id,
        url: endpointUrl,
        toolCalling: true,
        vision: false,
        maxInputTokens: 128000,
        maxOutputTokens: 16000,
      })),
    };

    // Replace our entry; otherwise migrate the first legacy one in place,
    // carrying its extra fields under ours, and drop other legacy duplicates.
    let idx = config.findIndex((e) => e.name === CLIENT_NAME);
    let migrating = false;
    if (idx < 0) {
      idx = config.findIndex((e) => LEGACY_CLIENT_KEYS.includes(e.name));
      migrating = idx >= 0;
    }
    if (idx >= 0) {
      config[idx] = migrating ? { ...config[idx], ...newEntry } : newEntry;
      if (migrating) {
        config = config.filter((e, i) => i === idx || !LEGACY_CLIENT_KEYS.includes(e.name));
      }
    } else {
      config.push(newEntry);
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Copilot settings applied! Reload VS Code to take effect.",
      configPath,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error updating copilot settings:", error);
    return NextResponse.json({ error: "Failed to update copilot settings" }, { status: 500 });
  }
}

// DELETE - Remove our entry from chatLanguageModels.json
export async function DELETE() {
  try {
    const configPath = getConfigPath();

    let config = await readJsonConfig(configPath, "array");
    if (!config) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    config = config.filter((e) => !isClientKey(e.name));
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} removed from Copilot config`,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error resetting copilot settings:", error);
    return NextResponse.json({ error: "Failed to reset copilot settings" }, { status: 500 });
  }
}
