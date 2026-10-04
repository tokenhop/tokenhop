const api = require("../api/client");
const { prompt, confirm, pause } = require("../utils/input");
const { clearScreen, showStatus, showHeader } = require("../utils/display");
const { maskKey, formatDate, getRelativeTime } = require("../utils/format");
const { showMenuWithBack } = require("../utils/menuHelper");
const { copyToClipboard } = require("../utils/clipboard");
const { getEndpoint } = require("../utils/endpoint");

/**
 * Display API keys list with formatted output
 * @param {Array} keys - Array of API key objects
 * @param {number} port - Server port
 */
function displayApiKeys(keys, port) {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  🔑 API Keys Management                                 │");
  console.log("├─────────────────────────────────────────────────────────┤");
  // Note: This function is legacy, endpoint shown in menu header instead
  console.log("│                                                          │");

  if (keys.length === 0) {
    console.log("│  No API keys found.                                     │");
  } else {
    console.log(
      `│  Your API Keys (${keys.length}):${" ".repeat(42 - String(keys.length).length)}│`,
    );

    keys.forEach((key, index) => {
      console.log("│                                                          │");
      console.log(
        `│  ${index + 1}. ${key.name}${" ".repeat(52 - String(index + 1).length - key.name.length)}│`,
      );

      const maskedKey = maskKey(key.key);
      console.log(`│     Key: ${maskedKey}${" ".repeat(47 - maskedKey.length)}│`);

      const created = formatDate(key.createdAt);
      console.log(`│     Created: ${created}${" ".repeat(43 - created.length)}│`);

      if (key.lastUsedAt) {
        const lastUsed = getRelativeTime(key.lastUsedAt);
        console.log(`│     Last used: ${lastUsed}${" ".repeat(41 - lastUsed.length)}│`);
      } else {
        console.log("│     Last used: Never                                    │");
      }
    });
  }

  console.log("│                                                          │");
  console.log("│  Actions:                                               │");
  console.log("│  1. Create New API Key                                  │");
  console.log("│  2. View Full Key (by number)                           │");
  console.log("│  3. Copy Key to Clipboard (by number)                   │");
  console.log("│  4. Delete Key (by number)                              │");
  console.log("│  0. ← Back to Main Menu                                 │");
  console.log("└─────────────────────────────────────────────────────────┘");
}

/**
 * Handle creating new API key
 * @returns {Promise<boolean>} Success status
 */
async function handleCreateKey() {
  console.log("\n📝 Create New API Key");
  console.log("─".repeat(30));

  const name = await prompt("Enter key name: ");

  if (!name) {
    showStatus("Key name cannot be empty", "error");
    await pause();
    return false;
  }

  const result = await api.createApiKey(name);

  if (!result.success) {
    showStatus(`Failed to create key: ${result.error}`, "error");
    await pause();
    return false;
  }

  console.log("\n✅ API Key created successfully!");
  console.log("\n⚠️  IMPORTANT: Save this key now. You won't be able to see it again!");
  console.log(`\nKey: ${result.data.key}`);
  console.log(`Name: ${result.data.name}`);
  console.log(`ID: ${result.data.id}`);

  const shouldCopy = await confirm("\nCopy key to clipboard?");
  if (shouldCopy) {
    if (copyToClipboard(result.data.key)) {
      showStatus("Key copied to clipboard!", "success");
    } else {
      showStatus("Failed to copy to clipboard", "error");
    }
  }

  await pause();
  return true;
}

/**
 * Handle viewing full API key
 * @param {Object} key - API key object
 */
async function handleViewFullKey(key) {
  console.log("\n🔍 Full API Key");
  console.log("─".repeat(30));
  console.log(`Name: ${key.name}`);
  console.log(`Key: ${key.key}`);
  console.log(`ID: ${key.id}`);
  console.log(`Created: ${formatDate(key.createdAt)}`);

  if (key.lastUsedAt) {
    console.log(`Last used: ${getRelativeTime(key.lastUsedAt)}`);
  } else {
    console.log("Last used: Never");
  }

  await pause();
}

/**
 * Handle copying API key to clipboard
 * @param {Object} key - API key object
 */
async function handleCopyKey(key) {
  if (copyToClipboard(key.key)) {
    showStatus(`Key "${key.name}" copied to clipboard!`, "success");
  } else {
    showStatus("Failed to copy to clipboard", "error");
  }
  await pause();
}

/**
 * Handle deleting API key
 * @param {Object} key - API key object
 * @returns {Promise<boolean>} Success status
 */
async function handleDeleteKey(key) {
  console.log(`\n⚠️  Delete API Key: ${key.name}`);
  console.log("─".repeat(30));
  console.log(`Key: ${maskKey(key.key)}`);
  console.log(`Created: ${formatDate(key.createdAt)}`);

  const confirmed = await confirm("\nAre you sure you want to delete this key?");

  if (!confirmed) {
    showStatus("Deletion cancelled", "info");
    await pause();
    return false;
  }

  const result = await api.deleteApiKey(key.id);

  if (!result.success) {
    showStatus(`Failed to delete key: ${result.error}`, "error");
    await pause();
    return false;
  }

  showStatus("API key deleted successfully", "success");
  await pause();
  return true;
}

