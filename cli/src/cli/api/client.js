const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const { machineIdSync } = require("node-machine-id");
const { getDataDir } = require("../../../hooks/sqliteRuntime");

// Default configuration
const DEFAULT_CONFIG = {
  host: "localhost",
  port: 20128,
  protocol: "http:",
};

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

const MACHINE_ID_FILE = path.join(getDataDir(), "machine-id");
const AUTH_DIR = path.join(getDataDir(), "auth");
const CLI_SECRET_FILE = path.join(AUTH_DIR, "cli-secret");

let config = { ...DEFAULT_CONFIG };
let cachedCliToken = null;
let cachedCliSecret = null;

// Read raw machineId from shared file (written by server) → guarantees token match
function loadRawMachineId() {
  try {
    const raw = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (raw) return raw;
  } catch {}
  try {
    return machineIdSync();
  } catch {
    return "";
  }
}

// Random secret shared with server via file → token unpredictable from machineId alone.
function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  cachedCliSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch {}
  return cachedCliSecret;
}

function getCliToken() {
  if (cachedCliToken !== null) return cachedCliToken;
  const raw = loadRawMachineId();
  const secret = loadCliSecret();
  cachedCliToken = raw
    ? crypto
        .createHash("sha256")
        .update(raw + CLI_TOKEN_SALT + secret)
        .digest("hex")
        .substring(0, 16)
    : "";
  return cachedCliToken;
}

/**
 * Configure API client
 * @param {Object} options - Configuration options
 * @param {string} options.host - API host
 * @param {number} options.port - API port
 * @param {string} options.protocol - Protocol (http: or https:)
 */
function configure(options = {}) {
  config = { ...config, ...options };
}

/**
 * Make HTTP request to API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {Object} body - Request body (optional)
 * @returns {Promise<Object>} Response with { success, data/error }
 */
