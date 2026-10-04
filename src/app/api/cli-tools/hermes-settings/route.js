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
import { CLIENT_NAME } from "@/lib/cliToolBrand";
import { buildHermesConfig, MODEL_BLOCK_RE } from "@/lib/cliToolConfigs/hermes";

const execAsync = promisify(exec);

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
    api_key: get("api_key"),
  };
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getHermesConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigYaml = async () => {
  try {
    return await fs.readFile(getHermesConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readEnvFile = async () => {
  try {
    return await fs.readFile(getHermesEnvPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// Detect our config by base_url containing localhost/127.0.0.1 or matching tunnel URL
const hasTokenhopConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return (
    modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(modelCfg.base_url)
  );
};

export async function GET() {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Hermes Agent is not installed",
      });
    }
    const yaml = await readConfigYaml();
    const model = parseModelBlock(yaml);
    if (hashed) {
      // Targeted sanitization: withhold only the inline api_key hint; the .env
      // file itself is never read back in either storage mode.
      const copy = configCopy(model);
      const configured = typeof copy?.api_key === "string" && copy.api_key.length > 0;
      if (copy) delete copy.api_key;
      return NextResponse.json({
        installed: true,
        settings: { model: copy },
        hasTokenhop: hasTokenhopConfig(model),
        credentialConfigured: configured,
        storage: "hashed",
        configPath: getHermesConfigPath(),
      });
    }
    return NextResponse.json({
      installed: true,
      settings: { model },
      hasTokenhop: hasTokenhopConfig(model),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

export async function POST(request) {
  let hashed = false;
  try {
    hashed = await hashedStorageMode();
  } catch {
    return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
  }
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    // Hashed storage: reuse the stored key only for the SAME destination; a
    // changed or missing one is an actionable 400 before a file is touched.
    // The .env write stays omission-safe: only an explicit key reaches it.
    let effectiveApiKey = apiKey;
    if (hashed) {
      const stored = {};
      for (const line of (await readEnvFile()).split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        stored[line.slice(0, eq).trim()] = value;
      }
      effectiveApiKey = resolveCredential({
        provided: apiKey,
        baseUrl,
        existing: stored.OPENAI_API_KEY
          ? [{ key: stored.OPENAI_API_KEY, url: parseModelBlock(await readConfigYaml())?.base_url }]
          : [],
      });
    }
    const dir = getHermesDir();
    await fs.mkdir(dir, { recursive: true });

    // Update config.yaml (replace/insert model: block, keep everything else) and
    // .env (upsert OPENAI_API_KEY only when caller provides one)
    const fragments = buildHermesConfig({
      baseUrl,
      apiKey: effectiveApiKey,
      model,
      existingYaml: await readConfigYaml(),
      existingEnv: effectiveApiKey ? await readEnvFile() : "",
    });
    const paths = {
      "~/.hermes/config.yaml": getHermesConfigPath(),
      "~/.hermes/.env": getHermesEnvPath(),
    };
    for (const { file, value } of fragments) await fs.writeFile(paths[file], value);

    return NextResponse.json({
      success: true,
      message: "Hermes settings applied successfully!",
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    let yaml = "";
    try {
      yaml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }
    const newYaml = removeModelBlock(yaml);
    await fs.writeFile(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${CLIENT_NAME} model block removed` });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
