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
    return NextResponse.json({
      installed: true,
      settings: { auth: auth ? Object.keys(auth) : [] },
      hasTokenhop: hasTokenhopConfig(auth),
      authPath: getAuthPath(),
    });
  } catch (error) {
    console.log("Error checking kilo settings:", error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json(
        { error: "baseUrl, apiKey and model are required" },
        { status: 400 },
      );
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    const [authFragment, vscodeFragment] = buildKiloConfig({ baseUrl, apiKey, model });

    const auth = (await readJsonConfig(getAuthPath())) || {};
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
