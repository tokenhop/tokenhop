"use server";

import { NextResponse } from "next/server";
import {
  boundaryError,
  configCopy,
  hashedStorageMode,
  resolveCredential,
} from "@/lib/cliToolConfigs/credentialBoundary";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { DEFAULT_PLUGINS, LOCAL_STDIO_PLUGINS } from "@/shared/constants/coworkPlugins";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { CLI_TOKEN_HEADER, getCliToken } from "@/lib/auth/cliToken";
import { configErrorResponse, readJsonConfig } from "@/lib/cliToolConfig";
import {
  PROVIDER,
  buildCoworkConfig,
  buildCoworkMcpServers,
  coworkMeta,
} from "@/lib/cliToolConfigs/cowork";

const APP_PORT = UPDATER_CONFIG.appPort;
const LOCAL_MCP_PREFIX = `http://localhost:${APP_PORT}/api/mcp/`;

// Inject CLI token header into entries pointing at our local /api/mcp/ bridge.
const injectAuthHeaders = async (entries) => {
  const token = await getCliToken();
  for (const e of entries) {
    if (typeof e?.url === "string" && e.url.startsWith(LOCAL_MCP_PREFIX)) {
      e.headers = { ...(e.headers || {}), [CLI_TOKEN_HEADER]: token };
    }
  }
  return entries;
};

// Tools auto-allow per server via toolPolicy["*"] = "allow" semantics.
// 3p schema requires explicit tool names; we mark "*" via operonSkipMcpApprovals instead.

const getCandidateRoots = () => {
  if (os.platform() === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support");
    return [path.join(base, "Claude-3p"), path.join(base, "Claude")];
  }
  if (os.platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return [
      path.join(localApp, "Claude-3p"),
      path.join(roaming, "Claude-3p"),
      path.join(localApp, "Claude"),
      path.join(roaming, "Claude"),
    ];
  }
  return [
    path.join(os.homedir(), ".config", "Claude-3p"),
    path.join(os.homedir(), ".config", "Claude"),
  ];
};

const getAppInstallPaths = () => {
  if (os.platform() === "darwin") {
    return ["/Applications/Claude.app", path.join(os.homedir(), "Applications", "Claude.app")];
  }
  if (os.platform() === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    return [
      path.join(localApp, "AnthropicClaude"),
      path.join(programFiles, "Claude"),
      path.join(programFiles, "AnthropicClaude"),
    ];
  }
  return [];
};

const resolveAppRootForRead = async () => {
  const candidates = getCandidateRoots();
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, "configLibrary"));
      return dir;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
};

const getWriteRoot = () => getCandidateRoots()[0];
const getConfigDir = async () => path.join(await resolveAppRootForRead(), "configLibrary");
const getWriteConfigDir = () => path.join(getWriteRoot(), "configLibrary");
const getMetaPath = async () => path.join(await getConfigDir(), "_meta.json");
const getWriteMetaPath = () => path.join(getWriteConfigDir(), "_meta.json");

