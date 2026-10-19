import http from "http";
import { URL } from "url";
import { CODEX_CONFIG } from "../../constants/oauth.js";
import {
  createSessionConnection,
  alreadyHandledPage,
  anyLiveBoundSession,
  clearPendingFor,
  listenerStillNeeded,
  renderCodexResultPage,
  stateConflict,
  sweepExpiredSessions,
  unknownLoginPage,
} from "./shared.js";

// Singleton proxy server for Codex OAuth callback on fixed port
let codexProxyServer = null;
let codexProxyTimeout = null;

const CODEX_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({ state, codeVerifier, redirectUri, binding }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  sweepExpiredSessions(pendingExchanges);
  if (stateConflict(pendingExchanges, state, binding)) return false;
  pendingExchanges.set(state, {
    state,
    codeVerifier,
    redirectUri,
    binding,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state) {
  pendingExchanges.delete(state);
}

export function codexLiveSessions() {
  return [...pendingExchanges.values()];
}

/** Drop this user's still-pending sessions (stop-proxy by that user). */
export function clearCodexSessionsFor(userId) {
  return clearPendingFor(pendingExchanges, userId);
}

/**
 * Stop the listener unless another live login still needs it (see listenerStillNeeded).
 * With the multi-user switch off no session is bound, so this always stops.
 * @returns {boolean} true when the listener was stopped
 */
export function releaseCodexListener(exceptState) {
  if (listenerStillNeeded(pendingExchanges.values(), exceptState)) return false;
  stopCodexProxy();
  return true;
}

const html = { "Content-Type": "text/html; charset=utf-8" };

/**
 * Handle one /callback hit. Pure of sockets so it is unit-testable.
 * @returns {Promise<{status:number, headers:object, body:string, released:boolean}>}
 */
export async function handleCodexCallback(url, appPort) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const session = state ? pendingExchanges.get(state) : null;

  // Mode A: server-side exchange (session registered)
  if (session) {
    // A repeated/concurrent hit for the same state must not re-run the exchange
    // or flip a finished session to error. Claim it synchronously, before any await.
    if (session.status !== "pending") {
      return { status: 200, headers: html, body: alreadyHandledPage(session), released: false };
    }
    session.status = "exchanging";
    let body;
    try {
      if (errorParam) {
        throw new Error(url.searchParams.get("error_description") || errorParam);
      }
      if (!code) throw new Error("No authorization code received");

      // Lazy import to avoid circular deps
      const { exchangeTokens } = await import("../../providers.js");

      const tokenData = await exchangeTokens(
        "codex",
        code,
        session.redirectUri,
        session.codeVerifier,
        state,
      );
      const connection = await createSessionConnection(session.binding, {
        provider: "codex",
        authType: "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
          : null,
        testStatus: "active",
      });

      session.status = "done";
      session.connectionId = connection.id;
      session.email = connection.email;
      body = renderCodexResultPage(true, "You can close this window.");
    } catch (err) {
      session.status = "error";
      session.error = err.message;
      body = renderCodexResultPage(false, err.message);
    }
    const released = releaseCodexListener(state);
    return { status: 200, headers: html, body, released };
  }

  // Intended change (YAN-739): while bound (multi-user) logins share this port, an
  // unknown/missing state gets a 400 and the listener stays up, instead of the legacy
  // 302 to the app channel + stop. Pure single-user flows keep the 302 below.
  if (listenerStillNeeded(pendingExchanges.values())) {
    return { status: 400, headers: html, body: unknownLoginPage(), released: false };
  }

  // Mode B: legacy channel fallback — 302 redirect to app /callback
  const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
  stopCodexProxy();
  return { status: 302, headers: { Location: redirectUrl }, body: "", released: true };
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort) {
  return new Promise((resolve) => {
    if (codexProxyServer) {
      // Reuse the live listener but renew its idle timeout, so an earlier
      // user's deadline cannot kill the flow that just adopted the port.
      if (anyLiveBoundSession(pendingExchanges.values())) {
        if (codexProxyTimeout) clearTimeout(codexProxyTimeout);
        codexProxyTimeout = setTimeout(() => stopCodexProxy(), CODEX_PROXY_TIMEOUT_MS);
      }
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const out = await handleCodexCallback(url, appPort);
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });

    server.listen(CODEX_PORT, "127.0.0.1", () => {
      codexProxyServer = server;
      codexProxyTimeout = setTimeout(() => stopCodexProxy(), CODEX_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy() {
  if (codexProxyTimeout) {
    clearTimeout(codexProxyTimeout);
    codexProxyTimeout = null;
  }
  if (codexProxyServer) {
    codexProxyServer.close();
    codexProxyServer = null;
  }
}
