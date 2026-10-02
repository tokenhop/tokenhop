/**
 * GLM Coding (Z.ai) web search over MCP Streamable HTTP (protocol 2024-11-05):
 * initialize → notifications/initialized → tools/call with Mcp-Session-Id.
 * Responses arrive as SSE (`data: {jsonrpc…}`) or plain JSON. Bad keys come
 * back as HTTP 200 `{code, msg, success:false}`, and tool failures as
 * `result.isError`, so both are mapped to errors carrying `status`.
 */

import { fetchPublic } from "../../../src/shared/utils/ssrfGuard.js";
import { UPSTREAM_CLIENT_IDS } from "../../../src/shared/brand/index.js";

const PROTOCOL_VERSION = "2024-11-05";
const SESSION_TTL_MS = 10 * 60 * 1000;
const AUTH_ERROR_CODES = new Set([401, 1001]);

// `${url}\n${authorization}` → { id, expiresAt }
// ponytail: per-process cache, swept on write; move to a shared store if search goes multi-instance.
const sessions = new Map();

function searchError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Upstream error bodies are often Java stack-frame dumps; keep only a human message.
function summarizeErrorBody(text) {
  try {
    const body = JSON.parse(text);
    const message = body?.message || body?.msg || body?.error?.message || body?.error;
    if (typeof message === "string" && message) return message;
    if (body?.stackTrace) return "upstream error";
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, 200);
}

/** Parse a JSON body, or the first JSON-RPC message carried by an SSE body. */
export function parseMcpBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const event of trimmed.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const message = JSON.parse(data);
    if (message?.result || message?.error) return message;
  }
  return null;
}

async function rpc(url, init, payload) {
  const resp = await fetchPublic(url, { ...init, method: "POST", body: JSON.stringify(payload) });
  const text = await resp.text();
  if (!resp.ok) throw searchError(resp.status, summarizeErrorBody(text));
  if (payload.id === undefined) return { resp };

  const message = parseMcpBody(text);
  if (message?.success === false) {
    throw searchError(
      AUTH_ERROR_CODES.has(message.code) ? 401 : 502,
      message.msg || "upstream error",
    );
  }
  if (message?.error) throw searchError(502, message.error.message || "MCP error");
  if (!message?.result) throw searchError(502, "Empty MCP response");
  return { resp, result: message.result };
}

async function openSession(url, init) {
  const { resp } = await rpc(url, init, {
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: UPSTREAM_CLIENT_IDS.glmMcpClientName, version: "1" },
    },
  });
  const sessionId = resp.headers.get("mcp-session-id");
  if (!sessionId) throw searchError(502, "MCP server returned no session id");
  await rpc(
    url,
    { ...init, headers: { ...init.headers, "Mcp-Session-Id": sessionId } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  );
  return sessionId;
}

function cacheSession(key, id) {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k);
  sessions.set(key, { id, expiresAt: now + SESSION_TTL_MS });
}

/**
 * Run the `tools/call` request built by `buildGlmSearchRequest` inside an MCP session.
 * A cached session is reused; if it fails, the call is retried once on a fresh session.
 * @param {string} url
 * @param {RequestInit} init  headers (incl. Authorization), JSON-RPC body, signal
 * @returns {Promise<{result: object}>} the JSON-RPC message, as `normalizeGlmSearch` expects
 */
export async function runGlmMcpSearch(url, init) {
  const key = `${url}\n${init.headers?.Authorization ?? ""}`;
  const cached = sessions.get(key);
  let sessionId = cached && cached.expiresAt > Date.now() ? cached.id : null;
  const reused = Boolean(sessionId);
  const payload = JSON.parse(init.body);

  for (let attempt = 0; ; attempt++) {
    try {
      if (!sessionId) {
        sessionId = await openSession(url, init);
        cacheSession(key, sessionId);
      }
      const { result } = await rpc(
        url,
        { ...init, headers: { ...init.headers, "Mcp-Session-Id": sessionId } },
        payload,
      );
      if (result.isError) {
        const text = String(result.content?.[0]?.text || "MCP tool error");
        throw searchError(/-401|api ?key/i.test(text) ? 401 : 502, text);
      }
      return { result };
    } catch (err) {
      sessions.delete(key);
      // Only upstream answers (err.status) are retried; aborts and network errors are not.
      if (reused && attempt === 0 && err.status) {
        sessionId = null;
        continue;
      }
      throw err;
    }
  }
}