/**
 * Show actions for a specific key
 * @param {Object} key - API key object
 * @param {number} port - Server port
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showKeyActions(key, port, breadcrumb = []) {
  const { endpoint } = await getEndpoint(port);
  await showMenuWithBack({
    title: `🔑 ${key.name}`,
    breadcrumb: [...breadcrumb, key.name],
    headerContent: `Name: ${key.name}\nKey: ${key.key}\nEndpoint: ${endpoint}`,
    items: [
      {
        label: "Copy to Clipboard",
        action: async () => {
          await handleCopyKey(key);
          return true;
        },
      },
      {
        label: "Delete Key",
        action: async () => {
          await handleDeleteKey(key);
          return false; // Exit after delete
        },
      },
    ],
  });
}

/**
 * Resolve the keys menu mode from a validated /api/keys/context response.
 * @param {Object} context - Parsed context data ({ storage, ... })
 * @returns {string} "hashed" or "legacy"
 */
function resolveKeysMode(context) {
  return context?.storage === "hashed" ? "hashed" : "legacy";
}

/**
 * Format a hashed-storage key metadata item: name, type, server-side prefix.
 * Never receives or renders raw key material.
 * @param {Object} key - Key metadata from GET /api/keys (hashed)
 * @returns {string} Menu label
 */
function formatHashedKeyItem(key) {
  const type = key.type === "service" ? "service" : "user";
  const status = key.revokedAt ? " (revoked)" : key.isActive === false ? " (inactive)" : "";
  const name = key.name || "(unnamed)";
  return `${name} [${type}] ${key.prefix || "***"}${status}`;
}

/**
 * Create a key under hashed storage. Only explicit user action reaches this
 * handler. Raw key material lives in this frame only — printed once, offered
 * for one clipboard copy, never persisted or logged elsewhere.
 * @param {string} workspaceId - Workspace id from the context response
 * @param {boolean} allowService - Whether a service key may be offered
 * @returns {Promise<boolean>} Success status
 */
async function handleCreateHashedKey(workspaceId, allowService) {
  console.log("\n📝 Create New API Key");
  console.log("─".repeat(30));

  const name = (await prompt("Enter key name: ")) || "";

  if (!name.trim()) {
    showStatus("Key name cannot be empty", "error");
    await pause();
    return false;
  }

  let type = "user";
  if (allowService) {
    const service = await confirm("Create a shared service key? (No = personal key)");
    type = service ? "service" : "user";
  }

  const result = await api.createApiKey(name, { workspaceId, type });

  if (!result.success) {
    showStatus(`Failed to create key: ${result.error}`, "error");
    await pause();
    return false;
  }

  console.log("\n✅ API Key created successfully!");
  console.log(`Type: ${result.data.metadata?.type || type}`);
  console.log(`Name: ${result.data.name || result.data.metadata?.name || name.trim()}`);
  console.log(`ID: ${result.data.id || result.data.metadata?.id}`);

  // Secret is shown exactly once, then dropped from memory.
  console.log("\n⚠️  IMPORTANT: Save this key now. You won't be able to see it again!");
  let secret = result.data.key;
  console.log(`\nKey: ${secret}`);

  const shouldCopy = await confirm("\nCopy key to clipboard?");
  if (shouldCopy) {
    if (copyToClipboard(secret)) {
      showStatus("Key copied to clipboard!", "success");
    } else {
      showStatus("Failed to copy to clipboard", "error");
    }
  }

  secret = null;
  result.data.key = undefined;

  await pause();
  return true;
}

/**
 * Delete a key under hashed storage (manager action).
 * @param {Object} metadata - Key metadata from the hashed list
 * @param {string} workspaceId - Workspace id from the context response
 * @returns {Promise<boolean>} Success status
 */
async function handleDeleteHashedKey(metadata, workspaceId) {
  console.log(`\n⚠️  Delete API Key: ${metadata.name || metadata.id}`);
  console.log("─".repeat(30));
  console.log(`Type: ${metadata.type === "service" ? "service" : "user"}`);
  console.log(`Prefix: ${metadata.prefix || "***"}`);
  console.log(`Created: ${formatDate(metadata.createdAt)}`);

  const confirmed = await confirm("\nAre you sure you want to delete this key?");

  if (!confirmed) {
    showStatus("Deletion cancelled", "info");
    await pause();
    return false;
  }

  const result = await api.deleteApiKey(metadata.id, workspaceId);

  if (!result.success) {
    showStatus(`Failed to delete key: ${result.error}`, "error");
    await pause();
    return false;
  }

  showStatus("API key deleted successfully", "success");
  await pause();
  return true;
}

