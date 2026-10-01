"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { ACTIVE } from "@/shared/brand";
import {
  ALL_CLIENT_KEYS,
  CLIENT_KEY,
  CLIENT_NAME,
  findClientEntry,
  modelRef,
  repointModelRef,
  splitModelRef,
  takeLegacyEntry,
} from "@/lib/cliToolBrand";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // opencode config files may use JSONC format (trailing commas, comments).
    // Strip trailing commas before parsing to avoid SyntaxError on valid JSONC.
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // If the config file exists but is unparseable (corrupted, exotic JSONC),
    // treat it as "no config" rather than throwing a 500 that the UI
    // misinterprets as "opencode not installed".
    return null;
  }
};

const hasTokenhopConfig = (config) => !!findClientEntry(config?.provider);

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = findClientEntry(config?.provider);
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasTokenhop: hasTokenhopConfig(config),
      configPath: getConfigPath(),
      opencode: {
        models: Object.keys(modelMap),
        activeModel: splitModelRef(config?.model)?.model ?? null,
        baseURL: providerConfig?.options?.baseURL || null,
      },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply our provider as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models)
      ? models.slice()
      : typeof model === "string"
        ? [model]
        : [];

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json(
        { error: "baseUrl and at least one model are required" },
        { status: 400 },
      );
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    const config = (await readJsonConfig(configPath)) ?? {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || ACTIVE.defaultApiKey;
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing entry and its models; a legacy entry is migrated
    // (taken even when an active one exists, so no model is lost)
    const legacy = takeLegacyEntry(config.provider);
    const active = config.provider[CLIENT_KEY];
    const existingProvider =
      active && legacy
        ? {
            ...legacy,
            ...active,
            options: { ...legacy.options, ...active.options },
            models: { ...legacy.models, ...active.models },
          }
        : (active ??
          legacy ?? {
            npm: "@ai-sdk/openai-compatible",
            options: {},
            models: {},
          });

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingProvider.models[m] = {
        name: m,
        modalities: { input: ["text", "image"], output: ["text"] },
      };
    }

    // Save merged provider back
    config.provider[CLIENT_KEY] = existingProvider;

    // Other references to a migrated legacy provider follow it
    if (config.model) config.model = repointModelRef(config.model);
    for (const agent of Object.values(config.agent ?? {})) {
      if (typeof agent?.model === "string") agent.model = repointModelRef(agent.model);
    }

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = modelRef(finalActive);
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: modelRef(effectiveSubagentModel),
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    const config = await readJsonConfig(configPath);
    if (!config) {
      return NextResponse.json({ success: true, message: "No config file found" });
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (splitModelRef(config.model)) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove our provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    const config = await readJsonConfig(configPath);
    if (!config) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    // If specific model provided, remove just that model (under whichever key holds it)
    const holders = ALL_CLIENT_KEYS.filter((key) => config.provider?.[key]?.models);
    if (modelToRemove && holders.length > 0) {
      for (const key of holders) {
        const entry = config.provider[key];
        delete entry.models[modelToRemove];

        const remainingModels = Object.keys(entry.models);
        if (remainingModels.length === 0) {
          // No models left: remove the provider
          delete config.provider[key];
          if (splitModelRef(config.model)?.key === key) delete config.model;
        } else if (config.model === `${key}/${modelToRemove}`) {
          // Removed model was active: switch to first remaining model, same namespace
          config.model = `${key}/${remainingModels[0]}`;
        }
      }
    } else {
      // No specific model - remove our provider under every known key
      for (const key of ALL_CLIENT_KEYS) if (config.provider) delete config.provider[key];
      if (splitModelRef(config.model)) delete config.model;
    }

    // Remove subagent configuration
    if (splitModelRef(config.agent?.explorer?.model)) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove
        ? `Model "${modelToRemove}" removed`
        : `${CLIENT_NAME} settings removed from OpenCode`,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
