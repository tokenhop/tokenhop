// Route → capability table (YAN-357, ADR-0002). Every src/app/api/**/route.js
// has a row; tests/unit/route-policy.test.js fails on any unmapped route or
// method. dashboardGuard reads it. Pure: no imports, it sits in the proxy bundle.
//
// Row fields (all optional except `cap`):
//   cap              capability, or { METHOD: capability } per method
//   public           no auth at all (login, health, SSO callbacks…)
//   gateway          LLM API: local peer, CLI token or a gateway API key
//   localOnly        loopback peer + loopback Origin, or the CLI token
//   remoteMethods    methods exempt from localOnly (exact path only)
//   alwaysProtected  session or CLI token; single-user mode does not open it
//   cliAllowed       the CLI token authenticates (default true)
//   scoped           workspace-scoped handler (YAN-361): the guard asks for the
//                    capability in any of the principal's workspaces and the
//                    handler checks the row's workspace
//   passwordChange   YAN-358: exactly POST on this row also admits a valid
//                    restricted password-change token (no full session)
//   multiUserOnly    YAN-360: answers the same 404 as requireMultiUser() while
//                    the users & teams switch is off. dashboardGuard checks it
//                    before any local/auth check, so 401/403 never leak.
// With the users & teams switch off every authenticated principal is the
// owner, so `cap` changes nothing; the flags reproduce the old path lists.

const HOST = "instance.hostOps";
const SETTINGS = "instance.settings.manage";
const META = "workspace.connections.metadata.read";
const CONN = "workspace.connections.manage";
const USE = "workspace.connections.use";
const COMBOS = "workspace.combos.manage";
const USAGE = "workspace.usage.read";
const SELF = "self.session";

const PUBLIC = { cap: null, public: true };
const LOCAL_HOST = { cap: HOST, localOnly: true };
const read = (getCap, writeCap) => ({
  cap: { GET: getCap, POST: writeCap, PUT: writeCap, PATCH: writeCap, DELETE: writeCap },
});
const scoped = (row) => ({ ...row, scoped: true });
const multiUser = (row) => ({ ...row, multiUserOnly: true });

