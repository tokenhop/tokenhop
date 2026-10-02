// Claude Desktop Cowork (3p): deploymentMode in the 1p config, then _meta.json,
// <appliedId>.json and config.json under the Claude-3p root.
import { buildManagedMcpServers } from "@/shared/constants/coworkPlugins";

export const PROVIDER = "gateway";

// Hardcoded relax-security profile applied on every Apply.
export const SECURITY_RELAX = {
  coworkEgressAllowedHosts: ["*"],
  disabledBuiltinTools: [],
  isLocalDevMcpEnabled: true,
  isDesktopExtensionEnabled: true,
  isDesktopExtensionDirectoryEnabled: true,
  isDesktopExtensionSignatureRequired: false,
  isClaudeCodeForDesktopEnabled: true,
  disableEssentialTelemetry: true,
  disableNonessentialTelemetry: true,
  disableNonessentialServices: true,
};

/** Display path of the Claude-3p write root for an OS platform name. */
export const coworkRoot = (platform) => {
  if (platform === "win32") return "%LOCALAPPDATA%\\Claude-3p";
  if (platform === "darwin") return "~/Library/Application Support/Claude-3p";
  return "~/.config/Claude-3p";
};

/** Display path of the 1p claude_desktop_config.json for an OS platform name. */
export const cowork1pConfigFile = (platform) => {
  if (platform === "win32") return "%APPDATA%\\Claude\\claude_desktop_config.json";
  if (platform === "darwin") {
    return "~/Library/Application Support/Claude/claude_desktop_config.json";
  }
  return "~/.config/Claude/claude_desktop_config.json";
};

export const coworkMeta = (appliedId) => ({
  appliedId,
  entries: [{ id: appliedId, name: "Default" }],
});

/** managedMcpServers: preset plugins, then local bridge entries, then URL-only custom MCPs. */
export const buildCoworkMcpServers = ({ plugins, localServers = [], customPlugins }) => {
  const customEntries = (Array.isArray(customPlugins) ? customPlugins : [])
    .filter((p) => p?.name && p?.url)
    .map((p) => ({ name: p.name, url: p.url, transport: p.transport || "sse", custom: true }));
  return [...buildManagedMcpServers(plugins), ...localServers, ...customEntries];
};

/** The four Cowork files; `null` without models. */
export const buildCoworkConfig = ({
  baseUrl,
  apiKey,
  models,
  managedMcpServers = [],
  appliedId,
  platform,
}) => {
  const names = (models || []).filter((m) => typeof m === "string" && m.trim());
  if (names.length === 0) return null;

  const root = coworkRoot(platform);
  const sep = platform === "win32" ? "\\" : "/";
  const config = {
    ...SECURITY_RELAX,
    inferenceProvider: PROVIDER,
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: apiKey,
    inferenceModels: names.map((name) => ({ name })),
  };
  if (managedMcpServers.length > 0) config.managedMcpServers = managedMcpServers;

  const operonSkipMcpApprovals = {};
  for (const srv of managedMcpServers) {
    if (srv?.name) operonSkipMcpApprovals[srv.name] = true;
  }

  return [
    {
      file: cowork1pConfigFile(platform),
      format: "json",
      merge: true,
      value: { deploymentMode: "3p" },
    },
    {
      file: [root, "configLibrary", "_meta.json"].join(sep),
      format: "json",
      merge: false,
      mode: "create",
      note: "Create the file if it is missing. If it exists, keep its appliedId.",
      value: coworkMeta(appliedId),
    },
    {
      file: [root, "configLibrary", `${appliedId}.json`].join(sep),
      format: "json",
      merge: false,
      value: config,
    },
    {
      file: [root, "config.json"].join(sep),
      format: "json",
      merge: true,
      value: { operonSkipMcpApprovals },
    },
  ];
};
