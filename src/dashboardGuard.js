import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { resolveFlagSetting, resolveStartPage } from "@/lib/settingsFlags";
import { extractClientApiKey } from "@/lib/auth/clientApiKey";
import { isLoopbackHostname, isLoopbackPeer } from "@/lib/auth/trustedPeer";
import { resolveRoutePolicy } from "@/lib/auth/routePolicy";
import { getPasswordChangeUser, PASSWORD_CHANGE_COOKIE } from "@/lib/auth/passwordChangeSession";
import {
  cliTokenAccepted,
  hasValidSession,
  principalCan,
  resolvePrincipal,
  singleUserMode,
} from "@/lib/users/session";
import { LOCAL_ONLY_CODE } from "@/shared/utils/localOnly";

// Skill markdown reads: static content any network peer may fetch (the URL is
// pasted to AI agents), so /skills never requires auth or an API key. Still
// only exact allowlisted ids resolve; traversal/unknown ids 404 in the route.
const PUBLIC_PAGE_PREFIXES = ["/skills"];

// Every /api/* route and the LLM API prefixes: src/lib/auth/routePolicy.js.

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return resolveRoutePolicy(pathname)?.gateway === true;
}

function extractApiKey(request) {
  return extractClientApiKey(request);
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await cliTokenAccepted(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request, cliAllowed = true) {
  if (cliAllowed && (await cliTokenAccepted(request))) return true;
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && (await isAuthenticated(request))) return true;
  return false;
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidSession(request)) return true;
  // YAN-356: single-user mode, not requireLogin=false alone — a restored DB
  // with two users and login off stays closed.
  return singleUserMode(await loadSettings());
}

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
  isTranslatorPath,
};

function isPublicPage(pathname) {
  return PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// YAN-312: the Translator debug page honors the resolved flag — page and
// subpaths. The /api/translator debug API is intentionally NOT gated: it is
// auth-protected and other pages (console-log) share it.
function isTranslatorPath(pathname) {
  return pathname === "/dashboard/translator" || pathname.startsWith("/dashboard/translator/");
}

/**
 * YAN-358: true only for exactly POST /api/auth/change-password (row
 * passwordChange, exact path — no encoded separators) with a valid
 * restricted password-change token. All other paths: restricted cookie
 * grants nothing.
 */
async function hasPasswordChangeAccess(request, policy) {
  if (!policy?.passwordChange) return false;
  if (policy.key !== "/api/auth/change-password") return false;
  if (String(request.method || "GET").toUpperCase() !== "POST") return false;
  // Exact raw path: any percent-encoding of the path is refused.
  if (request.nextUrl.pathname !== "/api/auth/change-password") return false;
  const token = request.cookies.get(PASSWORD_CHANGE_COOKIE)?.value;
  if (!token) return false;
  return (await getPasswordChangeUser(token)) !== null;
}

/**
 * Apply a routePolicy row: local-only gate, then public / gateway / session
 * auth, then the capability. Null when allowed, else the error response.
 */
async function checkApiPolicy(request, policy) {
  // Local-only gate for spawn-capable / host-secret routes.
  if (policy.localOnly && !(await canAccessLocalOnlyRoute(request, policy.cliAllowed))) {
    return NextResponse.json(
      { error: "Local only: CLI token required", code: LOCAL_ONLY_CODE },
      { status: 403 },
    );
  }
  if (policy.public) return null;
  if (policy.gateway) {
    if (await canAccessPublicLlmApi(request)) return null;
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }
  const cli = policy.cliAllowed && (await cliTokenAccepted(request));
  // alwaysProtected: a session or the CLI token; single-user mode doesn't open it.
  const authed =
    cli ||
    (policy.alwaysProtected ? await hasValidSession(request) : await isAuthenticated(request));
  if (!authed) {
    // YAN-358: the restricted password-change cookie admits exactly
    // POST /api/auth/change-password and nothing else.
    if (await hasPasswordChangeAccess(request, policy)) return null;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await principalCan(request, policy.capability, { anyWorkspace: policy.scoped }))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (isPublicPage(pathname)) return NextResponse.next();

  const policy = resolveRoutePolicy(pathname, request.method);
  if (policy) {
    const denied = await checkApiPolicy(request, policy);
    if (denied) return denied;
    return NextResponse.next();
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;
    let translatorEnabled = false;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;
        translatorEnabled = resolveFlagSetting(
          "ENABLE_TRANSLATOR",
          settings.translatorEnabled,
          false,
        ).value;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl
            ? new URL(settings.tunnelUrl).hostname.toLowerCase()
            : "";
          const tailscaleHost = settings.tailscaleUrl
            ? new URL(settings.tailscaleUrl).hostname.toLowerCase()
            : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required (single-user mode), allow through
    if (!requireLogin && (await singleUserMode({ requireLogin }))) {
      if (isTranslatorPath(pathname) && !translatorEnabled) {
        return NextResponse.redirect(new URL("/dashboard", request.url));
      }
      return NextResponse.next();
    }

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      // Switch on: a live session of a pending user is not a dashboard login.
      if ((await hasValidSession(request)) && (await principalCan(request, "self.session"))) {
        // YAN-312: the Translator debug page honors the resolved flag.
        if (isTranslatorPath(pathname) && !translatorEnabled) {
          return NextResponse.redirect(new URL("/dashboard", request.url));
        }
        return NextResponse.next();
      }
    }

    // YAN-358: no full session, but a valid restricted cookie: send the user
    // to the forced password-change step instead of the plain login page.
    const restricted = request.cookies.get(PASSWORD_CHANGE_COOKIE)?.value;
    if (restricted && (await getPasswordChangeUser(restricted)) !== null) {
      return NextResponse.redirect(new URL("/login?error=password_change_required", request.url));
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to the configured start page when logged in, else to it anyway
  // (dashboardGuard forces login on /dashboard/*): never trap users — an
  // invalid stored value falls back to /dashboard (resolveStartPage).
  if (pathname === "/") {
    try {
      // YAN-362: a signed-in user's effective startPage (instance ⊕ user
      // preferences) wins. resolvePrincipal is null with the switch off, so
      // the unauthenticated fallback below stays byte-identical to before.
      const principal = await resolvePrincipal(request);
      const settings = principal ? await getEffectivePreferences(principal) : await loadSettings();
      const startPage = resolveStartPage(settings?.startPage);
      return NextResponse.redirect(new URL(startPage, request.url));
    } catch {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  return NextResponse.next();
}
