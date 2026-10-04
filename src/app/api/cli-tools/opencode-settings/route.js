"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { buildOpenCodeConfig } from "@/lib/cliToolConfigs/opencode";
import { withV1 } from "@/lib/cliToolConfigs/shared";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState";
import { getAdapter } from "@/lib/db/driver";
import {
  ALL_CLIENT_KEYS,
  CLIENT_KEY,
  CLIENT_NAME,
  findClientEntry,
  LEGACY_CLIENT_KEYS,
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

// YAN-363: hashed durable mode gates credential handling on this route.
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

// Targeted sanitization of OUR provider entry only; unrelated external
// provider entries pass through untouched.
function sanitizedConfigCopy(config) {
  const copy = config ? JSON.parse(JSON.stringify(config)) : null;
  for (const key of ALL_CLIENT_KEYS) {
    if (copy?.provider?.[key]?.options) delete copy.provider[key].options.apiKey;
  }
  return copy;
}

function credentialConfiguredOf(config) {
  const entry = findClientEntry(config?.provider);
  return typeof entry?.options?.apiKey === "string" && entry.options.apiKey.length > 0;
}

// GET - Check opencode CLI and read current settings
export async function GET() {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
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

    if (hashed) {
      const copy = sanitizedConfigCopy(config);
      const providerConfig = findClientEntry(copy?.provider);
      const modelMap = providerConfig?.models || {};
      return NextResponse.json({
        installed: true,
        config: copy,
        hasTokenhop: hasTokenhopConfig(config),
        credentialConfigured: credentialConfiguredOf(config),
        storage: "hashed",
        configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: splitModelRef(copy?.model)?.model ?? null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
      });
    }

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
    console.log("Error checking opencode settings:", hashed ? "Config operation failed" : error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply our provider as openai-compatible provider (multi-model support)
export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const body = await request.json();
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = body;

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

    let destination = baseUrl;
    let effectiveApiKey = typeof apiKey === "string" && apiKey ? apiKey : null;
    if (hashed) {
      const existingEntry = findClientEntry(config?.provider);
      const existing =
        typeof existingEntry?.options?.apiKey === "string" ? existingEntry.options.apiKey : null;
      try {
        destination = destinationIdentity(baseUrl, true);
        if (!effectiveApiKey) {
          if (!existing || destinationIdentity(existingEntry?.options?.baseURL) !== destination) {
            return NextResponse.json(
              { error: "Provide apiKey for this destination" },
              { status: 400 },
            );
          }
          effectiveApiKey = existing;
        }
      } catch {
        return NextResponse.json({ error: "Invalid baseUrl" }, { status: 400 });
      }
    }

    const built = buildOpenCodeConfig({
      baseUrl: destination,
      apiKey: effectiveApiKey ?? "",
      models: modelsArray,
      activeModel,
      subagentModel,
    })[0].value;
    const builtProvider = built.provider[CLIENT_KEY];
    // The builder's default key is legacy-only. In hashed mode with no
    // explicit/stored credential, persist no secret rather than a brand key.
    if (hashed && !effectiveApiKey) delete builtProvider.options.apiKey;

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing entry and its models. Every legacy spelling is
    // migrated and merged under ours (later entries win: other legacy spellings,
    // the primary legacy one, then ours), so no model is lost.
    const entries = [...[...LEGACY_CLIENT_KEYS].reverse(), CLIENT_KEY]
      .map((key) => config.provider[key])
      .filter(Boolean);
    takeLegacyEntry(config.provider);
    const existingProvider =
      entries.length > 1
        ? entries.reduce((acc, e) => ({
            ...acc,
            ...e,
            options: { ...acc.options, ...e.options },
            models: { ...acc.models, ...e.models },
          }))
        : (entries[0] ?? {
            npm: "@ai-sdk/openai-compatible",
            options: {},
            models: {},
          });

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      ...builtProvider.options,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models (existing ones kept)
    for (const [m, entry] of Object.entries(builtProvider.models)) {
      existingProvider.models[m] = entry;
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
    config.model = built.model;

    // Add subagent configuration
    config.agent = { ...config.agent, explorer: built.agent.explorer };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    if (hashed) {
      console.log("Error applying opencode settings");
      return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
    }
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
