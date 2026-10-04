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
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { ACTIVE } from "@/shared/brand";
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
import { buildOpenClawConfig } from "@/lib/cliToolConfigs/openclaw";

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
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
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
    if (hashed) {
      // Targeted sanitization: only our provider creds in openclaw.json are
      // withheld; unrelated providers and per-agent files pass through as-is.
      // Iterate every known client slot (current + legacy): matching entries
      // each lose their credential in the returned copy only.
      const copy = configCopy(settings);
      const providers = copy?.models?.providers;
      let configured = false;
      for (const key of ALL_CLIENT_KEYS) {
        const slot = providers?.[key];
        if (typeof slot?.apiKey === "string" && slot.apiKey.length > 0) configured = true;
        if (slot) delete slot.apiKey;
      }
      const agentList = settings?.agents?.list || [];
      const enrichedAgents = await Promise.all(
        agentList.map(async (agent) => {
          const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
          return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
        }),
      );
      return NextResponse.json({
        installed: true,
        settings: copy,
        agents: enrichedAgents,
        hasTokenhop: hasTokenhopConfig(settings),
        credentialConfigured: configured,
        storage: "hashed",
        settingsPath: getOpenClawSettingsPath(),
      });
    }

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
    if (hashed) return boundaryError(error);
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// Write per-agent models.json
const writeAgentModels = async ({ file, value }) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = (await readJsonConfig(file)) ?? {};

  if (!existing.providers) existing.providers = {};
  // A legacy entry migrates under ours, keeping its extra fields
  const legacy = takeLegacyEntry(existing.providers);
  existing.providers[CLIENT_KEY] = { ...legacy, ...value.providers[CLIENT_KEY] };
  await fs.writeFile(file, JSON.stringify(existing, null, 2));
};

// POST - Update our provider settings (merge with existing settings)
export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    const settings = (await readJsonConfig(settingsPath)) ?? {};

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    // Hashed storage: reuse the stored key only for the SAME destination; a
    // changed or missing one is an actionable 400 before a file is touched —
    // never the default-key fallback.
    let effectiveApiKey = apiKey || ACTIVE.defaultApiKey;
    if (hashed) {
      const owned = ALL_CLIENT_KEYS.map((key) => settings.models.providers?.[key]).filter(
        (entry) => typeof entry?.apiKey === "string" && entry.apiKey,
      );
      effectiveApiKey = resolveCredential({
        provided: apiKey,
        baseUrl,
        existing: owned.map((entry) => ({ key: entry.apiKey, url: entry.baseUrl })),
      });
    }
    await fs.mkdir(openclawDir, { recursive: true });

    const [main, ...agentFiles] = buildOpenClawConfig({
      baseUrl,
      apiKey: effectiveApiKey,
      model,
      agents: settings.agents.list ?? [],
      agentModels,
    });
    const { defaults, list: overrides = [] } = main.value.agents;
    const ownProvider = main.value.models.providers[CLIENT_KEY];

    // Remove our old entries from agents.defaults.models (the namespaces Apply
    // migrates; Reset additionally clears every known key)
    Object.keys(settings.agents.defaults.models)
      .filter(isOwnedRef)
      .forEach((k) => {
        delete settings.agents.defaults.models[k];
      });

    // Update default model and repoint any legacy fallback references
    settings.agents.defaults.model.primary = defaults.model.primary;
    if (Array.isArray(settings.agents.defaults.model.fallbacks)) {
      settings.agents.defaults.model.fallbacks =
        settings.agents.defaults.model.fallbacks.map(repointModelRef);
    }

    // Add fresh models (default + per-agent) to allowlist
    Object.assign(settings.agents.defaults.models, defaults.models);

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
    settings.models.providers[CLIENT_KEY] = { ...legacyProvider, ...ownProvider };

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const override = overrides.find((o) => o.id === agent.id);
        return override ? { ...agent, model: override.model } : agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(agentFiles.map((fragment) => writeAgentModels(fragment)));
    }

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
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