/**
 * Per-key actions under hashed storage. Metadata only: no raw key, no copy,
 * no reveal — hashed storage never returns the raw key to any reader.
 * @param {Object} metadata - Key metadata from the hashed list
 * @param {string} workspaceId - Workspace id from the context response
 * @param {number} port - Server port
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showHashedKeyActions(metadata, workspaceId, port, breadcrumb = []) {
  const { endpoint } = await getEndpoint(port);
  await showMenuWithBack({
    title: `🔑 ${metadata.name || metadata.id}`,
    breadcrumb: [...breadcrumb, metadata.name || metadata.id],
    headerContent: `Name: ${metadata.name || "(unnamed)"}\nType: ${
      metadata.type === "service" ? "service" : "user"
    }\nPrefix: ${metadata.prefix || "***"}\nEndpoint: ${endpoint}`,
    items: [
      {
        label: "Delete Key",
        action: async () => {
          await handleDeleteHashedKey(metadata, workspaceId);
          return false; // Exit after delete
        },
      },
    ],
  });
}

/**
 * Hashed-storage keys menu. Managers get the metadata list (prefix only);
 * members get personal-key creation only — listing is manager-only.
 * @param {Object} context - Validated /api/keys/context data
 * @param {number} port - Server port
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showHashedKeysMenu(context, port, breadcrumb = []) {
  const workspaceId = context.workspaceId;

  if (!context.canManage && !context.canCreate) {
    clearScreen();
    showStatus("You do not have permission to manage API keys here", "error");
    await pause();
    return;
  }

  if (!context.canManage) {
    const { endpoint } = await getEndpoint(port);
    await showMenuWithBack({
      title: "🔑 API Keys",
      breadcrumb,
      headerContent: `Endpoint: ${endpoint}\nListing keys requires a manager role. You can create a personal key.`,
      items: [
        {
          label: "Create Personal API Key",
          action: async () => {
            await handleCreateHashedKey(workspaceId, false);
          },
        },
      ],
    });
    return;
  }

  const { showListMenu } = require("../utils/menuHelper");
  const { endpoint } = await getEndpoint(port);
  await showListMenu({
    title: "🔑 API Keys Management",
    breadcrumb,
    headerContent: `Endpoint: ${endpoint}\nHashed storage — keys are shown by prefix only.`,
    fetchItems: async () => {
      const result = await api.getApiKeys(workspaceId);
      if (!result.success || result.data.storage !== "hashed") {
        clearScreen();
        showStatus(`Failed to fetch API keys: ${result.error || "unexpected response"}`, "error");
        await pause();
        return null;
      }
      return { items: result.data.keys || [] };
    },
    formatItem: formatHashedKeyItem,
    onSelect: async (metadata) => {
      await showHashedKeyActions(metadata, workspaceId, port, breadcrumb);
    },
    createAction: context.canCreate
      ? {
          label: "Create New API Key",
          action: async () => {
            await handleCreateHashedKey(workspaceId, context.canCreateService);
          },
        }
      : null,
  });
}

/**
 * Legacy (pre-hashed) menu — byte-for-byte the original flow.
 * @param {number} port - Server port number
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showLegacyKeysMenu(port, breadcrumb = []) {
  const { showListMenu } = require("../utils/menuHelper");

  const { endpoint } = await getEndpoint(port);
  await showListMenu({
    title: "🔑 API Keys Management",
    breadcrumb,
    headerContent: `Endpoint: ${endpoint}`,
    fetchItems: async () => {
      const result = await api.getApiKeys();
      if (!result.success) {
        clearScreen();
        showStatus(`Failed to fetch API keys: ${result.error}`, "error");
        await pause();
        return null;
      }
      return { items: result.data.keys || [] };
    },
    formatItem: (key) => `${key.name} (${maskKey(key.key)})`,
    onSelect: async (key) => {
      await showKeyActions(key, port, breadcrumb);
    },
    createAction: {
      label: "Create New API Key",
      action: async () => {
        await handleCreateKey();
      },
    },
  });
}

/**
 * Main API Keys menu — dispatches on the authenticated /api/keys/context.
 * Arbitrary context failures surface as errors; they never downgrade to the
 * legacy menu (client-side legacy confirmation happens in the client).
 * @param {number} port - Server port number
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showApiKeysMenu(port, breadcrumb = []) {
  const context = await api.getApiKeysContext();

  if (!context.success) {
    clearScreen();
    showStatus(`Failed to fetch key context: ${context.error}`, "error");
    await pause();
    return;
  }

  if (resolveKeysMode(context.data) === "hashed") {
    await showHashedKeysMenu(context.data, port, breadcrumb);
    return;
  }
  await showLegacyKeysMenu(port, breadcrumb);
}

module.exports = {
  showApiKeysMenu,
  // Test surface for unit tests; not used by the CLI runtime paths.
  __test__: { resolveKeysMode, formatHashedKeyItem, handleCreateHashedKey },
};
