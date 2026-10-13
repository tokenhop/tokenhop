// Check if running in Node.js environment (has fs module)
import { normalizeSecrets, redactDeep, redactText, sanitizeUrl } from "./redact.js";

const isNode =
  typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// YAN-312: env var wins when set; otherwise the stored requestLogsEnabled
// setting applies. Synchronous DB reads are unavailable in open-sse, so the
// resolved value is cached per process and refreshed by notifyRequestLogsEnabled().
const ENV_RAW = typeof process !== "undefined" ? process.env?.ENABLE_REQUEST_LOGS : undefined;
const ENV_OVERRIDE = typeof ENV_RAW === "string" ? ENV_RAW.toLowerCase() === "true" : null;

let settingsEnabled = false;

function isLoggingEnabled() {
  if (!isNode) return false;
  if (ENV_OVERRIDE !== null) return ENV_OVERRIDE;
  return settingsEnabled;
}

/**
 * Refresh the stored-setting fallback for request logging.
 * Called by the settings API after PATCH requestLogsEnabled; the env var
 * always wins when set. No-op on non-Node runtimes.
 * @param {boolean} value Stored requestLogsEnabled value.
 */
export function notifyRequestLogsEnabled(value) {
  if (typeof value === "boolean") settingsEnabled = value;
}

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !isLoggingEnabled() || fs) return;
  try {
    fs = await import("node:fs");
    path = await import("node:path");
    LOGS_DIR = path.join(
      typeof process !== "undefined" && process.cwd ? process.cwd() : ".",
      "logs",
    );
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);

    fs.mkdirSync(sessionPath, { recursive: true });

    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", redactText(err.message));
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;

  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, redactText(err.message));
  }
}

// Mask credential headers before writing request logs (YAN-650).
// Case-insensitive: exact names plus any header containing "token",
// "secret" or "api-key". Long values keep a short prefix/suffix for
// debuggability; short values are fully masked. Never mutates the input.
const SENSITIVE_EXACT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
  "chatgpt-account-id",
]);

function isSensitiveHeader(name) {
  const lower = name.toLowerCase();
  if (SENSITIVE_EXACT_HEADERS.has(lower)) return true;
  return (
    lower.includes("token") ||
    lower.includes("authorization") ||
    lower.includes("cookie") ||
    lower.includes("secret") ||
    lower.includes("api-key") ||
    lower.endsWith("-key") || // e.g. qoder X-Model-Key
    lower.includes("signature") // e.g. x-iflow-signature
  );
}

// Reveal 4+4 chars only when the value is long enough (>= 24) that the
// visible fragment stays under a third of the secret; otherwise "***".
function maskHeaderValue(value) {
  if (Array.isArray(value)) return value.map(maskHeaderValue);
  const s = typeof value === "string" ? value : String(value ?? "");
  if (s.length < 24) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

const URL_HEADERS = new Set(["referer", "origin", "location", "content-location"]);

function scrubHeaderValue(name, value, secrets) {
  if (Array.isArray(value)) return value.map((v) => scrubHeaderValue(name, v, secrets));
  if (typeof value !== "string") return value;
  return URL_HEADERS.has(name.toLowerCase())
    ? sanitizeUrl(value, secrets)
    : redactText(value, secrets);
}

export function maskSensitiveHeaders(headers, secrets) {
  if (!headers) return {};
  const source =
    typeof headers.entries === "function" ? Object.fromEntries(headers.entries()) : headers;
  const masked = {};
  for (const key of Object.keys(source)) {
    masked[key] = isSensitiveHeader(key)
      ? maskHeaderValue(source[key])
      : scrubHeaderValue(key, source[key], secrets);
  }
  return masked;
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {},
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model, options = {}) {
  // Return no-op logger if logging is disabled
  if (!isLoggingEnabled()) {
    return createNoOpLogger();
  }

  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
  // Request-local known-secret provenance (YAN-378): opaque upstream keys can
  // echo through errors/chunks with no recognisable shape. Accept a live
  // getter so credentials refreshed AFTER logger creation stay covered.
  // Never query the DB here; callers pass the CURRENT request's credentials only.
  const getSecrets = () =>
    Array.isArray(options?.secrets)
      ? normalizeSecrets(options.secrets)
      : normalizeSecrets(options.secrets?.());
  const deep = (v) => redactDeep(v, { secrets: getSecrets() });
  const text = (v) => (typeof v === "string" ? redactText(v, getSecrets()) : v);

  const logger = {
    get sessionPath() {
      return sessionPath;
    },

    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint: sanitizeUrl(endpoint, getSecrets()),
        headers: maskSensitiveHeaders(headers, getSecrets()),
        body: deep(body),
      });
    },

    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers, getSecrets()),
        body: deep(body),
      });
    },

    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body: deep(body),
      });
    },

    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url: sanitizeUrl(url, getSecrets()),
        headers: maskSensitiveHeaders(headers, getSecrets()),
        body: deep(body),
      });
    },

    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      const rawHeaders = headers
        ? typeof headers.entries === "function"
          ? Object.fromEntries(headers.entries())
          : headers
        : {};
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText: text(statusText),
        headers: maskSensitiveHeaders(rawHeaders, getSecrets()),
        body: deep(body),
      });
    },

    // 5. Append streaming chunk to provider response
    appendProviderChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "5_res_provider.txt");
        fs.appendFileSync(filePath, text(chunk));
      } catch {
        // Ignore append errors
      }
    },

    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "6_res_openai.txt");
        fs.appendFileSync(filePath, text(chunk));
      } catch {
        // Ignore append errors
      }
    },

    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body: deep(body),
      });
    },

    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "7_res_client.txt");
        fs.appendFileSync(filePath, text(chunk));
      } catch {
        // Ignore append errors
      }
    },

    // 6. Log error
    logError(error, requestBody = null) {
      writeJsonFile(sessionPath, "6_error.json", {
        timestamp: new Date().toISOString(),
        error: text(error?.message || String(error)),
        stack: text(error?.stack),
        requestBody: deep(requestBody),
      });
    },
  };
  // Diagnostics must never fail a request, including hostile getters/headers.
  for (const [key, method] of Object.entries(logger)) {
    if (typeof method !== "function") continue;
    logger[key] = (...args) => {
      try {
        return method(...args);
      } catch {
        // Drop unsafe diagnostic input rather than writing it raw.
      }
    };
  }
  return logger;
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url: sanitizeUrl(url),
      error: redactText(error?.message || String(error)),
      stack: redactText(error?.stack),
      requestBody: redactDeep(requestBody),
    };

    fs.appendFileSync(logPath, `${JSON.stringify(logEntry)}\n`);
  } catch (err) {
    console.log("[LOG] Failed to write error log:", redactText(err.message));
  }
}