/** @type {Record<string, object>} */
export const ROUTE_POLICY = {
  // Auth and bootstrap.
  "/api/auth/login": PUBLIC,
  "/api/auth/logout": PUBLIC,
  "/api/auth/logout-all": { cap: SELF },
  "/api/auth/status": PUBLIC,
  "/api/auth/oidc/start": PUBLIC,
  "/api/auth/oidc/callback": PUBLIC,
  "/api/auth/oidc/test": { cap: SETTINGS, cliAllowed: false },
  "/api/auth/saml/start": PUBLIC,
  "/api/auth/saml/acs": PUBLIC,
  "/api/auth/saml/metadata": PUBLIC,
  "/api/auth/saml/test": { cap: SETTINGS, cliAllowed: false },
  "/api/auth/reset-password": LOCAL_HOST,
  "/api/auth/setup-token": { cap: "instance.ownership.transfer", localOnly: true },
  // YAN-358: POST-only (other methods fail closed to hostOps via the
  // per-method cap). A valid restricted password-change token also admits
  // POST; the guard checks row.passwordChange on the exact path.
  "/api/auth/change-password": {
    cap: { POST: SELF },
    alwaysProtected: true,
    cliAllowed: false,
    passwordChange: true,
  },
  "/api/users/[id]/password": {
    cap: "instance.users.manage",
    alwaysProtected: true,
    cliAllowed: false,
  },
  // YAN-362: workspace overrides (handler re-checks the row's workspace) and
  // personal UI preferences (browser session only).
  "/api/workspaces/[id]/settings": scoped(read(USE, "workspace.preferences.manage")),
  "/api/me/preferences": { cap: SELF },
  // YAN-371 account routes: browser session only, 404 while the switch is off
  // (multiUserOnly). alwaysProtected: single-user mode must never satisfy them.
  "/api/me/workspace": multiUser({ cap: { POST: SELF }, alwaysProtected: true, cliAllowed: false }),
  "/api/me/identities": multiUser({ cap: { GET: SELF }, alwaysProtected: true, cliAllowed: false }),
  "/api/me/identities/[id]": multiUser({
    cap: { DELETE: SELF },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  // YAN-360: admin user lifecycle, ownership transfer, memberships, invitations.
  // Per-method caps: any unlisted method fails closed to hostOps. The static
  // ownership-transfer row is exact-matched before the dynamic [id] pattern.
  // Workspace rows are scoped: the guard only asks for the capability in any of
  // the principal's workspaces, the handler rechecks the exact URL workspace
  // (workspace manager, or instance admin/owner). Accept is public: the invite
  // token is the authorization; it is still hidden while the switch is off.
  "/api/users": multiUser({
    cap: { GET: "instance.users.manage" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/users/ownership-transfer": multiUser({
    cap: { POST: "instance.ownership.transfer" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/users/ownership-transfer/sso": multiUser({
    cap: { POST: "instance.ownership.transfer" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/users/[id]": multiUser({
    cap: { PATCH: "instance.users.manage", DELETE: "instance.users.manage" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/workspaces/[id]/members": multiUser(
    scoped({ cap: { GET: "workspace.members.manage", POST: "workspace.members.manage" } }),
  ),
  "/api/workspaces/[id]/members/[userId]": multiUser(
    scoped({ cap: { PATCH: "workspace.members.manage", DELETE: "workspace.members.manage" } }),
  ),
  "/api/workspaces/[id]/invitations": multiUser(
    scoped({
      cap: { GET: "workspace.members.manage", POST: "workspace.members.manage" },
      cliAllowed: false,
    }),
  ),
  "/api/workspaces/[id]/invitations/[inviteId]": multiUser(
    scoped({ cap: { DELETE: "workspace.members.manage" }, cliAllowed: false }),
  ),
  "/api/invitations/accept": multiUser(PUBLIC),
  // YAN-701: move items between workspaces. Browser session only. Edge asks for
  // connections.manage in any workspace; the handler enforces live rights per
  // item type in source AND target (no instance-admin bypass).
  "/api/workspaces/[id]/move": multiUser(scoped({ cap: { POST: CONN }, cliAllowed: false })),
  // YAN-372 budgets (ADR-0007): workspace rows are scoped (the repo rechecks
  // live authority, incl. the key-owner/grant-creator exceptions and the
  // raise/delete admin gate); user-level rows are instance-admin only.
  "/api/workspaces/[id]/budgets": multiUser(
    scoped({
      cap: { GET: "workspace.budgets.read", POST: "workspace.budgets.lower" },
      cliAllowed: false,
    }),
  ),
  "/api/workspaces/[id]/budgets/[budgetId]": multiUser(
    scoped({
      cap: { PATCH: "workspace.budgets.lower", DELETE: "workspace.budgets.lower" },
      cliAllowed: false,
    }),
  ),
  "/api/users/[id]/budgets": multiUser({
    cap: { GET: "instance.budgets.raise", POST: "instance.budgets.raise" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/users/[id]/budgets/[budgetId]": multiUser({
    cap: { PATCH: "instance.budgets.raise", DELETE: "instance.budgets.raise" },
    alwaysProtected: true,
    cliAllowed: false,
  }),
  "/api/health": PUBLIC,
  "/api/init": PUBLIC,
  "/api/locale": PUBLIC,
  "/api/settings/require-login": PUBLIC,

  // Host operations.
  "/api/shutdown": { cap: HOST, alwaysProtected: true },
  "/api/version/shutdown": { cap: HOST, alwaysProtected: true },
  "/api/settings/database": { cap: HOST, alwaysProtected: true },
  "/api/settings/config/export": { cap: HOST },
  "/api/settings/config/import": { cap: HOST },
  "/api/cli-tool-presets": { cap: HOST },
  "/api/cli-tool-settings": { cap: HOST },
  "/api/cli-tool-settings/[toolId]": { cap: HOST },
  "/api/cli-tools/all-statuses": LOCAL_HOST,
  "/api/cli-tools/antigravity-mitm": LOCAL_HOST,
  "/api/cli-tools/antigravity-mitm/alias": { ...LOCAL_HOST, remoteMethods: ["GET", "PUT"] },
  "/api/cli-tools/claude-settings": LOCAL_HOST,
  "/api/cli-tools/cline-settings": LOCAL_HOST,
  "/api/cli-tools/codex-settings": LOCAL_HOST,
  "/api/cli-tools/copilot-settings": LOCAL_HOST,
  "/api/cli-tools/cowork-mcp-registry": { ...LOCAL_HOST, remoteMethods: ["GET"] },
  "/api/cli-tools/cowork-mcp-tools": LOCAL_HOST,
  "/api/cli-tools/cowork-settings": LOCAL_HOST,
  "/api/cli-tools/deepseek-tui-settings": LOCAL_HOST,
  "/api/cli-tools/devin-settings": LOCAL_HOST,
  "/api/cli-tools/droid-settings": LOCAL_HOST,
  "/api/cli-tools/grok-build-settings": LOCAL_HOST,
  "/api/cli-tools/hermes-settings": LOCAL_HOST,
  "/api/cli-tools/jcode-settings": LOCAL_HOST,
  "/api/cli-tools/kilo-settings": LOCAL_HOST,
  "/api/cli-tools/openclaw-settings": LOCAL_HOST,
  "/api/cli-tools/opencode-settings": LOCAL_HOST,
  "/api/mcp/[plugin]/message": LOCAL_HOST,
  "/api/mcp/[plugin]/sse": LOCAL_HOST,
  "/api/headroom/start": LOCAL_HOST,
  "/api/headroom/stop": LOCAL_HOST,
  "/api/headroom/proxy/[...path]": LOCAL_HOST,
  "/api/headroom/restart": { cap: HOST },
  "/api/headroom/extras": { cap: HOST },
  "/api/headroom/status": { cap: HOST },
  "/api/pxpipe/health": { cap: HOST },
  "/api/pxpipe/install": { cap: HOST },
  "/api/pxpipe/logs": { cap: HOST },
  "/api/pxpipe/restart": { cap: HOST },
  "/api/pxpipe/start": { cap: HOST },
  "/api/pxpipe/stats": { cap: HOST },
  "/api/pxpipe/status": { cap: HOST },
  "/api/pxpipe/stop": { cap: HOST },
  "/api/translator/console-logs": { cap: HOST },
  "/api/translator/console-logs/stream": { cap: HOST },
  "/api/translator/load": { cap: HOST },
  "/api/translator/save": { cap: HOST },
  "/api/translator/send": { cap: HOST },
  "/api/translator/translate": { cap: HOST },
  "/api/tunnel/enable": LOCAL_HOST,
  "/api/tunnel/disable": LOCAL_HOST,
  "/api/tunnel/tailscale-check": LOCAL_HOST,
  "/api/tunnel/tailscale-enable": LOCAL_HOST,
  "/api/tunnel/tailscale-disable": LOCAL_HOST,
  "/api/tunnel/tailscale-install": LOCAL_HOST,
  "/api/tunnel/status": { cap: HOST },
  "/api/oauth/cursor/auto-import": { ...LOCAL_HOST, alwaysProtected: true },
  "/api/oauth/kiro/auto-import": { ...LOCAL_HOST, alwaysProtected: true },
  // YAN-366: aligned with its cursor/kiro siblings (host file read).
  "/api/oauth/xiaomi-mimo/auto-import": { ...LOCAL_HOST, alwaysProtected: true },

  // Instance settings (proxy pools and pricing stay instance-level, ADR-0001).
  "/api/settings": { cap: SETTINGS },
  "/api/settings/environment": { cap: SETTINGS },
  "/api/settings/proxy-test": { cap: SETTINGS },
  "/api/pricing": { cap: SETTINGS },
  "/api/proxy-pools": { cap: SETTINGS },
  "/api/proxy-pools/[id]": { cap: SETTINGS },
  "/api/proxy-pools/[id]/test": { cap: SETTINGS },
  "/api/proxy-pools/cloudflare-deploy": { cap: SETTINGS },
  "/api/proxy-pools/deno-deploy": { cap: SETTINGS },
  "/api/proxy-pools/vercel-deploy": { cap: SETTINGS },
  "/api/models/catalog-sync": read(META, SETTINGS),

  // Connections, nodes and OAuth connect flows.
  "/api/providers": scoped(read(META, CONN)),
  "/api/providers/[id]": scoped(read(META, CONN)),
  "/api/providers/[id]/models": scoped({ cap: META }),
  "/api/providers/[id]/test": scoped({ cap: USE }),
  "/api/providers/[id]/test-models": scoped({ cap: USE }),
  "/api/providers/test-batch": scoped({ cap: USE }),
  "/api/providers/validate": scoped({ cap: CONN }),
  "/api/providers/client": scoped({ cap: META }),
  "/api/providers/kilo/free-models": { cap: META },
  "/api/providers/suggested-models": { cap: META },
  // YAN-369: connection grants — the handler re-checks the row's owning
  // workspace live (source workspace manager, or instance owner/admin via
  // ADMIN_ANY_WORKSPACE); the incoming route is any-session (self.session):
  // seeing what was shared with you needs no manage right.
  "/api/providers/[id]/grants": multiUser(
    scoped({
      cap: { GET: "workspace.grants.manage", POST: "workspace.grants.manage" },
      cliAllowed: false,
    }),
  ),
  "/api/providers/[id]/grants/[grantId]": multiUser(
    scoped({ cap: { DELETE: "workspace.grants.manage" }, cliAllowed: false }),
  ),
  "/api/grants": multiUser({ cap: SELF, cliAllowed: false }),
  "/api/provider-nodes": scoped(read(META, CONN)),
  "/api/provider-nodes/[id]": scoped({ cap: CONN }),
  "/api/provider-nodes/validate": { cap: CONN },
  // YAN-366: scoped — the guard asks for CONN in any workspace (remote members
  // manage their personal workspace); the handler enforces the target workspace.
  "/api/oauth/[provider]/[action]": scoped({ cap: CONN }),
  "/api/oauth/codex/bulk-import": scoped({ cap: CONN }),
  "/api/oauth/codex/import-token": scoped({ cap: CONN }),
  "/api/oauth/cursor/import": scoped({ cap: CONN }),
  "/api/oauth/gitlab/pat": scoped({ cap: CONN }),
  "/api/oauth/grok-cli/bulk-import": scoped({ cap: CONN }),
  "/api/oauth/iflow/cookie": scoped({ cap: CONN }),
  "/api/oauth/kiro/api-key": scoped({ cap: CONN }),
  "/api/oauth/kiro/import": scoped({ cap: CONN }),
  "/api/oauth/kiro/import-cli-proxy": scoped({ cap: CONN }),
  "/api/oauth/kiro/social-authorize": scoped({ cap: CONN }),
  "/api/oauth/kiro/social-exchange": scoped({ cap: CONN }),
  "/api/oauth/xiaomi-mimo/api-key": scoped({ cap: CONN }),
  "/api/media-providers/tts/voices": { cap: USE },
  "/api/media-providers/tts/deepgram/voices": scoped({ cap: USE }),
  "/api/media-providers/tts/elevenlabs/voices": scoped({ cap: USE }),
  "/api/media-providers/tts/inworld/voices": scoped({ cap: USE }),
  "/api/media-providers/tts/minimax/voices": scoped({ cap: USE }),

  // Combos, aliases, custom and disabled models.
  // YAN-364: workspace-scoped; the capabilities are unchanged (ADR-0002).
  "/api/combos": scoped(read(META, COMBOS)),
  "/api/combos/reorder": scoped({ cap: COMBOS }),
  "/api/combos/[id]": scoped(read(META, COMBOS)),
  "/api/combos/[id]/headroom": scoped({ cap: META }),
  "/api/combos/[id]/test": scoped({ cap: USE }),
  "/api/models": scoped(read(META, COMBOS)),
  "/api/models/alias": scoped(read(META, COMBOS)),
  "/api/models/custom": scoped(read(META, COMBOS)),
  "/api/models/disabled": scoped(read(META, COMBOS)),
  "/api/models/availability": scoped(read(META, USE)),
  "/api/models/test": { cap: USE },
  "/api/tags": { cap: META },

  // Gateway API keys. PATCH is the manager-only durable migration ack (spec214);
  // the gate uses the manage cap and the handler rechecks it live per workspace.
  "/api/keys": {
    cap: {
      GET: "workspace.keys.manage",
      POST: "workspace.keys.create",
      PATCH: "workspace.keys.manage",
    },
  },
  "/api/keys/[id]": { cap: "workspace.keys.manage" },
  // Exact static row: /api/keys/context must never borrow the [id] row.
  // Any live member (create is the least key capability) may read their own
  // metadata-only context; the handler rechecks everything against the DB.
  "/api/keys/context": { cap: "workspace.keys.create", scoped: true },

  // Usage and dashboard summaries. YAN-370: scoped — the handler narrows to
  // the caller's workspace (and own rows for members) via usage/scope.js.
  "/api/usage/[connectionId]": scoped({ cap: USAGE }),
  "/api/usage/[connectionId]/codex-reset-credits": scoped(read(USAGE, CONN)),
  "/api/usage/chart": scoped({ cap: USAGE }),
  "/api/usage/history": scoped({ cap: USAGE }),
  "/api/usage/last-activity": scoped({ cap: USAGE }),
  "/api/usage/logs": scoped({ cap: USAGE }),
  "/api/usage/providers": scoped({ cap: USAGE }),
  "/api/usage/request-details": scoped({ cap: USAGE }),
  "/api/usage/request-logs": scoped({ cap: USAGE }),
  "/api/usage/savings": scoped({ cap: USAGE }),
  "/api/usage/stats": scoped({ cap: USAGE }),
  "/api/usage/stream": scoped({ cap: USAGE }),
  "/api/home/live-routes": scoped({ cap: USAGE }),
  "/api/home/quota": scoped({ cap: USAGE }),
  "/api/home/summary": scoped({ cap: USAGE }),
  "/api/shell/summary": scoped({ cap: USAGE }),
  "/api/shell/savings-milestone": scoped({ cap: USAGE }),
  "/api/gateway/status": { cap: SELF },

  // YAN-376: audit log. Any-session gate (self.session): seeing the log
  // needs no manage right at the edge; the handler enforces the exact
  // workspace live (workspace owner/manager, or instance owner/admin via
  // oversight). Hidden (404) while the switch is off; never satisfiable by
  // single-user mode; session or the local CLI token (acts as owner).
  "/api/audit": multiUser({ cap: SELF, alwaysProtected: true }),

  // YAN-365: owner-only key rotation. Session or CLI token; the handler
  // rechecks instance.keys.rotate itself. Hidden (404) while off by
  // multiUserOnly, even on established encryption.
  "/api/settings/keys/rotate": multiUser({
    cap: { POST: "instance.keys.rotate" },
    alwaysProtected: true,
  }),
  // Not scoped: instance.keys.rotate is an owner-only instance capability; a
  // workspace-manager role must never reach this handler (no role bypass).
  "/api/workspaces/[id]/keys/rotate": multiUser({
    cap: { POST: "instance.keys.rotate" },
    alwaysProtected: true,
  }),
  // YAN-375: encrypted per-workspace export/import. Scoped: the guard asks
  // for the capability in any of the principal's workspaces; the handler
  // enforces the exact URL workspace (active membership + workspace OWNER
  // role only — not manager) and a same-request password re-auth of the
  // acting user. Hidden (404) while the switch is off; never satisfiable by
  // single-user mode or the local CLI token; requires a browser session.
  "/api/workspaces/[id]/export": multiUser(
    scoped({
      cap: { POST: "workspace.preferences.manage" },
      alwaysProtected: true,
      cliAllowed: false, // browser-only: session + own-password re-auth
    }),
  ),
  "/api/workspaces/[id]/import": multiUser(
    scoped({
      cap: { POST: "workspace.preferences.manage" },
      alwaysProtected: true,
      cliAllowed: false, // browser-only: session + own-password re-auth
    }),
  ),
};

// LLM API prefixes (boundary match). Middleware runs before next.config
// rewrites, so the root-level aliases need rows too.
export const GATEWAY_PREFIXES = Object.freeze([
  "/v1",
  "/v1beta",
  "/codex",
  "/responses",
  "/infill",
  "/api/v1",
  "/api/v1beta",
]);
const GATEWAY = Object.freeze({ cap: "gateway.use", gateway: true });

/**
 * Any /api/* path without a row (no route file: Next answers 404) gets the
 * strictest gate: local-only, session or CLI token, hostOps. Covers the old
 * bare-prefix near misses such as /api/shutdownX or /api/cli-tools/unknown.
 */
export const UNMAPPED = "unmapped";
const UNMAPPED_ROW = Object.freeze({ cap: HOST, localOnly: true, alwaysProtected: true });

// Segment kinds rank like Next's router: static before [param] before [...rest].
const rank = (seg) => (seg.startsWith("[...") ? 2 : seg.startsWith("[") ? 1 : 0);
const PATTERNS = Object.keys(ROUTE_POLICY)
  .filter((key) => key.includes("["))
  .map((key) => ({ key, segs: key.split("/").slice(1) }))
  .sort((a, b) => {
    for (let i = 0; i < Math.min(a.segs.length, b.segs.length); i++) {
      const d = rank(a.segs[i]) - rank(b.segs[i]);
      if (d) return d;
    }
    return b.segs.length - a.segs.length;
  });

function matches(segs, path) {
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith("[...")) return i < path.length;
    if (i >= path.length) return false;
    if (!segs[i].startsWith("[") && segs[i] !== path[i]) return false;
  }
  return segs.length === path.length;
}

/** Decoded path segments, or null when the path can't be decoded. */
function segmentsOf(pathname) {
  try {
    return String(pathname || "")
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** The row key for a path, `UNMAPPED`, or null when the path isn't an API path. */
function routeKey(pathname) {
  const segs = segmentsOf(pathname);
  if (!segs) return String(pathname).startsWith("/api") ? UNMAPPED : null;
  const clean = `/${segs.join("/")}`;
  // An encoded "/" or dot segment never names a static route: Next would serve
  // it through a dynamic param (or 404), so don't let it borrow another row.
  if (segs.some((s) => s.includes("/") || s === "." || s === "..")) {
    if (segs[0] === "api" || segs[0]?.startsWith("api/")) return UNMAPPED;
    return GATEWAY_PREFIXES.includes(`/${segs[0]}`) ? "gateway" : null;
  }
  if (GATEWAY_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`))) return "gateway";
  if (Object.hasOwn(ROUTE_POLICY, clean) && !clean.includes("[")) return clean;
  const hit = PATTERNS.find((p) => matches(p.segs, segs));
  if (hit) return hit.key;
  return segs[0] === "api" ? UNMAPPED : null;
}

/**
 * The policy for a request, or null for non-API paths (dashboard pages,
 * /skills, /login…), which dashboardGuard handles itself.
 * @param {string} pathname
 * @param {string} [method]
 * @returns {{ key: string, capability: string|null, public: boolean, gateway: boolean, localOnly: boolean, alwaysProtected: boolean, cliAllowed: boolean, scoped: boolean, passwordChange: boolean, multiUserOnly: boolean }|null}
 */
export function resolveRoutePolicy(pathname, method = "GET") {
  const key = routeKey(pathname);
  if (!key) return null;
  if (key === "gateway") return { key, ...flags(GATEWAY), capability: GATEWAY.cap };
  if (key === UNMAPPED) return { key, ...flags(UNMAPPED_ROW), capability: HOST };
  const row = ROUTE_POLICY[key];
  const m = String(method || "GET").toUpperCase();
  let capability = row.cap;
  if (capability && typeof capability === "object") {
    // HEAD runs the GET handler; any other unlisted method fails closed.
    capability = capability[m] ?? (m === "HEAD" ? capability.GET : null) ?? HOST;
  }
  const localOnly = row.localOnly === true && !row.remoteMethods?.includes(m);
  return { key, ...flags(row), localOnly, capability };
}

function flags(row) {
  return {
    public: row.public === true,
    gateway: row.gateway === true,
    localOnly: row.localOnly === true,
    alwaysProtected: row.alwaysProtected === true,
    cliAllowed: row.cliAllowed !== false,
    scoped: row.scoped === true,
    passwordChange: row.passwordChange === true,
    multiUserOnly: row.multiUserOnly === true,
  };
}
