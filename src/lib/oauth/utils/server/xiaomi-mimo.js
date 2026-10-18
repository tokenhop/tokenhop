import http from "http";
import { URL } from "url";
import { ACTIVE } from "@/shared/brand";
import { isLoopbackOrigin } from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Xiaomi MiMo Desktop OAuth callback proxy
// Receives the ECDH-encrypted `u` param, decrypts it, stores the session.
// ───────────────────────────────────────────────────────────────────────────

let xiaomiMimoProxyServer = null;
let xiaomiMimoProxyPort = null;
let xiaomiMimoProxyTimeout = null;
const XIAOMI_MIMO_PROXY_TIMEOUT_MS = 5 * 60 * 1000;

const xiaomiMimoSessions = new Map();

export function registerXiaomiMimoSession({ state, privateKeyDer, binding }) {
  if (!state || !privateKeyDer) return false;
  xiaomiMimoSessions.set(state, {
    privateKeyDer,
    binding,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXiaomiMimoSessionStatus(state) {
  const s = xiaomiMimoSessions.get(state);
  if (!s) return null;
  // Don't leak the private key to the client
  return {
    status: s.status,
    result: s.result || null,
    error: s.error || null,
    binding: s.binding,
  };
}

export function clearXiaomiMimoSession(state) {
  xiaomiMimoSessions.delete(state);
}

function renderXiaomiMimoResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication successful" : "Authentication failed";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
  .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  .icon { color: ${color}; font-size: 3rem; }
  h1 { margin: 1rem 0; font-size: 1.25rem; }
  p { color: #666; font-size: 0.875rem; }
</style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message || (success ? `You can close this tab and return to ${ACTIVE.name}.` : "Please try again.")}</p>
    ${success ? "<script>setTimeout(() => window.close(), 3000);</script>" : ""}
  </div>
</body>
</html>`;
}

/**
 * Start the Xiaomi Desktop OAuth callback proxy.
 * @returns {Promise<{success: boolean, port?: number, callbackUrl?: string, reason?: string}>}
 */
function armXiaomiMimoProxyTimeout() {
  if (xiaomiMimoProxyTimeout) clearTimeout(xiaomiMimoProxyTimeout);
  xiaomiMimoProxyTimeout = setTimeout(() => {
    console.log("[xiaomi-mimo oauth] timeout, stopping");
    stopXiaomiMimoProxy();
  }, XIAOMI_MIMO_PROXY_TIMEOUT_MS);
}

export function startXiaomiMimoProxy() {
  return new Promise((resolve) => {
    if (xiaomiMimoProxyServer) {
      // Reuse the live listener, but renew its idle timeout so a previous
      // flow's deadline can never kill the flow that just adopted the port.
      armXiaomiMimoProxyTimeout();
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}/`,
      });
      return;
    }

    const server = http.createServer(async (req, res) => {
      // Origin guard
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const u = url.searchParams.get("u");

      if (!u) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(false, "Missing encrypted payload (u parameter)."));
        return;
      }

      // Try each pending session's private key — the callback URL carries no
      // state param, so we attempt decryption with every pending key.
      const pendingSessions = [...xiaomiMimoSessions.entries()].filter(
        ([, s]) => s.status === "pending",
      );

      if (pendingSessions.length === 0) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderXiaomiMimoResultPage(
            false,
            "No active OAuth session. Please restart the login flow.",
          ),
        );
        return;
      }

      try {
        const { decryptCallback } = await import("../../providers/xiaomi-mimo.js");
        let result = null;
        let matchedState = null;

        for (const [state, session] of pendingSessions) {
          try {
            result = decryptCallback(session.privateKeyDer, u);
            matchedState = state;
            break;
          } catch {
            // Wrong key for this session — try next
          }
        }

        if (!result || !matchedState) {
          throw new Error("Could not decrypt with any pending session key");
        }

        if (!result.sk) {
          throw new Error("Decrypted payload missing sk (API key)");
        }

        // Store result only in the matched session
        const session = xiaomiMimoSessions.get(matchedState);
        if (session) {
          session.status = "done";
          session.result = {
            uid: result.uid,
            accessToken: result.sk,
            baseUrl: result.url || "https://api.xiaomimimo.com/v1",
          };
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(true, "Xiaomi account linked. You can close this tab."));
        console.log("[xiaomi-mimo oauth] callback decrypted, uid:", result.uid);
      } catch (err) {
        console.error("[xiaomi-mimo oauth] decrypt failed:", err.message);
        for (const [, session] of pendingSessions) {
          session.status = "error";
          session.error = err.message;
        }
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderXiaomiMimoResultPage(false, `Decryption failed: ${err.message}`));
      }
    });

    server.on("error", (err) => {
      console.log("[xiaomi-mimo oauth] listen error:", err.message);
      resolve({ success: false, reason: err.message });
    });

    server.listen(0, "127.0.0.1", () => {
      xiaomiMimoProxyServer = server;
      xiaomiMimoProxyPort = server.address().port;
      armXiaomiMimoProxyTimeout();
      console.log(`[xiaomi-mimo oauth] listening on port ${xiaomiMimoProxyPort}`);
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}/`,
      });
    });
  });
}

export function stopXiaomiMimoProxy() {
  console.log(`[xiaomi-mimo oauth] stopping (port ${xiaomiMimoProxyPort || "-"})`);
  if (xiaomiMimoProxyTimeout) {
    clearTimeout(xiaomiMimoProxyTimeout);
    xiaomiMimoProxyTimeout = null;
  }
  if (xiaomiMimoProxyServer) {
    xiaomiMimoProxyServer.close();
    xiaomiMimoProxyServer = null;
  }
  xiaomiMimoProxyPort = null;
  // No callback can arrive once the listener is down, so drop every pending
  // session — each holds an X25519 private key and they would otherwise
  // accumulate for the process lifetime (one per /authorize call).
  xiaomiMimoSessions.clear();
}

export function xiaomiMimoLiveSessions() {
  return [...xiaomiMimoSessions.values()];
}