function makeRequest(method, path, body = null) {
  return new Promise((resolve) => {
    const httpModule = config.protocol === "https:" ? https : http;

    const options = {
      hostname: config.host,
      port: config.port,
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json",
        [CLI_TOKEN_HEADER]: getCliToken(),
      },
    };

    // Add Content-Length for POST/PUT requests
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      const bodyString = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(bodyString);
    }

    const req = httpModule.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};

          // Check if response indicates error
          if (res.statusCode >= 400 || parsed.error) {
            resolve({
              success: false,
              error: parsed.error || `HTTP ${res.statusCode}`,
              statusCode: res.statusCode,
            });
          } else {
            resolve({
              success: true,
              data: parsed,
              statusCode: res.statusCode,
            });
          }
        } catch (err) {
          resolve({
            success: false,
            error: `Failed to parse response: ${err.message}`,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({
        success: false,
        error: `Network error: ${err.message}`,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        success: false,
        error: "Request timeout",
      });
    });

    // Set timeout (30 seconds)
    req.setTimeout(30000);

    // Write body if present
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// ============================================================================
// PROVIDERS API
// ============================================================================

/**
 * Get all providers
 * @returns {Promise<Object>} { success, data: { connections } }
 */
async function getProviders() {
  return makeRequest("GET", "/api/providers");
}

/**
 * Get provider by ID
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function getProviderById(id) {
  return makeRequest("GET", `/api/providers/${id}`);
}

/**
 * Test provider connection
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { valid, error } }
 */
async function testProvider(id) {
  return makeRequest("POST", `/api/providers/${id}/test`);
}

/**
 * Delete provider
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { message } }
 */
async function deleteProvider(id) {
  return makeRequest("DELETE", `/api/providers/${id}`);
}

/**
 * Get provider models
 * @param {string} id - Provider ID
 * @returns {Promise<Object>} { success, data: { provider, connectionId, models } }
 */
async function getProviderModels(id) {
  return makeRequest("GET", `/api/providers/${id}/models`);
}

// ============================================================================
// OAUTH API
// ============================================================================

/**
 * Get OAuth authorization URL
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { authUrl, codeVerifier, state, redirectUri } }
 */
async function getOAuthAuthUrl(provider) {
  // Codex requires fixed port 1455 and path /auth/callback
  const redirectUri =
    provider === "codex"
      ? "http://localhost:1455/auth/callback"
      : "http://localhost:20128/callback";
  return makeRequest(
    "GET",
    `/api/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
}

/**
 * Exchange OAuth authorization code for token
 * @param {string} provider - Provider ID
 * @param {Object} data - { code, redirectUri, codeVerifier, state }
 * @returns {Promise<Object>} { success, data }
 */
async function exchangeOAuthCode(provider, data) {
  return makeRequest("POST", `/api/oauth/${provider}/exchange`, data);
}

/**
 * Get OAuth device code
 * @param {string} provider - Provider ID
 * @returns {Promise<Object>} { success, data: { device_code, user_code, verification_uri, verification_uri_complete, codeVerifier, extraData } }
 */
async function getOAuthDeviceCode(provider) {
  return makeRequest("GET", `/api/oauth/${provider}/device-code`);
}

/**
 * Poll OAuth token using device code
 * @param {string} provider - Provider ID
 * @param {Object} data - { deviceCode, codeVerifier, extraData }
 * @returns {Promise<Object>} { success, data: { pending } }
 */
async function pollOAuthToken(provider, data) {
  return makeRequest("POST", `/api/oauth/${provider}/poll`, data);
}

/**
 * Create API key provider connection
 * @param {Object} data - { provider, name, apiKey }
 * @returns {Promise<Object>} { success, data }
 */
async function createApiKeyProvider(data) {
  return makeRequest("POST", "/api/providers", data);
}

/**
 * Update provider connection
 * @param {string} id - Connection ID
 * @param {Object} data - { name, priority, defaultModel, isActive }
 * @returns {Promise<Object>} { success, data: { connection } }
 */
async function updateConnection(id, data) {
  return makeRequest("PUT", `/api/providers/${id}`, data);
}

// ============================================================================
// API KEYS API
// ============================================================================

/**
 * Encode an optional workspaceId query for hashed-storage management routes.
 * No workspaceId → path unchanged (pristine legacy request).
 */
function withWorkspace(path, workspaceId) {
  return workspaceId === undefined
    ? path
    : `${path}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

/**
 * Get the authenticated key-management context: storage mode, workspace and
 * capabilities. Existing CLI token transport (makeRequest) reused as-is.
 *
 * Context 401 ordinarily means the ordinary off-legacy install with no
 * principal; there and only there the menu may keep legacy behavior — but
 * only after the legacy collection itself confirms the pristine envelope
 * (no `storage` field, `keys[]` each carrying raw `key`).
 * @returns {Promise<Object>} { success, data: context|{storage:'legacy'} }
 */
async function getApiKeysContext() {
  const result = await makeRequest("GET", "/api/keys/context");
  if (!result.success) {
    // Ordinary users-off legacy installs have no principal for context.
    // Only a confirmed legacy collection permits this narrow fallback.
    if (result.statusCode !== 401) return result;
    const legacy = await getApiKeys();
    if (
      legacy.success &&
      legacy.data.storage === undefined &&
      Array.isArray(legacy.data.keys) &&
      legacy.data.keys.every((key) => typeof key.key === "string")
    ) {
      return { success: true, data: { storage: "legacy" } };
    }
    return result;
  }
  const ctx = result.data;
  if (
    !["legacy", "hashed"].includes(ctx.storage) ||
    typeof ctx.workspaceId !== "string" ||
    !ctx.workspaceId.trim() ||
    [ctx.canCreate, ctx.canManage, ctx.canCreateService].some((value) => typeof value !== "boolean")
  ) {
    return { success: false, error: "Invalid key context" };
  }
  return result;
}

/**
 * Get all API keys — pristine legacy shape `getApiKeys()`.
 * Hashed storage threads the context workspaceId: `getApiKeys(workspaceId)`.
 */
async function getApiKeys(workspaceId) {
  return makeRequest("GET", withWorkspace("/api/keys", workspaceId));
}

async function getApiKeyById(id, workspaceId) {
  if (!id) return { success: false, error: "Key ID is required" };
  return makeRequest("GET", withWorkspace(`/api/keys/${id}`, workspaceId));
}

/**
 * Create new API key — pristine legacy shape `createApiKey(name)`.
 * Hashed storage: `createApiKey(name, { workspaceId, type })`; only `type`
 * and the trimmed name are sent.
 */
async function createApiKey(name, options) {
  if (options === undefined) return makeRequest("POST", "/api/keys", { name });
  const { workspaceId, type = "user" } = options;
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    return { success: false, error: "Workspace ID is required" };
  }
  if (type !== "user" && type !== "service") {
    return { success: false, error: "Invalid key type" };
  }
  if (typeof name !== "string" || !name.trim()) {
    return { success: false, error: "Invalid key name" };
  }
  return makeRequest("POST", withWorkspace("/api/keys", workspaceId), { type, name: name.trim() });
}

/**
 * Delete API key — pristine legacy shape `deleteApiKey(id)`.
 * Second arg workspaceId threads the hashed query param with no body.
 */
async function deleteApiKey(id, workspaceId) {
  if (!id) return { success: false, error: "Key ID is required" };
  return makeRequest("DELETE", withWorkspace(`/api/keys/${id}`, workspaceId));
}

// ============================================================================
// COMBOS API
// ============================================================================

/**
 * Get all combos
 * @returns {Promise<Object>} { success, data: { combos } }
 */
async function getCombos() {
  return makeRequest("GET", "/api/combos");
}

/**
 * Get combo by ID
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: combo }
 */
async function getComboById(id) {
  return makeRequest("GET", `/api/combos/${id}`);
}

/**
 * Create new combo
 * @param {Object} data - Combo data { name, models }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function createCombo(data) {
  return makeRequest("POST", "/api/combos", data);
}

/**
 * Update combo
 * @param {string} id - Combo ID
 * @param {Object} data - Update data { name?, models? }
 * @returns {Promise<Object>} { success, data: combo }
 */
async function updateCombo(id, data) {
  return makeRequest("PUT", `/api/combos/${id}`, data);
}

/**
 * Delete combo
 * @param {string} id - Combo ID
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function deleteCombo(id) {
  return makeRequest("DELETE", `/api/combos/${id}`);
}

// ============================================================================
// CLI TOOLS API
// ============================================================================

/**
 * Get CLI tool settings
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @returns {Promise<Object>} { success, data: { installed, hasTokenhop, ... } }
 */
async function getCliToolSettings(tool) {
  return makeRequest("GET", `/api/cli-tools/${tool}-settings`);
}

/**
 * Apply CLI tool settings (POST)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @param {Object} body - Payload depends on tool
 * @returns {Promise<Object>} { success, data }
 */
async function applyCliToolSettings(tool, body) {
  return makeRequest("POST", `/api/cli-tools/${tool}-settings`, body);
}

/**
 * Reset CLI tool settings (DELETE)
 * @param {string} tool - Tool name: claude | codex | droid | openclaw
 * @returns {Promise<Object>} { success, data }
 */
async function resetCliToolSettings(tool) {
  return makeRequest("DELETE", `/api/cli-tools/${tool}-settings`);
}

// ============================================================================
// SETTINGS API
// ============================================================================

/**
 * Get settings
 * @returns {Promise<Object>} { success, data: settings }
 */
async function getSettings() {
  return makeRequest("GET", "/api/settings");
}

/**
 * Update settings
 * @param {Object} data - Settings data
 * @returns {Promise<Object>} { success, data: settings }
 */
async function updateSettings(data) {
  return makeRequest("PATCH", "/api/settings", data);
}

/**
 * Reset dashboard password to default (clears stored hash server-side)
 * @returns {Promise<Object>} { success }
 */
async function resetPassword() {
  return makeRequest("POST", "/api/auth/reset-password");
}

/**
 * Mint a one-time owner setup token (ADR-0003, multi-user owner SSO linking).
 * Server responds 404 while users & teams is off.
 * @returns {Promise<Object>} { success, data: { token, expiresAt }, statusCode }
 */
async function mintSetupToken() {
  return makeRequest("POST", "/api/auth/setup-token");
}

// ============================================================================
// MODELS API
// ============================================================================

/**
 * Get all models (internal API)
 * @returns {Promise<Object>} { success, data: { models } }
 */
async function getModels() {
  return makeRequest("GET", "/api/models");
}

/**
 * Get available models from active providers + combos (OpenAI compatible)
 * @returns {Promise<Object>} { success, data: { object, data: [...models] } }
 */
async function getAvailableModels() {
  return makeRequest("GET", "/v1/models");
}

// ============================================================================
// PROVIDER NODES API (custom providers)
// ============================================================================

async function getProviderNodes() {
  return makeRequest("GET", "/api/provider-nodes");
}

async function createProviderNode(data) {
  return makeRequest("POST", "/api/provider-nodes", data);
}

async function updateProviderNode(id, data) {
  return makeRequest("PUT", `/api/provider-nodes/${id}`, data);
}

async function deleteProviderNode(id) {
  return makeRequest("DELETE", `/api/provider-nodes/${id}`);
}

async function validateProviderNode(data) {
  return makeRequest("POST", "/api/provider-nodes/validate", data);
}

// ============================================================================
// TUNNEL API
// ============================================================================

/**
 * Get tunnel status
 * @returns {Promise<Object>} { success, data: { enabled, tunnelUrl, shortId, running } }
 */
async function getTunnelStatus() {
  return makeRequest("GET", "/api/tunnel/status");
}

/**
 * Enable tunnel
 * @returns {Promise<Object>} { success, data: { tunnelUrl, shortId } }
 */
async function enableTunnel() {
  return makeRequest("POST", "/api/tunnel/enable");
}

/**
 * Disable tunnel
 * @returns {Promise<Object>} { success, data: { success } }
 */
async function disableTunnel() {
  return makeRequest("POST", "/api/tunnel/disable");
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  configure,

  // Providers
  getProviders,
  getProviderById,
  testProvider,
  deleteProvider,
  getProviderModels,

  // Connection aliases
  testConnection: testProvider,
  deleteConnection: deleteProvider,
  updateConnection,

  // OAuth
  getOAuthAuthUrl,
  exchangeOAuthCode,
  getOAuthDeviceCode,
  pollOAuthToken,
  createApiKeyProvider,

  // API Keys
  getApiKeysContext,
  getApiKeys,
  getApiKeyById,
  createApiKey,
  deleteApiKey,

  // Combos
  getCombos,
  getComboById,
  createCombo,
  updateCombo,
  deleteCombo,

  // CLI Tools
  getCliToolSettings,
  applyCliToolSettings,
  resetCliToolSettings,

  // Settings
  getSettings,
  updateSettings,
  resetPassword,
  mintSetupToken,

  // Tunnel
  getTunnelStatus,
  enableTunnel,
  disableTunnel,

  // Models
  getModels,
  getAvailableModels,

  // Provider Nodes (custom providers)
  getProviderNodes,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,
  validateProviderNode,
};
