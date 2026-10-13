const api = require("./api/client");
const workspace = require("./api/workspaceSelection");
const { selectMenu } = require("./utils/input");
const { showProvidersMenu } = require("./menus/providers");
const { showApiKeysMenu } = require("./menus/apiKeys");
const { showCombosMenu } = require("./menus/combos");
const { showSettingsMenu } = require("./menus/settings");
const { showCliToolsMenu } = require("./menus/cliTools");
const { showUsersWorkspacesMenu, pickWorkspace } = require("./menus/usersWorkspaces");
const { requireShared } = require("./utils/requireShared");

const { ACTIVE } = requireShared("brand");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

// Cached header (SWR): show last value instantly, refresh in background.
let cachedHeader = "";
let fetchingHeader = false;

function renderHeader(port, keys, tunnel) {
  const tunnelEnabled = tunnel && tunnel.enabled === true;
  const lines = [];
  if (tunnelEnabled && tunnel.publicUrl) {
    lines.push(`Endpoint: ${COLORS.green}${tunnel.publicUrl}/v1${COLORS.reset}`);
    lines.push(
      `Tunnel:   ${COLORS.green}ON${COLORS.reset} ${COLORS.dim}(${tunnel.shortId})${COLORS.reset}`,
    );
  } else {
    lines.push(`Endpoint: http://localhost:${port}/v1`);
    lines.push(
      `Tunnel:   ${COLORS.red}OFF${COLORS.reset} ${COLORS.dim}(local only)${COLORS.reset}`,
    );
  }
  const selected = workspace
    .getWorkspaceChoices()
    .find((w) => w.id === workspace.getSelectedWorkspaceId());
  if (selected) lines.push(`Workspace: ${selected.name || selected.id}`);
  if (!keys || keys.length === 0) {
    lines.push(`Key:      ${COLORS.dim}No API keys yet${COLORS.reset}`);
  } else {
    lines.push(`Key:      ${COLORS.cyan}${keys[0].key}${COLORS.reset}`);
    keys.slice(1).forEach((k) => {
      lines.push(`          ${COLORS.cyan}${k.key}${COLORS.reset}`);
    });
  }
  return lines.join("\n");
}

async function refreshHeaderBg(port) {
  if (fetchingHeader) return;
  fetchingHeader = true;
  try {
    const [keysResult, tunnelResult] = await Promise.all([api.getApiKeys(), api.getTunnelStatus()]);
    const keys = keysResult.success ? keysResult.data.keys || [] : [];
    const tunnel = tunnelResult.success ? tunnelResult.data || {} : {};
    cachedHeader = renderHeader(port, keys, tunnel);
  } finally {
    fetchingHeader = false;
  }
}

/**
 * Start Terminal UI
 * @param {number} port - Server port number
 */
async function startTerminalUI(port) {
  // Configure API client
  api.configure({ port });

  const basePath = [ACTIVE.name];

  // Multi-user state is reloaded on every main-menu entry: a switch
  // change or server restart while the TUI runs takes effect on return here.
  // Off/unavailable clears the selection (see workspaceSelection) and the
  // menu below is exactly the legacy one.
  while (true) {
    const multiUser = Boolean(await workspace.loadMultiUserState());
    // Fresh header so a dropped/changed workspace line never lingers.
    await refreshHeaderBg(port);

    const items = [
      {
        label: "Providers",
        action: async () => {
          await showProvidersMenu([...basePath, "Providers"]);
        },
      },
      {
        label: "API Keys",
        action: async () => {
          await showApiKeysMenu(port, [...basePath, "API Keys"]);
        },
      },
      {
        label: "Combos",
        action: async () => {
          await showCombosMenu([...basePath, "Combos"]);
        },
      },
      {
        label: "CLI Tools",
        action: async () => {
          await showCliToolsMenu(port, [...basePath, "CLI Tools"]);
        },
      },
      ...(multiUser
        ? [
            {
              label: () => {
                const current = workspace
                  .getWorkspaceChoices()
                  .find((w) => w.id === workspace.getSelectedWorkspaceId());
                return `Workspace: ${current?.name || current?.id || "none"} (change)`;
              },
              action: async () => {
                await pickWorkspace([...basePath, "Workspace"]);
                await refreshHeaderBg(port);
              },
            },
            {
              label: "Users & workspaces",
              action: async () => {
                await showUsersWorkspacesMenu(port, [...basePath, "Users & workspaces"]);
              },
            },
          ]
        : []),
      {
        label: "Settings",
        action: async () => {
          await showSettingsMenu([...basePath, "Settings"]);
        },
      },
    ];

    // Same rendering contract as showMenuWithBack (back first, icons, ESC).
    const menuItems = [
      { label: "← Back to Interface Menu", icon: "☆" },
      ...items.map((item) => ({
        label: typeof item.label === "function" ? item.label() : item.label,
        icon: "☆",
      })),
    ];
    const selected = await selectMenu(
      `📡 ${ACTIVE.name} Terminal UI`,
      menuItems,
      0,
      "",
      // Freshly refreshed above; no background re-fetch kick.
      cachedHeader ||
        `Endpoint: http://localhost:${port}/v1\nTunnel:   ${COLORS.dim}...${COLORS.reset}\nKey:      ${COLORS.dim}...${COLORS.reset}`,
      basePath,
    );
    if (selected === -1 || selected === 0) return;
    const item = items[selected - 1];
    if (item?.action) await item.action();
  }
}

module.exports = { startTerminalUI };
