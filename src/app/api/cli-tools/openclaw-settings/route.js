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
  LEGACY_CLIENT_KEYS,
  modelRef,
  repointModelRef,
  splitModelRef,
  takeLegacyEntry,
} from "@/lib/cliToolBrand";

const execAsync = promisify(exec);

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.primary ?? "";
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getOpenClawSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getOpenClawSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Refs Apply owns: the active key, plus legacy keys it migrates (tokenhop brand)
const isOwnedRef = (value) => {
  const key = splitModelRef(value)?.key;
  return key === CLIENT_KEY || LEGACY_CLIENT_KEYS.includes(key);
};

const hasTokenhopConfig = (settings) => !!findClientEntry(settings?.models?.providers);

// Read per-agent models.json and return the current model id (no provider prefix)
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    const data = JSON.parse(content);
    const models = findClientEntry(data?.providers)?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
      }),
    );

    return NextResponse.json({
      installed: true,
      settings,
      agents: enrichedAgents,
      hasTokenhop: hasTokenhopConfig(settings),
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// Write per-agent models.json
const writeAgentModels = async (agentDir, model, baseUrl, apiKey) => {
  await fs.mkdir(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  const existing = (await readJsonConfig(modelsPath)) ?? {};

  if (!existing.providers) existing.providers = {};
  // A legacy entry migrates under ours, keeping its extra fields
  const legacy = takeLegacyEntry(existing.providers);
  existing.providers[CLIENT_KEY] = {
    ...legacy,
    baseUrl,
    apiKey: apiKey || ACTIVE.defaultApiKey,
    api: "openai-completions",
    models: [{ id: model, name: model.split("/").pop() || model }],
  };
  await fs.writeFile(modelsPath, JSON.stringify(existing, null, 2));
};

// POST - Update our provider settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    await fs.mkdir(openclawDir, { recursive: true });

    const settings = (await readJsonConfig(settingsPath)) ?? {};

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const fullModelId = modelRef(model);

    // Remove our old entries from agents.defaults.models (the namespaces Apply
    // migrates; Reset additionally clears every known key)
    Object.keys(settings.agents.defaults.models)
      .filter(isOwnedRef)
      .forEach((k) => {
        delete settings.agents.defaults.models[k];
      });

    // Update default model and repoint any legacy fallback references
    settings.agents.defaults.model.primary = fullModelId;
    if (Array.isArray(settings.agents.defaults.model.fallbacks)) {
      settings.agents.defaults.model.fallbacks =
        settings.agents.defaults.model.fallbacks.map(repointModelRef);
    }

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set([model]);
    Object.values(agentModels).forEach((m) => {
      if (m) allModelIds.add(m);
    });

    // Add fresh models to allowlist
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[modelRef(m)] = {};
    });

    // Remove our model override from each agent in agents.list. The model
    // field may be a plain string or `{ primary, fallbacks }`; legacy fallbacks
    // of an agent we don't manage follow the migrated provider.
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (isOwnedRef(resolveAgentModel(agent.model))) {
          const { model: _, ...rest } = agent;
          return rest;
        }
        if (!Array.isArray(agent?.model?.fallbacks)) return agent;
        return {
          ...agent,
          model: { ...agent.model, fallbacks: agent.model.fallbacks.map(repointModelRef) },
        };
      });
    }

    // Update models.providers with all models; a legacy entry migrates under
    // ours, keeping its extra fields
    const legacyProvider = takeLegacyEntry(settings.models.providers);
    settings.models.providers[CLIENT_KEY] = {
      ...legacyProvider,
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || ACTIVE.defaultApiKey,
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = agentModels[agent.id];
        if (agentModel) return { ...agent, model: modelRef(agentModel) };
        return agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(
        settings.agents.list.map(async (agent) => {
          if (!agent.agentDir) return;
          const agentModel = agentModels[agent.id];
          const modelToWrite = agentModel || model; // fallback to default
          await writeAgentModels(agent.agentDir, modelToWrite, normalizedBaseUrl, apiKey);
        }),
      );
    }

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error updating openclaw settings:", error);
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 });
  }
}

// DELETE - Remove our provider settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Read existing settings
    const settings = await readJsonConfig(settingsPath);
    if (!settings) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    // Remove our provider from models.providers (every known key)
    if (settings.models && settings.models.providers) {
      for (const key of ALL_CLIENT_KEYS) delete settings.models.providers[key];

      // Remove providers object if empty
      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove our models from agents.defaults.models allowlist (every known key)
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) =>
        ALL_CLIENT_KEYS.some((key) => k.startsWith(`${key}/`)),
      );
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it points at our provider
    if (splitModelRef(settings.agents?.defaults?.model?.primary)) {
      delete settings.agents.defaults.model.primary;
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} settings removed successfully`,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error resetting openclaw settings:", error);
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 });
  }
}
