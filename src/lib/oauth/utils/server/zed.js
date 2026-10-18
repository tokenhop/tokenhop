import http from "http";
import { URL } from "url";
import { ZED_HOSTED_CONFIG } from "../../constants/oauth.js";
import { createSessionConnection, isLoopbackOrigin, renderCodexResultPage } from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. Singleton session.
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyServer = null;
let zedProxyTimeout = null;
let zedProxyPort = null;
let zedSession = null;

export function registerZedSession({ state, codeVerifier, systemId, binding }) {
  if (!state || !codeVerifier) return false;
  zedSession = {
    state,
    codeVerifier,
    systemId: systemId || null,
    binding,
    status: "pending",
    createdAt: Date.now(),
  };
  return true;
}
export function getZedSessionStatus(state) {
  if (!zedSession) return null;
  if (state && zedSession.state !== state) return null;
  return zedSession;
}
export function clearZedSession(state) {
  if (!state || (zedSession && zedSession.state === state)) zedSession = null;
}

export function startZedProxy(preferredPort = 0) {
  return new Promise((resolve) => {
    if (zedProxyServer) {
      // Reuse the live listener, but renew its idle timeout so a previous
      // flow's deadline can never kill the flow that just adopted the port.
      if (zedProxyTimeout) clearTimeout(zedProxyTimeout);
      zedProxyTimeout = setTimeout(() => {
        console.log("[Zed proxy] timeout, stopping");
        stopZedProxy();
      }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      resolve({
        success: true,
        port: zedProxyPort,
        callbackUrl: `http://127.0.0.1:${zedProxyPort}/`,
      });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      // Log path + redacted params (access_token is the RSA-encrypted credential).
      const redacted = Object.fromEntries(url.searchParams);
      for (const k of ["access_token", "user_id", "code_verifier", "state"]) {
        if (redacted[k]) redacted[k] = "<redacted>";
      }
      console.log("[Zed proxy]", req.method, url.pathname, JSON.stringify(redacted));
      // A genuine Zed redirect always carries user_id + access_token. Like the
      // upstream Zed client, accept it on ANY path; only param-less requests
      // off the callback paths (favicon, probes) get a 404.
      const qp = url.searchParams;
      const hasZedParams =
        qp.has("user_id") ||
        qp.has("userId") ||
        qp.has("access_token") ||
        qp.has("accessToken") ||
        qp.has("token");
      if (!hasZedParams && url.pathname !== "/" && url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = zedSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Zed login session"));
        return;
      }
      // Anti-CSRF: Zed tokens are RSA-encrypted to our keypair so they can't be
      // forged cross-site, but still reject cross-origin fetches for defense-in-depth.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      // Anything without login params (probe, prefetch, stray navigation) is
      // NOT the callback: answer without touching the session and WITHOUT
      // stopping the server, so the real redirect can still land afterwards.
      if (!hasZedParams) {
        console.log(
          `[Zed proxy] ignoring non-callback ${req.method} ${url.pathname} (session kept, server kept)`,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderCodexResultPage(
            false,
            "Waiting for Zed sign-in — this request carried no login data.",
          ),
        );
        return;
      }
      // Pass raw callback path+query to exchangeTokens → parseZedCallbackPayload.
      // codeVerifier carries the encoded RSA private key for decryption.
      const rawCallback = url.search
        ? `${url.pathname}?${url.searchParams.toString()}`
        : url.pathname;
      try {
        const { exchangeTokens } = await import("../../providers.js");
        const tokenData = await exchangeTokens(
          "zed",
          rawCallback,
          null,
          session.codeVerifier,
          session.state,
          session.systemId ? { systemId: session.systemId } : undefined,
        );
        const connection = await createSessionConnection(session.binding, {
          provider: "zed",
          authType: "oauth",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
        stopZedProxy();
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
        // Intentionally NOT stopping here: the failure may belong to a
        // superseded attempt (e.g. an older popup landing after "Try Again"
        // registered a new keypair). The live attempt's genuine callback must
        // still land. The idle timeout + modal close bound the listener.
      }
    });
    const tryPort = Number(preferredPort) || 0;
    server.on("error", (err) => {
      // If the preferred port (e.g. 58443) is busy, fall back to a random port.
      if (err.code === "EADDRINUSE" && tryPort !== 0) {
        console.log(`[Zed proxy] port ${tryPort} busy, falling back to random`);
        server.listen(0, "127.0.0.1", () => {
          zedProxyServer = server;
          zedProxyPort = server.address().port;
          zedProxyTimeout = setTimeout(() => stopZedProxy(), ZED_HOSTED_CONFIG.oauthTimeoutMs);
          console.log(`[Zed proxy] listening on random port ${zedProxyPort}`);
          resolve({
            success: true,
            port: zedProxyPort,
            callbackUrl: `http://127.0.0.1:${zedProxyPort}/`,
          });
        });
      } else {
        console.log(`[Zed proxy] listen error: ${err.message}`);
        resolve({ success: false, reason: err.message });
      }
    });
    server.listen(tryPort, "127.0.0.1", () => {
      zedProxyServer = server;
      zedProxyPort = server.address().port;
      zedProxyTimeout = setTimeout(() => {
        console.log("[Zed proxy] timeout, stopping");
        stopZedProxy();
      }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      console.log(`[Zed proxy] listening on port ${zedProxyPort}`);
      resolve({
        success: true,
        port: zedProxyPort,
        callbackUrl: `http://127.0.0.1:${zedProxyPort}/`,
      });
    });
  });
}

export function stopZedProxy() {
  console.log(`[Zed proxy] stopping (port ${zedProxyPort || "-"})`);
  if (zedProxyTimeout) {
    clearTimeout(zedProxyTimeout);
    zedProxyTimeout = null;
  }
  if (zedProxyServer) {
    zedProxyServer.close();
    zedProxyServer = null;
  }
  zedProxyPort = null;
}

export function zedLiveSessions() {
  return [zedSession];
}
