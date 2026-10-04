"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { CLIENT_NAME, isCustomModelId, isOwnedCustomModelId } from "@/lib/cliToolBrand";
import { buildDroidConfig } from "@/lib/cliToolConfigs/droid";
import {
  boundaryError,
  configCopy,
  hashedStorageMode,
  resolveCredential,
} from "@/lib/cliToolConfigs/credentialBoundary";
import { ACTIVE } from "@/shared/brand";

const execAsync = promisify(exec);

const getDroidDir = () => path.join(os.homedir(), ".factory");
const getDroidSettingsPath = () => path.join(getDroidDir(), "settings.json");

// Check if droid CLI is installed (via which/where or config file exists)
const checkDroidInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where droid" : "which droid";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getDroidSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getDroidSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Check if settings has our customModels (any brand)
const hasTokenhopConfig = (settings) => {
  if (!settings || !settings.customModels) return false;
  return settings.customModels.some((m) => isCustomModelId(m.id));
};

// GET - Check droid CLI and read current settings
export async function GET() {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const isInstalled = await checkDroidInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Factory Droid CLI is not installed",
      });
    }

    const settings = await readSettings();

    if (hashed) {
      // Targeted sanitization: only our customModels entries lose their key.
      const copy = configCopy(settings);
      let credentialConfigured = false;
      for (const m of Array.isArray(copy?.customModels) ? copy.customModels : []) {
        if (!isOwnedCustomModelId(m?.id)) continue;
        credentialConfigured ||= typeof m.apiKey === "string" && m.apiKey.length > 0;
        delete m.apiKey;
      }
      return NextResponse.json({
        installed: true,
        settings: copy,
        hasTokenhop: hasTokenhopConfig(settings),
        credentialConfigured,
        storage: "hashed",
        settingsPath: getDroidSettingsPath(),
      });
    }

    return NextResponse.json({
      installed: true,
      settings,
      hasTokenhop: hasTokenhopConfig(settings),
      settingsPath: getDroidSettingsPath(),
    });
  } catch (error) {
    if (!hashed) {
      console.log("Error checking droid settings:", error);
      return NextResponse.json({ error: "Failed to check droid settings" }, { status: 500 });
    }
    return boundaryError(error);
  }
}

// POST - Update our customModels (merge with existing settings)
// Accepts either `model` (string, legacy single-model) or `models` (array of strings, multi-model)
// Also accepts `activeModel` to set which model is active/primary
export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const { baseUrl, apiKey, model, models, activeModel } = await request.json();

    // Accept either `models` (array) or `model` (string, legacy)
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

    const droidDir = getDroidDir();
    const settingsPath = getDroidSettingsPath();

    // Read existing settings or create new
    const settings = (await readJsonConfig(settingsPath)) ?? {};

    // Hashed storage: reuse the stored key only for the SAME destination; a
    // changed or missing one is an actionable 400 before anything is written —
    // never the default-key fallback.
    let effectiveApiKey = apiKey || ACTIVE.defaultApiKey;
    if (hashed) {
      const ours = (settings.customModels ?? []).filter(
        (m) => isOwnedCustomModelId(m?.id) && typeof m.apiKey === "string" && m.apiKey,
      );
      effectiveApiKey = resolveCredential({
        provided: apiKey,
        baseUrl,
        existing: ours.map((m) => ({ key: m.apiKey, url: m.baseUrl })),
      });
    }

    // Ensure the directory exists before writing
    await fs.mkdir(droidDir, { recursive: true });

    // Ensure customModels array exists
    if (!settings.customModels) {
      settings.customModels = [];
    }

    // Remove all existing configs of ours (active brand, plus legacy under tokenhop)
    settings.customModels = settings.customModels.filter((m) => !isOwnedCustomModelId(m.id));

    // Our entries (active model first) come from the builder the manual snippet uses
    const fragments = buildDroidConfig({
      baseUrl,
      apiKey: effectiveApiKey,
      models: modelsArray,
      activeModel,
    });
    settings.customModels.push(...(fragments?.[0].value.customModels ?? []));
    // index mirrors array position across the whole list, so ours never collide with the user's.
    settings.customModels.forEach((m, i) => {
      m.index = i;
    });

    // Write settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Factory Droid settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    const configRes = configErrorResponse(error);
    if (configRes) return configRes;
    console.log("Error updating droid settings:", error);
    return NextResponse.json({ error: "Failed to update droid settings" }, { status: 500 });
  }
}

// DELETE - Remove our customModels only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getDroidSettingsPath();

    // Read existing settings
    const settings = await readJsonConfig(settingsPath);
    if (!settings) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    // Remove our customModels (any brand)
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter((m) => !isCustomModelId(m.id));

      // Remove customModels array if empty
      if (settings.customModels.length === 0) {
        delete settings.customModels;
      }
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
    console.log("Error resetting droid settings:", error);
    return NextResponse.json({ error: "Failed to reset droid settings" }, { status: 500 });
  }
}
