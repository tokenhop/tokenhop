"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import { CLIENT_NAME, urlNamesClient } from "@/lib/cliToolBrand";
import { buildClineConfig } from "@/lib/cliToolConfigs/cline";

import { getAdapter } from "@/lib/db/driver.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";

async function hashedStorageMode() {
  return readApiKeyStorageState(await getAdapter()).storage === "hashed";
}

function destination(raw) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid destination");
  // Match the builder's API-root normalization while preserving path identity.
  return `${url.origin}${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}`;
}

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getGlobalStatePath = () => path.join(getDataDir(), "globalState.json");
const getSecretsPath = () => path.join(getDataDir(), "secrets.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where cline" : "which cline";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getGlobalStatePath());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    return await readJsonConfig(filePath);
  } catch {
    return null;
  }
};

const hasTokenhopConfig = (globalState) => {
  if (!globalState) return false;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  const baseUrl = globalState.openAiBaseUrl || "";
  return (
    isOpenAi &&
    (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || urlNamesClient(baseUrl))
  );
};

export async function GET() {
  let hashed;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Cline CLI is not installed",
      });
    }
    const globalState = await readJson(getGlobalStatePath());
    const credentialConfigured = !!(await readJson(getSecretsPath()))?.openAiApiKey;
    return NextResponse.json({
      installed: true,
      ...(hashed ? { storage: "hashed", credentialConfigured } : {}),
      settings: {
        actModeApiProvider: globalState?.actModeApiProvider,
        planModeApiProvider: globalState?.planModeApiProvider,
        openAiBaseUrl: globalState?.openAiBaseUrl,
        openAiModelId: globalState?.openAiModelId,
      },
      hasTokenhop: hasTokenhopConfig(globalState),
      globalStatePath: getGlobalStatePath(),
    });
  } catch (error) {
    console.log("Error checking cline settings:", hashed ? "Config operation failed" : error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  let hashed;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    let { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || (!hashed && !apiKey) || !model) {
      return NextResponse.json(
        { error: "baseUrl, apiKey and model are required" },
        { status: 400 },
      );
    }

    const globalState = (await readJsonConfig(getGlobalStatePath())) || {};
    const secrets = (await readJsonConfig(getSecretsPath())) || {};
    if (hashed) {
      let intended;
      try {
        intended = destination(baseUrl);
        if (
          !apiKey &&
          (!secrets.openAiApiKey || destination(globalState.openAiBaseUrl) !== intended)
        ) {
          return NextResponse.json(
            { error: "Provide apiKey for this destination" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Invalid baseUrl; provide an explicit credential" },
          { status: 400 },
        );
      }
      apiKey = apiKey || secrets.openAiApiKey;
      baseUrl = intended;
    }
    const [globalStateFragment, secretsFragment] = buildClineConfig({ baseUrl, apiKey, model });
    await fs.mkdir(getDataDir(), { recursive: true });

    Object.assign(globalState, globalStateFragment.value);
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    Object.assign(secrets, secretsFragment.value);
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({
      success: true,
      message: "Cline settings applied successfully!",
      globalStatePath: getGlobalStatePath(),
    });
  } catch (error) {
    if (hashed)
      return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const globalState = await readJsonConfig(getGlobalStatePath());
    if (!globalState) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    const secrets = (await readJsonConfig(getSecretsPath())) || {};

    if (globalState.actModeApiProvider === "openai") {
      delete globalState.openAiBaseUrl;
      delete globalState.openAiModelId;
      delete globalState.planModeOpenAiModelId;
      globalState.actModeApiProvider = "cline";
      globalState.planModeApiProvider = "cline";
    }
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    delete secrets.openAiApiKey;
    await fs.writeFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} settings removed from Cline`,
    });
  } catch (error) {
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: 500 });
  }
}
