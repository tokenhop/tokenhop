"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { stringifyTOML } from "confbox";
import { getApiKeys } from "@/lib/localDb";
import { configErrorResponse, readTomlConfig } from "@/lib/cliToolConfig";
import { BRAND, LEGACY } from "@/shared/brand";
import {
  ALL_CLIENT_KEYS,
  CLIENT_KEY,
  CLIENT_NAME,
  isClientKey,
  LEGACY_CLIENT_KEYS,
  takeLegacyEntry,
} from "@/lib/cliToolBrand";
import { buildCodexConfig } from "@/lib/cliToolConfigs/codex";

const execAsync = promisify(exec);

const getCodexDir = () => path.join(os.homedir(), ".codex");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");
const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");

// True only when the key is one 9Router itself wrote to auth.json (legacy flow).
// A DB failure must mean "don't delete".
const isRouterApiKey = async (key) => {
  try {
    const apiKeys = await getApiKeys();
    return apiKeys.some((apiKey) => apiKey.key === key);
  } catch {
    return false;
  }
};

// Set a nested key from a flat dotted path, creating intermediate objects as needed
const setNestedSection = (obj, dottedKey, value) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
};

// Delete a nested key from a flat dotted path
const deleteNestedSection = (obj, dottedKey) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
};

// Check if codex CLI is installed (via which/where or config file exists)
const checkCodexInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where codex" : "which codex";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getCodexConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current config.toml
const readConfig = async () => {
  try {
    const configPath = getCodexConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// True when the config points at our provider under the current or a legacy key
const hasTokenhopConfig = (config) =>
  Boolean(config) &&
  ALL_CLIENT_KEYS.some(
    (key) =>
      config.includes(`model_provider = "${key}"`) || config.includes(`[model_providers.${key}]`),
  );

// Repoint per-profile `model_provider` from a legacy key to ours
const repointProfiles = (parsed) => {
  for (const profile of Object.values(parsed.profiles ?? {})) {
    if (LEGACY_CLIENT_KEYS.includes(profile?.model_provider)) profile.model_provider = CLIENT_KEY;
  }
};

// GET - Check codex CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkCodexInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Codex CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasTokenhop: hasTokenhopConfig(config),
      configPath: getCodexConfigPath(),
    });
  } catch (error) {
    console.log("Error checking codex settings:", error);
    return NextResponse.json({ error: "Failed to check codex settings" }, { status: 500 });
  }
}

// POST - Write our provider settings (merge with existing config)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, subagentModel } = await request.json();

    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json(
        { error: "baseUrl, apiKey and model are required" },
        { status: 400 },
      );
    }

    const codexDir = getCodexDir();
    const configPath = getCodexConfigPath();

    // Ensure directory exists
    await fs.mkdir(codexDir, { recursive: true });

    // Read and parse existing config (unparseable file → 422, left untouched)
    const parsed = (await readTomlConfig(configPath)) ?? {};

    const [fragment] = buildCodexConfig({ baseUrl, apiKey, model, subagentModel });

    // Update only our fields (api_key goes to auth.json, not config.toml)
    parsed.model = fragment.value.model;
    parsed.model_provider = fragment.value.model_provider;
    repointProfiles(parsed);

    // Migrating a legacy entry keeps its extra fields (e.g. request_max_retries);
    // otherwise the entry is rewritten exactly as before.
    const previous = takeLegacyEntry(parsed.model_providers) ?? {};
    // Custom providers ignore auth.json - the key must travel as a static header
    setNestedSection(parsed, `model_providers.${CLIENT_KEY}`, {
      ...previous,
      ...fragment.value.model_providers[CLIENT_KEY],
      http_headers: {
        ...previous.http_headers,
        ...fragment.value.model_providers[CLIENT_KEY].http_headers,
      },
    });

    // Subagent model is a scalar under [agents]; agents.<role> now means a custom role
    deleteNestedSection(parsed, "agents.subagent");
    setNestedSection(
      parsed,
      "agents.default_subagent_model",
      fragment.value.agents.default_subagent_model,
    );

    // Write merged config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    return NextResponse.json({
      success: true,
      message: "Codex settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error updating codex settings:", error);
    const parseError = configErrorResponse(error);
    if (parseError) return parseError;
    return NextResponse.json({ error: "Failed to update codex settings" }, { status: 500 });
  }
}

// DELETE - Remove our provider settings only (keep other settings)
export async function DELETE() {
  try {
    const configPath = getCodexConfigPath();

    // Read and parse existing config
    const parsed = await readTomlConfig(configPath);
    if (!parsed) {
      return NextResponse.json({
        success: true,
        message: "No config file to reset",
      });
    }

    // Remove root fields only if they point to our provider (any brand key)
    if (isClientKey(parsed.model_provider)) {
      delete parsed.model;
      delete parsed.model_provider;
    }

    for (const key of ALL_CLIENT_KEYS) deleteNestedSection(parsed, `model_providers.${key}`);
    // A profile left pointing at a removed provider breaks Codex; let it use the default
    for (const profile of Object.values(parsed.profiles ?? {})) {
      if (isClientKey(profile?.model_provider)) delete profile.model_provider;
    }

    // Remove subagent configuration (both the current key and the legacy role form)
    deleteNestedSection(parsed, "agents.default_subagent_model");
    deleteNestedSection(parsed, "agents.subagent");

    // Write updated config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    // Legacy cleanup: older 9Router versions wrote their key into auth.json.
    // Remove it only when it is ours — never touch a user's own key, never unlink.
    const authPath = getCodexAuthPath();
    try {
      const authData = JSON.parse(await fs.readFile(authPath, "utf-8"));
      const key = authData?.OPENAI_API_KEY;
      // legacy(9router): remove in v2 — old installs still carry sk_9router in auth.json
      if (
        key &&
        (key === BRAND.defaultApiKey || key === LEGACY.defaultApiKey || (await isRouterApiKey(key)))
      ) {
        delete authData.OPENAI_API_KEY;
        if (authData.auth_mode === "apikey") delete authData.auth_mode;
        await fs.writeFile(authPath, JSON.stringify(authData, null, 2));
      }
    } catch {
      /* No or unparseable auth file — leave it untouched */
    }

    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} settings removed successfully`,
    });
  } catch (error) {
    console.log("Error resetting codex settings:", error);
    const parseError = configErrorResponse(error);
    if (parseError) return parseError;
    return NextResponse.json({ error: "Failed to reset codex settings" }, { status: 500 });
  }
}
