import http from "http";
import { URL } from "url";
import { WINDSURF_CONFIG } from "../../constants/oauth.js";
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
// Windsurf dynamic-port proxy. One listener, sessions keyed by state.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyServer = null;
let windsurfProxyTimeout = null;
let windsurfProxyPort = null;
const windsurfSessions = new Map();

export function registerWindsurfSession({ state, binding }) {
  if (!state) return false;
  if (stateConflict(windsurfSessions, state, binding)) return false;
  supersedeOwnSessions(windsurfSessions, binding);
  windsurfSessions.set(state, { state, binding, status: "pending", createdAt: Date.now() });
  return true;
}
export function getWindsurfSessionStatus(state) {
  return (state && windsurfSessions.get(state)) || null;
}
export function clearWindsurfSession(state) {
  if (state) windsurfSessions.delete(state);
}

/** Drop this user's still-pending sessions (stop-proxy by that user). */
export function clearWindsurfSessionsFor(userId) {
  return clearPendingFor(windsurfSessions, userId);
}

/** Stop the listener unless another live login still needs it (see listenerStillNeeded). */
export function releaseWindsurfListener(exceptState) {
  if (listenerStillNeeded(windsurfSessions.values(), exceptState)) return false;
  stopWindsurfProxy();
  return true;
}

export function startWindsurfProxy() {
  return new Promise((resolve) => {
    if (windsurfProxyServer) {
      // Renew the idle timeout only while a bound login is live (switch-off parity).
      if (anyLiveBoundSession(windsurfSessions.values())) {
        if (windsurfProxyTimeout) clearTimeout(windsurfProxyTimeout);
        windsurfProxyTimeout = setTimeout(
          () => stopWindsurfProxy(),
          WINDSURF_CONFIG.oauthTimeoutMs,
        );
      }
      resolve({
        success: true,
        port: windsurfProxyPort,
        callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}`,
      });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== WINDSURF_CONFIG.callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (windsurfSessions.size === 0) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Windsurf login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches, and require state present + matching.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      const session = cbState ? windsurfSessions.get(cbState) : null;
      if (session && session.status !== "pending") {
        // Repeated/concurrent hit: never re-run the exchange or mutate the session.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(alreadyHandledPage(session));
        return;
      }
      if (!session) {
        if (listenerStillNeeded(windsurfSessions.values())) {
          // Other users' logins share this listener: fail only this response.
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(unknownLoginPage());
          return;
        }
        for (const s of windsurfSessions.values()) {
          if (s.status !== "pending") continue;
          s.status = "error";
          s.error = "Windsurf callback state mismatch";
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Windsurf callback state mismatch"));
        stopWindsurfProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      session.status = "exchanging"; // claim synchronously, before any await
      try {
        const { exchangeTokens } = await import("../../providers.js");
        const tokenData = await exchangeTokens("windsurf", rawCallback, null, null, session.state);
        const connection = await createSessionConnection(session.binding, {
          provider: "windsurf",
          authType: "api_key",
          ...tokenData,
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
        releaseWindsurfListener(session.state);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      windsurfProxyServer = server;
      windsurfProxyPort = server.address().port;
      windsurfProxyTimeout = setTimeout(() => stopWindsurfProxy(), WINDSURF_CONFIG.oauthTimeoutMs);
      resolve({
        success: true,
        port: windsurfProxyPort,
        callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}`,
      });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopWindsurfProxy() {
  if (windsurfProxyTimeout) {
    clearTimeout(windsurfProxyTimeout);
    windsurfProxyTimeout = null;
  }
  if (windsurfProxyServer) {
    windsurfProxyServer.close();
    windsurfProxyServer = null;
  }
  windsurfProxyPort = null;
}

export function windsurfLiveSessions() {
  return [...windsurfSessions.values()];
}