const get1pRoot = () => {
  if (os.platform() === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Claude");
  if (os.platform() === "win32") {
    const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(roaming, "Claude");
  }
  return path.join(os.homedir(), ".config", "Claude");
};

const get1pConfigPath = () => path.join(get1pRoot(), "claude_desktop_config.json");

// Missing file: {} so writes can proceed. Unparseable: throws so write paths
// surface it instead of silently overwriting the user's config.
const read1pConfig = async () => (await readJsonConfig(get1pConfigPath())) || {};

const write1pConfig = async (cfg) => {
  await fs.mkdir(get1pRoot(), { recursive: true });
  await fs.writeFile(get1pConfigPath(), JSON.stringify(cfg, null, 2));
};

const bootstrapDeploymentMode = async () => {
  const cfg = await read1pConfig();
  if (cfg.deploymentMode === "3p") return false;
  cfg.deploymentMode = "3p";
  await write1pConfig(cfg);
  return true;
};

// Remove any legacy stdio entries previously written into 1p claude_desktop_config.json.
const cleanup1pLegacy = async () => {
  const cfg = await read1pConfig();
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") return;
  const managedNames = new Set(LOCAL_STDIO_PLUGINS.map((p) => p.name));
  for (const k of Object.keys(cfg.mcpServers)) {
    if (managedNames.has(k)) delete cfg.mcpServers[k];
  }
  if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
  await write1pConfig(cfg);
};

// Build SSE bridge entries pointing at this app's inline /api/mcp/{name} endpoint.
const buildLocalBridgeEntries = (localPluginNames) => {
  const names = Array.isArray(localPluginNames) ? localPluginNames : [];
  const out = [];
  for (const n of names) {
    const def = LOCAL_STDIO_PLUGINS.find((p) => p.name === n);
    if (!def) continue;
    const entry = {
      name: def.name,
      url: `http://localhost:${APP_PORT}/api/mcp/${def.name}/sse`,
      transport: "sse",
    };
    if (Array.isArray(def.toolNames) && def.toolNames.length > 0) {
      const prefix = `${def.name}-`;
      const policy = {};
      for (const t of def.toolNames) {
        policy[t] = "allow";
        policy[`${prefix}${t}`] = "allow";
      }
      entry.toolPolicy = policy;
    }
    out.push(entry);
  }
  return out;
};

const checkInstalled = async () => {
  for (const dir of [...getCandidateRoots(), ...getAppInstallPaths()]) {
    try {
      await fs.access(dir);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
};

// Tolerant status reader (GET): unparseable = null. Write paths use readJsonConfig.
const readJson = async (filePath) => {
  try {
    return await readJsonConfig(filePath);
  } catch {
    return null;
  }
};

const ensureMeta = async () => {
  const writeMetaPath = getWriteMetaPath();
  let meta = await readJsonConfig(writeMetaPath);
  if (!meta || !meta.appliedId) {
    const existingRead = await readJsonConfig(await getMetaPath());
    if (existingRead?.appliedId) {
      meta = existingRead;
    } else {
      meta = coworkMeta(crypto.randomUUID());
    }
    await fs.mkdir(getWriteConfigDir(), { recursive: true });
    await fs.writeFile(writeMetaPath, JSON.stringify(meta, null, 2));
  }
  return meta;
};

// Auto-skip approvals for every managed server (no per-tool prompts).
async function writeSkipApprovals(skip) {
  const cfgPath = path.join(getWriteRoot(), "config.json");
  let cfg;
  try {
    cfg = (await readJsonConfig(cfgPath)) || {};
  } catch (e) {
    return { error: e.code || e.message };
  }
  cfg.operonSkipMcpApprovals = skip;
  await fs.mkdir(getWriteRoot(), { recursive: true });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  return { written: Object.keys(skip).length };
}

export async function GET() {
  let hashed = false;
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
        config: null,
        message: "Claude Desktop (Cowork mode) not detected",
      });
    }
    const meta = await readJson(await getMetaPath());
    const appliedId = meta?.appliedId || null;
    const configDir = await getConfigDir();
    const configPath = appliedId ? path.join(configDir, `${appliedId}.json`) : null;
    const config = configPath ? await readJson(configPath) : null;

    const baseUrl = config?.inferenceGatewayBaseUrl || null;
    const models = Array.isArray(config?.inferenceModels)
      ? config.inferenceModels.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean)
      : [];
    const managedMcp = Array.isArray(config?.managedMcpServers) ? config.managedMcpServers : [];
    const hasTokenhop = !!(config?.inferenceProvider === PROVIDER && baseUrl);

    // Active local plugins = managedMcp entries whose URL points at our inline bridge.
    const stdioNames = new Set(LOCAL_STDIO_PLUGINS.map((p) => p.name));
    const activeLocalNames = managedMcp
      .filter(
        (m) => stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/"),
      )
      .map((m) => m.name);

    // Custom plugins = bridge entries not in preset LOCAL_STDIO_PLUGINS (custom:true or unknown name).
    const activeCustomPlugins = managedMcp
      .filter(
        (m) =>
          m.custom ||
          (!stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/")),
      )
      .map((m) => ({ name: m.name, url: m.url, transport: m.transport, custom: true }));

    // Hashed storage: targeted sanitization — only our gateway key slot is
    // withheld from the copy; everything else keeps its exact legacy shape.
    let sanitizedConfig = config;
    let credentialConfigured = false;
    if (hashed) {
      sanitizedConfig = configCopy(config);
      credentialConfigured =
        typeof sanitizedConfig?.inferenceGatewayApiKey === "string" &&
        sanitizedConfig.inferenceGatewayApiKey.length > 0;
      if (sanitizedConfig) {
        delete sanitizedConfig.inferenceGatewayApiKey;
        // Local bridge entries carry the machine-bound CLI token; it stays on disk.
        for (const m of sanitizedConfig.managedMcpServers ?? []) {
          if (m?.headers) {
            delete m.headers[CLI_TOKEN_HEADER];
            if (Object.keys(m.headers).length === 0) delete m.headers;
          }
        }
      }
    }
    return NextResponse.json({
      installed: true,
      config: hashed ? sanitizedConfig : config,
      hasTokenhop,
      configPath,
      ...(hashed && { credentialConfigured, storage: "hashed" }),
      cowork: {
        appliedId,
        baseUrl,
        models,
        provider: config?.inferenceProvider || null,
        plugins: managedMcp
          .filter(
            (m) =>
              !m.custom &&
              !(stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/")),
          )
          .map((m) => {
            // Strip "{name}-" prefix and dedupe so re-applies don't multiply entries.
            const keys = m.toolPolicy ? Object.keys(m.toolPolicy) : [];
            const prefix = `${m.name}-`;
            const bare = new Set();
            for (const k of keys) {
              let t = k;
              while (t.startsWith(prefix)) t = t.slice(prefix.length);
              bare.add(t);
            }
            // If plugin matches a default, prefer default toolNames (curated/correct).
            const def = DEFAULT_PLUGINS.find((d) => d.name === m.name);
            const toolNames =
              def && Array.isArray(def.toolNames) ? def.toolNames : Array.from(bare);
            return {
              name: m.name,
              url: m.url,
              transport: m.transport,
              oauth: !!m.oauth,
              toolNames,
            };
          }),
        localPlugins: activeLocalNames,
        customPlugins: activeCustomPlugins,
      },
      defaultPlugins: DEFAULT_PLUGINS,
      localStdioPlugins: LOCAL_STDIO_PLUGINS,
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    console.log("Error reading cowork settings:", error);
    return NextResponse.json({ error: "Failed to read cowork settings" }, { status: 500 });
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
    const { baseUrl, apiKey, models, plugins, localPlugins, customPlugins } = await request.json();

    // Hashed storage: reuse the stored key only for the SAME destination; a
    // changed or missing one is an actionable 400 before a file is touched —
    // legacy still requires the pair, so the check stays outside the branch.
    let effectiveApiKey = apiKey;
    if (!hashed && (!baseUrl || !apiKey)) {
      return NextResponse.json({ error: "baseUrl and apiKey are required" }, { status: 400 });
    }
    if (hashed) {
      if (!baseUrl) return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
      let existingRecord = null;
      try {
        existingRecord = await readJson(
          path.join(
            getWriteConfigDir(),
            `${(await readJson(await getMetaPath()))?.appliedId}.json`,
          ),
        );
      } catch {
        existingRecord = null;
      }
      effectiveApiKey = resolveCredential({
        provided: apiKey,
        baseUrl,
        existing: existingRecord?.inferenceGatewayApiKey
          ? [
              {
                key: existingRecord.inferenceGatewayApiKey,
                url: existingRecord.inferenceGatewayBaseUrl,
              },
            ]
          : [],
      });
    }
    const modelsArray = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m.trim())
      : [];
    if (modelsArray.length === 0) {
      return NextResponse.json({ error: "At least one model is required" }, { status: 400 });
    }

    // Respect empty array (user toggled all off); fallback to defaults only when undefined.
    const pluginsArray = Array.isArray(plugins) ? plugins : DEFAULT_PLUGINS;
    const localPluginNames = Array.isArray(localPlugins) ? localPlugins : [];
    // Only URL-based custom plugins allowed (no stdio command spawning).
    const customPluginsArray = (Array.isArray(customPlugins) ? customPlugins : []).filter(
      (p) => p?.url,
    );

    const managedMcpServers = await injectAuthHeaders(
      buildCoworkMcpServers({
        plugins: pluginsArray,
        localServers: buildLocalBridgeEntries(localPluginNames),
        customPlugins: customPluginsArray,
      }),
    );

    const bootstrapped = await bootstrapDeploymentMode();
    const meta = await ensureMeta();
    const configPath = path.join(getWriteConfigDir(), `${meta.appliedId}.json`);
    // Same fragments as the manual snippet: [1p deploymentMode, _meta, config, config.json].
    const [, , configFragment, skipFragment] = buildCoworkConfig({
      baseUrl,
      apiKey: effectiveApiKey,
      models: modelsArray,
      managedMcpServers,
      appliedId: meta.appliedId,
      platform: os.platform(),
    });

    await fs.writeFile(configPath, JSON.stringify(configFragment.value, null, 2));

    let skipResult = null;
    try {
      skipResult = await writeSkipApprovals(skipFragment.value.operonSkipMcpApprovals);
    } catch (e) {
      skipResult = { error: e.message };
    }

    // Best-effort cleanup of legacy 1p mcpServers entries written by earlier versions.
    const localMcpResult = { applied: localPluginNames, via: "3p-sse-bridge" };
    try {
      await cleanup1pLegacy();
    } catch {
      /* ignore */
    }

    return NextResponse.json({
      success: true,
      bootstrapped,
      message: bootstrapped
        ? "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
        : "Cowork settings applied. Quit & reopen Claude Desktop.",
      configPath,
      skipApprovals: skipResult,
      localMcp: localMcpResult,
    });
  } catch (error) {
    if (hashed) return boundaryError(error);
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error applying cowork settings:", error);
    return NextResponse.json({ error: "Failed to apply cowork settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const meta = await readJsonConfig(await getMetaPath());
    if (!meta?.appliedId) {
      return NextResponse.json({ success: true, message: "No active config to reset" });
    }
    const configPath = path.join(await getConfigDir(), `${meta.appliedId}.json`);
    try {
      await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await writeSkipApprovals({});
    } catch {
      /* ignore */
    }
    try {
      await cleanup1pLegacy();
    } catch {
      /* ignore */
    }
    return NextResponse.json({ success: true, message: "Cowork config reset" });
  } catch (error) {
    const res = configErrorResponse(error);
    if (res) return res;
    console.log("Error resetting cowork settings:", error);
    return NextResponse.json({ error: "Failed to reset cowork settings" }, { status: 500 });
  }
}
