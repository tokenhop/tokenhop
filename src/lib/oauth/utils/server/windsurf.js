import http from "http";
import { URL } from "url";
import { WINDSURF_CONFIG } from "../../constants/oauth.js";
import { createSessionConnection, isLoopbackOrigin, renderCodexResultPage } from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Windsurf dynamic-port proxy. Singleton session.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyServer = null;
let windsurfProxyTimeout = null;
let windsurfProxyPort = null;
let windsurfSession = null;

export function registerWindsurfSession({ state, binding }) {
  if (!state) return false;
  windsurfSession = { state, binding, status: "pending", createdAt: Date.now() };
  return true;
}
export function getWindsurfSessionStatus(state) {
  if (!windsurfSession) return null;
  if (state && windsurfSession.state !== state) return null;
  return windsurfSession;
}
export function clearWindsurfSession(state) {
  if (!state || (windsurfSession && windsurfSession.state === state)) windsurfSession = null;
}

export function startWindsurfProxy() {
  return new Promise((resolve) => {
    if (windsurfProxyServer) {
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
      const session = windsurfSession;
      if (!session) {
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
      if (!cbState || !session.state || cbState !== session.state) {
        session.status = "error";
        session.error = "Windsurf callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopWindsurfProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
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
        stopWindsurfProxy();
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
  return [windsurfSession];
}
