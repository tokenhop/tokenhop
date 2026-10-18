import http from "http";
import { URL } from "url";
import { createSessionConnection, renderCodexResultPage } from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy. Kept as a parallel implementation rather than
// generalizing the Codex one to keep the codex hot-path byte-equivalent.
// ───────────────────────────────────────────────────────────────────────────

let xaiProxyServer = null;
let xaiProxyTimeout = null;
const XAI_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();

export function registerXaiSession({ state, codeVerifier, redirectUri, binding }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    binding,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function clearXaiSession(state) {
  xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort) {
  return new Promise((resolve) => {
    if (xaiProxyServer) {
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

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? xaiPendingExchanges.get(state) : null;

      // Mode A: server-side exchange
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../../providers.js");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state,
          );
          const connection = await createSessionConnection(session.binding, {
            provider: "xai",
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
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(false, err.message));
        } finally {
          stopXaiProxy();
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy();
    });

    server.listen(XAI_PROXY_PORT, "127.0.0.1", () => {
      xaiProxyServer = server;
      xaiProxyTimeout = setTimeout(() => stopXaiProxy(), XAI_PROXY_TIMEOUT_MS);
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

export function stopXaiProxy() {
  if (xaiProxyTimeout) {
    clearTimeout(xaiProxyTimeout);
    xaiProxyTimeout = null;
  }
  if (xaiProxyServer) {
    xaiProxyServer.close();
    xaiProxyServer = null;
  }
}

export function xaiLiveSessions() {
  return [...xaiPendingExchanges.values()];
}
