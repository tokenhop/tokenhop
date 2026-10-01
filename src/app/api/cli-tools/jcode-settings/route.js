"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { configErrorResponse, readTomlConfig } from "@/lib/cliToolConfig";
import {
  ALL_CLIENT_KEYS,
  ALL_JCODE_API_KEY_ENVS,
  CLIENT_KEY,
  findClientEntry,
  isClientKey,
  JCODE_API_KEY_ENV,
  LEGACY_CLIENT_KEYS,
  takeLegacyEntry,
} from "@/lib/cliToolBrand";

const execAsync = promisify(exec);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

const envFileName = (key) => `provider-${key.toLowerCase()}.env`;
// legacy(9router): remove in v2 — env files older versions wrote, migrated on Apply
const LEGACY_ENV_FILES = [...new Set(LEGACY_CLIENT_KEYS.map(envFileName))];

const getProviderEnvPath = (fileName = envFileName(CLIENT_KEY)) => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", fileName);
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    return { providers: {} };
  }
};

const hasTokenhopConfig = (config) => {
  const providers = config?.providers;
  if (!providers) return false;
  if (findClientEntry(providers)) return true;
  return Object.values(providers).some((provider) =>
    provider?.base_url?.includes("localhost:20128"),
  );
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await fs.writeFile(configPath, content, "utf-8");
};

const readProviderEnv = async (fileName) => {
  try {
    const envPath = getProviderEnvPath(fileName);
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env, fileName) => {
  const envPath = getProviderEnvPath(fileName);
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}="${value}"\n`;
  }

  // Holds an API key: owner-only, like the rest of the user's secrets.
  await fs.writeFile(envPath, content, { encoding: "utf-8", mode: 0o600 });
};

// The saved key from our env file, else from a legacy one (not migrated yet)
const readSavedApiKey = async () => {
  for (const file of new Set(ALL_CLIENT_KEYS.map(envFileName))) {
    const env = await readProviderEnv(file);
    const name = ALL_JCODE_API_KEY_ENVS.find((n) => env[n]);
    if (name) return env[name];
  }
  return null;
};

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message:
        "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();

  return NextResponse.json({
    installed: true,
    config,
    hasTokenhop: hasTokenhopConfig(config),
    // The card preselects the saved key; local-only route, like claude-settings' env.
    envApiKey: await readSavedApiKey(),
    configPath: getConfigPath(),
  });
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: "baseUrl and apiKey are required" }, { status: 400 });
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    const config = (await readTomlConfig(getConfigPath())) ?? {};

    config.providers ??= {};
    // Migrating a legacy entry keeps its models, extra fields and default model;
    // otherwise the entry is rewritten exactly as before.
    const legacy = takeLegacyEntry(config.providers) ?? {};
    config.providers[CLIENT_KEY] = {
      ...legacy,
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: JCODE_API_KEY_ENV,
      env_file: envFileName(CLIENT_KEY),
      default_model: models?.[0] || legacy.default_model || "cc/claude-opus-4-7",
      requires_api_key: true,
    };
    if (LEGACY_CLIENT_KEYS.includes(config.provider?.default_provider)) {
      config.provider.default_provider = CLIENT_KEY;
    }

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    await fs.mkdir(path.join(xdgConfigDir, "jcode"), { recursive: true });

    // New env file first (keeping any other vars from the legacy one), then the
    // config, and only then drop the legacy file, so a failure never strands the key.
    const env = {};
    for (const file of LEGACY_ENV_FILES) Object.assign(env, await readProviderEnv(file));
    Object.assign(env, await readProviderEnv());
    for (const name of ALL_JCODE_API_KEY_ENVS) delete env[name];
    env[JCODE_API_KEY_ENV] = apiKey;
    await writeProviderEnv(env);

    await writeConfig(config);

    for (const file of LEGACY_ENV_FILES) {
      // Apply already succeeded; a leftover legacy file is harmless, so only log it
      await fs.rm(getProviderEnvPath(file), { force: true }).catch((error) => {
        console.warn(`jcode: could not remove legacy ${file}:`, error.message);
      });
    }

    return NextResponse.json({
      success: true,
      message: `jcode configured successfully. Use: jcode --provider-profile ${CLIENT_KEY}`,
      configPath: getConfigPath(),
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.error("Error configuring jcode:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const config = await readTomlConfig(getConfigPath());

    if (!config?.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    for (const key of ALL_CLIENT_KEYS) delete config.providers[key];
    if (isClientKey(config.provider?.default_provider)) delete config.provider.default_provider;

    await writeConfig(config);

    for (const file of new Set(ALL_CLIENT_KEYS.map(envFileName))) {
      const env = await readProviderEnv(file);
      if (!ALL_JCODE_API_KEY_ENVS.some((name) => name in env)) continue;
      for (const name of ALL_JCODE_API_KEY_ENVS) delete env[name];
      await writeProviderEnv(env, file);
    }

    return NextResponse.json({
      success: true,
      message: `${CLIENT_KEY} configuration removed from jcode`,
    });
  } catch (error) {
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
