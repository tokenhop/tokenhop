"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import {
  ALL_CLIENT_KEYS,
  CLIENT_NAME,
  findClientEntry,
  takeLegacyEntry,
  urlNamesClient,
} from "@/lib/cliToolBrand";
import { buildKiloConfig } from "@/lib/cliToolConfigs/kilo";

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

const getDataDir = () => path.join(os.homedir(), ".local", "share", "kilo");
const getAuthPath = () => path.join(getDataDir(), "auth.json");
const getVscodeSettingsPath = () =>
  path.join(os.homedir(), ".config", "Code", "User", "settings.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where kilo" : "which kilo";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getAuthPath());
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

const hasTokenhopConfig = (auth) => {
  if (!auth) return false;
  const entry = auth["openai-compatible"] || findClientEntry(auth);
  if (!entry) return false;
  const baseUrl = entry.baseUrl || entry.baseURL || "";
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || urlNamesClient(baseUrl);
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
        message: "Kilo Code CLI is not installed",
      });
    }
    const auth = await readJson(getAuthPath());
    const credentialConfigured = !!(auth?.["openai-compatible"] || findClientEntry(auth))?.apiKey;
    return NextResponse.json({
      installed: true,
      ...(hashed ? { storage: "hashed", credentialConfigured } : {}),
      settings: { auth: auth ? Object.keys(auth) : [] },
      hasTokenhop: hasTokenhopConfig(auth),
      authPath: getAuthPath(),
    });
  } catch (error) {
    console.log("Error checking kilo settings:", hashed ? "Config operation failed" : error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
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

    const auth = (await readJsonConfig(getAuthPath())) || {};
    if (hashed) {
      const existing = auth["openai-compatible"] || findClientEntry(auth);
      let intended;
      try {
        intended = destination(baseUrl);
        if (
          !apiKey &&
          (!existing?.apiKey || destination(existing.baseUrl || existing.baseURL) !== intended)
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
      apiKey = apiKey || existing?.apiKey;
      baseUrl = intended;
    }
    const [authFragment, vscodeFragment] = buildKiloConfig({ baseUrl, apiKey, model });
    await fs.mkdir(getDataDir(), { recursive: true });

    // Drop legacy-named entries (tokenhop brand only): their type/apiKey/baseUrl/model are
    // all superseded by the openai-compatible entry written below
    takeLegacyEntry(auth);
    Object.assign(auth, authFragment.value);
    await fs.writeFile(getAuthPath(), JSON.stringify(auth, null, 2));

    // Best-effort: update VS Code extension settings. An unparseable (JSONC) file
    // throws before the write, so it is skipped rather than overwritten.
    try {
      const vscode = (await readJsonConfig(getVscodeSettingsPath())) || {};
      Object.assign(vscode, vscodeFragment.value);
      await fs.writeFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
    } catch {
      /* VS Code settings not writable */
    }

    return NextResponse.json({
      success: true,
      message: "Kilo Code settings applied successfully!",
      authPath: getAuthPath(),
    });
  } catch (error) {
    if (hashed)
      return NextResponse.json({ error: "Failed to update kilo settings" }, { status: 500 });
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error updating kilo settings:", error);
    return NextResponse.json({ error: "Failed to update kilo settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const auth = await readJsonConfig(getAuthPath());
    if (!auth) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    delete auth["openai-compatible"];
    for (const key of ALL_CLIENT_KEYS) delete auth[key];
    await fs.writeFile(getAuthPath(), JSON.stringify(auth, null, 2));

    try {
      const vscode = await readJsonConfig(getVscodeSettingsPath());
      if (vscode) {
        delete vscode["kilocode.customProvider"];
        delete vscode["kilocode.defaultModel"];
        await fs.writeFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
      }
    } catch {
      /* ignore */
    }

    return NextResponse.json({
      success: true,
      message: `${CLIENT_NAME} settings removed from Kilo Code`,
    });
  } catch (error) {
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error resetting kilo settings:", error);
    return NextResponse.json({ error: "Failed to reset kilo settings" }, { status: 500 });
  }
}
