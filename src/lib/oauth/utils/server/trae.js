import http from "http";
import { URL } from "url";
import { TRAE_CONFIG } from "../../constants/oauth.js";
import {
  createSessionConnection,
  alreadyHandledPage,
  anyLiveBoundSession,
  clearPendingFor,
  listenerStillNeeded,
  isLoopbackOrigin,
  renderCodexResultPage,
  stateConflict,
  supersedeOwnSessions,
  unknownLoginPage,
} from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Trae dynamic-port proxy. One listener, sessions keyed by state (one pending login per user).
// Callback path = /callback with params refreshToken + loginHost.
// ───────────────────────────────────────────────────────────────────────────

let traeProxyServer = null;
let traeProxyTimeout = null;
let traeProxyPort = null;
const traeSessions = new Map();

export function registerTraeSession({ state, binding }) {
  if (!state) return false;
  if (stateConflict(traeSessions, state, binding)) return false;
  supersedeOwnSessions(traeSessions, binding);
  traeSessions.set(state, { state, binding, status: "pending", createdAt: Date.now() });
  return true;
}
export function getTraeSessionStatus(state) {
  return (state && traeSessions.get(state)) || null;
}
export function clearTraeSession(state) {
  if (state) traeSessions.delete(state);
}

/** Drop this user's still-pending sessions (stop-proxy by that user). */
export function clearTraeSessionsFor(userId) {
  clearPendingFor(traeSessions, userId);
}

/** Stop the listener unless another live login still needs it (see listenerStillNeeded). */
export function releaseTraeListener(exceptState) {
  if (listenerStillNeeded(traeSessions.values(), exceptState)) return false;
  stopTraeProxy();
  return true;
}

export function startTraeProxy() {
  return new Promise((resolve) => {
    if (traeProxyServer) {
      // Renew the idle timeout only while a bound login is live (switch-off parity).
      if (anyLiveBoundSession(traeSessions.values())) {
        if (traeProxyTimeout) clearTimeout(traeProxyTimeout);
        traeProxyTimeout = setTimeout(() => stopTraeProxy(), TRAE_CONFIG.oauthTimeoutMs);
      }
      resolve({
        success: true,
        port: traeProxyPort,
        callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}`,
      });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== TRAE_CONFIG.callbackPath && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (traeSessions.size === 0) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Trae login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches (legit redirects send no Origin),
      // and match the callback to its session by state.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      let session = cbState ? traeSessions.get(cbState) : null;
      // No state in the callback: only unambiguous when exactly one login is PENDING
      // (finished/failed/in-flight sessions never qualify); otherwise fail closed.
      if (!cbState) {
        const pending = [...traeSessions.values()].filter((s) => s.status === "pending");
        if (pending.length === 1) session = pending[0];
      }
      if (session && session.status !== "pending") {
        // Repeated/concurrent hit: never re-run the exchange or mutate the session.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(alreadyHandledPage(session));
        return;
      }
      if (!session) {
        if (listenerStillNeeded(traeSessions.values())) {
          // Other users' logins share this listener: fail only this response.
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(unknownLoginPage());
          return;
        }
        // Single-user behaviour: mismatch poisons the (sole) pending session.
        for (const s of traeSessions.values()) {
          if (s.status !== "pending") continue;
          s.status = "error";
          s.error = "Trae callback state mismatch";
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Trae callback state mismatch"));
        stopTraeProxy();
        return;
      }
      // Pass the raw callback query to exchangeTokens → parseTraeCallback
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      session.status = "exchanging"; // claim synchronously, before any await
      try {
        const { exchangeTokens } = await import("../../providers.js");
        const tokenData = await exchangeTokens("trae", rawCallback);
        const connection = await createSessionConnection(session.binding, {
          provider: "trae",
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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        releaseTraeListener(session.state);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      traeProxyServer = server;
      traeProxyPort = server.address().port;
      traeProxyTimeout = setTimeout(() => stopTraeProxy(), TRAE_CONFIG.oauthTimeoutMs);
      resolve({
        success: true,
        port: traeProxyPort,
        callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}`,
      });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopTraeProxy() {
  if (traeProxyTimeout) {
    clearTimeout(traeProxyTimeout);
    traeProxyTimeout = null;
  }
  if (traeProxyServer) {
    traeProxyServer.close();
    traeProxyServer = null;
  }
  traeProxyPort = null;
}

export function traeLiveSessions() {
  return [...traeSessions.values()];
}
