import http from "http";
import { URL } from "url";

// Loopback origin guard for local callback proxies.
// Legit OAuth redirects are top-level navigations (no `Origin` header); a cross-site
// page issuing `fetch(..., {mode:"no-cors"})` to scan + hit 127.0.0.1 always sends
// `Origin: https://attacker`. Reject any non-loopback Origin to block login-CSRF.
export function isLoopbackOrigin(origin) {
  if (!origin) return true; // navigation redirect — allow
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

// YAN-366: callback creates run on the raw loopback server, outside any
// request context, so the session carries the principal/workspace captured at
// register time (`binding = { userId, workspaceId, ctx }`). No binding keeps
// today's unscoped create. Reload authority before saving so a downgrade or
// removal mid-flow fails through the callback's existing error path.
export async function createSessionConnection(binding, data) {
  if (binding) {
    const { createConnection, getMembershipRoleUnscoped, getUserUnscoped } = await import(
      "@/lib/db/index.js"
    );
    const { can } = await import("@/lib/users/principal.js");
    const role = await getMembershipRoleUnscoped(binding.workspaceId, binding.userId);
    const user = await getUserUnscoped(binding.userId);
    const ctx = {
      ...binding.ctx,
      instanceRole: user?.instanceRole,
      workspaceRoles: { [binding.workspaceId]: role },
    };
    if (
      user?.status !== "active" ||
      !can(ctx, "workspace.connections.manage", { workspaceId: binding.workspaceId })
    ) {
      throw new Error("Forbidden");
    }
    return createConnection(ctx, binding.workspaceId, data);
  }
  const { createProviderConnectionUnscoped } = await import("@/models");
  return createProviderConnectionUnscoped(data);
}

export const LIVE_FLOW_MAX_AGE_MS = 30 * 60_000;

/** A session still in flight: waiting for its callback or mid token-exchange. */
export function isLiveSession(s, cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS) {
  return (
    Boolean(s) &&
    (s.status === "pending" || s.status === "exchanging") &&
    (s.createdAt ?? 0) > cutoff
  );
}

/**
 * YAN-739: should the shared loopback listener stay up after `exceptState`
 * finishes (or for an unmatched callback, when omitted)? True only when another
 * live (pending/exchanging, younger than the ceiling) session exists AND the
 * multi-user path is involved, i.e. a bound session is among them or is the one
 * finishing. Bindings only exist while the multi-user switch is active, so a pure
 * switch-off flow (nothing bound) always stops, exactly as before; an unbound
 * flow started before the switch flipped still keeps the listener for a bound one
 * and vice versa.
 * @param {Iterable<object>} sessions
 * @param {string} [exceptState]
 */
export function listenerStillNeeded(sessions, exceptState) {
  const cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS;
  let anyBound = false;
  let otherLive = false;
  for (const s of sessions) {
    if (!s) continue;
    if (s.state === exceptState) {
      if (s.binding) anyBound = true;
    } else if (isLiveSession(s, cutoff)) {
      otherLive = true;
      if (s.binding) anyBound = true;
    }
  }
  return otherLive && anyBound;
}

/** True when any live session carries a binding (the multi-user path is active). */
export function anyLiveBoundSession(sessions) {
  const cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS;
  for (const s of sessions) if (s?.binding && isLiveSession(s, cutoff)) return true;
  return false;
}

/** Remove sessions older than the live-flow ceiling (abandoned flows). */
export function sweepExpiredSessions(map) {
  const cutoff = Date.now() - LIVE_FLOW_MAX_AGE_MS;
  for (const [key, s] of map) if ((s.createdAt ?? 0) <= cutoff) map.delete(key);
}

/**
 * Per-user supersede for state-keyed session maps: drop the same owner's older
 * sessions (unbound sessions share one owner key = today's single-session rule),
 * plus expired ones. A session mid-exchange is never dropped.
 */
export function supersedeOwnSessions(map, binding) {
  const owner = binding?.userId ?? null;
  sweepExpiredSessions(map);
  for (const [key, s] of map) {
    if (s.status !== "exchanging" && (s.binding?.userId ?? null) === owner) map.delete(key);
  }
}

/**
 * True when registering `state` must be refused: it is held by a different user
 * (only the bound/multi-user path can conflict; unbound registers keep today's
 * overwrite), or it is mid-exchange (an in-flight session object is never replaced).
 */
export function stateConflict(map, state, binding) {
  const existing = map.get(state);
  if (existing?.status === "exchanging") return true;
  return Boolean(binding && existing?.binding && existing.binding.userId !== binding.userId);
}

/**
 * Drop a user's still-pending sessions; one mid-exchange is left to finish.
 * @returns {string[]} the cleared states
 */
export function clearPendingFor(map, userId) {
  const cleared = [];
  for (const [key, s] of map) {
    if (s.status === "pending" && s.binding?.userId === userId) {
      map.delete(key);
      cleared.push(key);
    }
  }
  return cleared;
}

/** Result page for a repeated callback on a session that is no longer pending. */
export function alreadyHandledPage(session) {
  if (session.status === "error") {
    return renderCodexResultPage(false, session.error || "Login failed");
  }
  return renderCodexResultPage(true, "Sign-in received. You can close this window.");
}

/** Plain-text style error page for a callback that matches no pending login. */
export function unknownLoginPage() {
  return renderCodexResultPage(false, "Unknown or expired login. Restart it from the dashboard.");
}

/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(
          new Error(
            `Port ${fixedPort} is already in use. Please close other applications using this port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for callback with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallback(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Authentication timeout"));
      }
    }, timeoutMs);

    const onCallback = (params) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(params);
      }
    };

    // Return the callback function
    resolve.__onCallback = onCallback;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication successful" : "Authentication failed";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${safeMessage}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}
