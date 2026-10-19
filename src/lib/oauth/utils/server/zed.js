import http from "http";
import { URL } from "url";
import { ZED_HOSTED_CONFIG } from "../../constants/oauth.js";
import {
  createSessionConnection,
  clearPendingFor,
  listenerStillNeeded,
  isLoopbackOrigin,
  renderCodexResultPage,
  stateConflict,
  supersedeOwnSessions,
} from "./shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. One listener, sessions keyed by state (one pending login per user).
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyServer = null;
let zedProxyTimeout = null;
let zedProxyPort = null;
const zedSessions = new Map();

export function registerZedSession({ state, codeVerifier, systemId, binding }) {
  if (!state || !codeVerifier) return false;
  if (stateConflict(zedSessions, state, binding)) return false;
  supersedeOwnSessions(zedSessions, binding);
  zedSessions.set(state, {
    state,
    codeVerifier,
    systemId: systemId || null,
    binding,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}
export function getZedSessionStatus(state) {
  return (state && zedSessions.get(state)) || null;
}
export function clearZedSession(state) {
  if (state) zedSessions.delete(state);
}

/** Drop this user's still-pending sessions (stop-proxy by that user). */
export function clearZedSessionsFor(userId) {
  return clearPendingFor(zedSessions, userId);
}

/** Stop the listener unless another live login still needs it (see listenerStillNeeded). */
export function releaseZedListener(exceptState) {
  if (listenerStillNeeded(zedSessions.values(), exceptState)) return false;
  stopZedProxy();
  return true;
}

// A failed attempt (e.g. a stale popup's wrong-key token) leaves the session in
// "error" but the listener up so the live attempt's genuine callback can still
// land; so unlike the other providers, "error" stays claimable here.
const claimable = (s) => s.status === "pending" || s.status === "error";

/**
 * The Zed redirect carries no state: the owner is whichever claimable session's
 * RSA key decrypts the token. Only a lone UNBOUND session (switch-off / pre-flip
 * flow) is used as-is, so decrypt failures mark it exactly as before; bound
 * sessions always go through key matching and are never touched on failure.
 */
async function pickZedSession(rawCallback) {
  const candidates = [...zedSessions.values()].filter(claimable);
  if (candidates.length === 1 && !candidates[0].binding) return candidates[0];
  if (candidates.length === 0) return null;
  // Lazy: zedAuth pulls in proxyFetch, which patches globalThis.fetch on import.
  const { decryptZedAccessToken, parseZedCallbackPayload } = await import(
    "open-sse/shared/zedAuth.js"
  );
  let encrypted;
  try {
    encrypted = parseZedCallbackPayload(rawCallback).encryptedAccessToken;
  } catch {
    return null;
  }
  for (const s of candidates) {
    try {
      decryptZedAccessToken(encrypted, s.codeVerifier);
      return s;
    } catch {
      // not this session's key
    }
  }
  return null;
}

export function startZedProxy(preferredPort = 0) {
  return new Promise((resolve) => {
    if (zedProxyServer) {
      // Reuse the live listener, but renew its idle timeout so a previous
      // flow's deadline can never kill the flow that just adopted the port.
      // (Zed already re-armed here before YAN-739, so this is switch-off parity.)
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
      if (zedSessions.size === 0) {
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
      const session = await pickZedSession(rawCallback);
      // Re-check after the await: a concurrent callback may have claimed or
      // replaced this session while pickZedSession was loading zedAuth.
      if (!session || zedSessions.get(session.state) !== session || !claimable(session)) {
        // Unmatched callback (stale popup or foreign key): fail this response only.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No matching Zed login session"));
        return;
      }
      // Claim synchronously (before any await) so a duplicate hit cannot re-run the exchange.
      session.status = "exchanging";
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
        releaseZedListener(session.state);
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
  return [...zedSessions.values()];
}
