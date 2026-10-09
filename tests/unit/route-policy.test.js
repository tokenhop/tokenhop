// YAN-357: the route → capability table. Every API route file and method has
// an explicit policy, the flags reproduce the pre-YAN-357 guard path lists
// exactly, and can() implements the ADR-0002 role matrix.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_PREFIXES,
  ROUTE_POLICY,
  UNMAPPED,
  resolveRoutePolicy,
} from "@/lib/auth/routePolicy";
import { CAPABILITIES, can } from "@/lib/users/principal.js";

const ROOT = path.resolve(__dirname, "../..");
const API = path.join(ROOT, "src/app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.js") out.push(p);
  }
  return out;
}

// [{ route: "/api/providers/[id]", sample: "/api/providers/x1", methods: [...] }]
const ROUTES = walk(API).map((file) => {
  const route = `/${path.relative(path.join(ROOT, "src/app"), path.dirname(file))}`;
  const src = fs.readFileSync(file, "utf8");
  const exported = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/g)) {
    exported.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of m[1].split(","))
      exported.add(
        name
          .trim()
          .split(/\s+as\s+/)
          .pop(),
      );
  }
  const sample = route.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1");
  return { route, sample, methods: METHODS.filter((m) => exported.has(m)) };
});

// The guard's path lists before YAN-357, frozen as the regression oracle.
const LEGACY = {
  publicApi: [
    "/api/health",
    "/api/init",
    "/api/locale",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/status",
    "/api/auth/oidc",
    "/api/auth/saml",
    "/api/settings/require-login",
  ],
  publicLlm: ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"],
  alwaysProtected: [
    "/api/shutdown",
    "/api/settings/database",
    "/api/version/shutdown",
    "/api/oauth/cursor/auto-import",
    "/api/oauth/kiro/auto-import",
  ],
  localOnly: [
    "/api/cli-tools/",
    "/api/mcp/",
    "/api/tunnel/tailscale-install",
    "/api/tunnel/tailscale-enable",
    "/api/tunnel/tailscale-disable",
    "/api/tunnel/tailscale-check",
    "/api/tunnel/enable",
    "/api/tunnel/disable",
    "/api/oauth/cursor/auto-import",
    "/api/oauth/kiro/auto-import",
    "/api/auth/reset-password",
    "/api/auth/setup-token",
    "/api/headroom/start",
    "/api/headroom/stop",
    "/api/headroom/proxy",
  ],
  remote: {
    "/api/cli-tools/cowork-mcp-registry": ["GET"],
    "/api/cli-tools/antigravity-mitm/alias": ["GET", "PUT"],
  },
};
const boundary = (list, p) => list.some((x) => p === x || p.startsWith(`${x}/`));

function legacyFlags(p, method) {
  const llm = boundary(LEGACY.publicLlm, p);
  return {
    localOnly: !LEGACY.remote[p]?.includes(method) && LEGACY.localOnly.some((x) => p.startsWith(x)),
    alwaysProtected: LEGACY.alwaysProtected.some((x) => p.startsWith(x)),
    gateway: llm,
    public: !llm && boundary(LEGACY.publicApi, p),
  };
}

// The SSO test probes were public in the old guard and checked their own auth
// (session or requireLogin=false), which is exactly the default-auth gate
// minus the CLI token: they moved into the table with cliAllowed: false.
const MOVED_TO_GUARD = new Set(["/api/auth/oidc/test", "/api/auth/saml/test"]);

// YAN-358 password routes did not exist pre-YAN-357, so the legacy oracle has
// no row for them; the table pins them stricter than the legacy default:
// alwaysProtected with no CLI token. Every historical row stays unchanged.
const YAN358_PASSWORD_ROUTES = new Set(["/api/auth/change-password", "/api/users/[id]/password"]);

// YAN-360 user routes intentionally session-only like the password endpoint:
// alwaysProtected with no CLI token.
const YAN360_USER_ROUTES = new Set([
  "/api/users",
  "/api/users/[id]",
  "/api/users/ownership-transfer",
  "/api/users/ownership-transfer/sso",
]);
// YAN-360 invitation management: scoped (not alwaysProtected), but the
// handlers accept only a browser session, so the CLI token is refused.
const YAN360_SESSION_ONLY_ROUTES = new Set([
  "/api/workspaces/[id]/invitations",
  "/api/workspaces/[id]/invitations/[inviteId]",
  // YAN-369 connection grants: browser session only.
  "/api/providers/[id]/grants",
  "/api/providers/[id]/grants/[grantId]",
  "/api/grants",
  // YAN-372 workspace and user budgets: browser session only.
  "/api/workspaces/[id]/budgets",
  "/api/workspaces/[id]/budgets/[budgetId]",
  "/api/users/[id]/budgets",
  "/api/users/[id]/budgets/[budgetId]",
  // YAN-371 account routes (workspace switch, linked identities).
  "/api/me/workspace",
  "/api/me/identities",
  "/api/me/identities/[id]",
]);
// YAN-371 account routes are alwaysProtected too (like the password routes):
// single-user mode never satisfies them, only a full browser session.
const YAN371_ACCOUNT_ROUTES = new Set([
  "/api/me/workspace",
  "/api/me/identities",
  "/api/me/identities/[id]",
]);
// YAN-372 user-level budgets: instance admin only, alwaysProtected.
const YAN372_USER_BUDGET_ROUTES = new Set([
  "/api/users/[id]/budgets",
  "/api/users/[id]/budgets/[budgetId]",
]);
// YAN-360 invite accept is new and public by design: the token is the
// authorization (still hidden with the switch off via multiUserOnly).
const YAN360_PUBLIC_ROUTES = new Set(["/api/invitations/accept"]);

// YAN-367 audit log did not exist pre-YAN-357; the table pins it stricter than
// the legacy default: alwaysProtected (owner/admin only, 404 with switch off).
const YAN367_AUDIT_ROUTES = new Set(["/api/audit"]);

// YAN-365 key rotation routes did not exist pre-YAN-357 either: owner only
// (instance.keys.rotate), alwaysProtected with the CLI token allowed (the
// local CLI uses it), 404 while the switch is off via multiUserOnly.
const YAN365_KEY_ROUTES = new Set([
  "/api/settings/keys/rotate",
  "/api/workspaces/[id]/keys/rotate",
]);

// YAN-375 workspace transfer routes are new too: hidden while the switch is
// off (multiUserOnly), never satisfiable by single-user mode.
const YAN375_TRANSFER_ROUTES = new Set([
  "/api/workspaces/[id]/export",
  "/api/workspaces/[id]/import",
]);

// YAN-366 tightened xiaomi-mimo/auto-import to match its cursor/kiro siblings
// (hostOps + loopback + alwaysProtected); the pre-YAN-357 guard did not list it.
const YAN366_TIGHTENED = new Set(["/api/oauth/xiaomi-mimo/auto-import"]);

describe("route coverage", () => {
  it("finds the API route files", () => {
    expect(ROUTES.length).toBeGreaterThan(150);
  });

  it("gives every route file and method an explicit policy", () => {
    const unmapped = [];
    for (const { route, sample, methods } of ROUTES) {
      expect(methods.length, `${route} exports no HTTP method`).toBeGreaterThan(0);
      for (const m of methods) {
        const policy = resolveRoutePolicy(sample, m);
        const own = policy?.key === route || policy?.key === "gateway";
        if (!own || policy.key === UNMAPPED) unmapped.push(`${m} ${route} → ${policy?.key}`);
        else if (!policy.public) expect(CAPABILITIES, `${m} ${route}`).toContain(policy.capability);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("has no rows for routes that don't exist (e.g. /api/cloud)", () => {
    const files = new Set(ROUTES.map((r) => r.route));
    expect(Object.keys(ROUTE_POLICY).filter((k) => !files.has(k))).toEqual([]);
    expect(Object.keys(ROUTE_POLICY).some((k) => k.startsWith("/api/cloud"))).toBe(false);
  });

  it("fails closed on unknown API paths and methods", () => {
    const unknown = resolveRoutePolicy("/api/does-not-exist", "GET");
    expect(unknown).toMatchObject({
      key: UNMAPPED,
      public: false,
      localOnly: true,
      alwaysProtected: true,
      capability: "instance.hostOps",
    });
    expect(resolveRoutePolicy("/api/providers", "TRACE").capability).toBe("instance.hostOps");
    expect(resolveRoutePolicy("/api/providers/%E0%A4%A", "GET").key).toBe(UNMAPPED);
    expect(resolveRoutePolicy("/dashboard/providers", "GET")).toBeNull();
    expect(resolveRoutePolicy("/skills/x", "GET")).toBeNull();
  });
});

describe("adversarial paths never get a weaker gate than the old guard", () => {
  // Paths with no route file: the old bare-prefix lists caught some of them;
  // now every one gets the strictest gate. Encoded separators and dot
  // segments never borrow a static row.
  const STRICT = { localOnly: true, alwaysProtected: true, public: false, gateway: false };
  for (const p of [
    "/api",
    "/api/shutdownX",
    "/api/settings/databaseX",
    "/api/cli-tools/unknown",
    "/api/mcp/foo",
    "/api/headroom/proxy",
    "/api/auth/oidcX",
    "/api/settings%2Fdatabase",
    "/api/settings/%2e%2e/database",
    "/api/v1/../settings",
    "/api/providers/a%2Fb",
  ]) {
    it(p, () => {
      for (const m of ["GET", "POST"]) expect(resolveRoutePolicy(p, m)).toMatchObject(STRICT);
    });
  }

  it("keeps trailing and doubled slashes on their own row", () => {
    expect(resolveRoutePolicy("/api/shutdown/", "POST").key).toBe("/api/shutdown");
    expect(resolveRoutePolicy("/api//cli-tools/claude-settings", "GET").localOnly).toBe(true);
    expect(resolveRoutePolicy("/%76%31/chat/completions", "POST").gateway).toBe(true);
    expect(resolveRoutePolicy("/v1/models/%2e%2e", "GET").gateway).toBe(true);
  });
});

describe("single-user regression: flags match the pre-YAN-357 guard", () => {
  it("for every route file and method", () => {
    const diffs = [];
    for (const { route, sample, methods } of ROUTES) {
      for (const m of [...methods, "HEAD"]) {
        const { localOnly, alwaysProtected, gateway, public: pub } = resolveRoutePolicy(sample, m);
        const want = legacyFlags(sample, m);
        if (MOVED_TO_GUARD.has(route)) want.public = false;
        if (YAN358_PASSWORD_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN360_USER_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN360_PUBLIC_ROUTES.has(route)) want.public = true;
        if (YAN367_AUDIT_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN375_TRANSFER_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN372_USER_BUDGET_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN371_ACCOUNT_ROUTES.has(route)) want.alwaysProtected = true;
        if (YAN366_TIGHTENED.has(route)) {
          want.localOnly = true;
          want.alwaysProtected = true;
        }
        if (YAN365_KEY_ROUTES.has(route)) {
          want.alwaysProtected = true;
          want.public = false;
          want.localOnly = false;
        }
        const got = { localOnly, alwaysProtected, gateway, public: pub };
        if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push({ m, route, got, want });
      }
    }
    expect(diffs).toEqual([]);
  });

  it("for the LLM API aliases that only exist as next.config rewrites", () => {
    for (const p of ["/v1", "/v1/chat/completions", "/v1/v1/models", "/v1beta/models/x"]) {
      expect(resolveRoutePolicy(p, "POST")).toMatchObject({ gateway: true, public: false });
    }
    for (const p of ["/codex/responses", "/responses", "/api/v1/unknown", "/infill"]) {
      expect(resolveRoutePolicy(p, "POST").gateway).toBe(true);
    }
    // Boundary match: a near-miss path must not borrow the gateway row.
    expect(resolveRoutePolicy("/infillx", "POST")).toBeNull();
    expect(GATEWAY_PREFIXES).toEqual(expect.arrayContaining(LEGACY.publicLlm));
  });

  it("keeps the CLI token for every authenticated route except the SSO probes", () => {
    for (const { route, sample } of ROUTES) {
      const { cliAllowed } = resolveRoutePolicy(sample, "GET");
      expect(cliAllowed, route).toBe(
        !MOVED_TO_GUARD.has(route) &&
          !YAN358_PASSWORD_ROUTES.has(route) &&
          !YAN360_USER_ROUTES.has(route) &&
          !YAN360_SESSION_ONLY_ROUTES.has(route) &&
          // YAN-375: browser-only workspace transfer routes (session + own
          // password re-auth); every other authenticated route keeps the CLI.
          !YAN375_TRANSFER_ROUTES.has(route),
      );
    }
  });
});

// ADR-0002 role → capability matrix. `x*` = in workspaces the account belongs
// to; `own` = only where it is a member; "any" = every workspace.
const INSTANCE = ["owner", "admin", "user", "pending"];
const WS = ["owner", "manager", "member", "viewer"];
const MATRIX = {
  "instance.users.manage": [["owner", "admin"], []],
  "instance.ownership.transfer": [["owner"], []],
  "instance.keys.rotate": [["owner"], []],
  "instance.hostOps": [["owner", "admin"], []],
  "instance.settings.manage": [["owner", "admin"], []],
  "instance.budgets.raise": [["owner", "admin"], []],
  "instance.audit.read": [["owner", "admin"], []],
  "workspace.members.manage": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
  "workspace.connections.manage": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
  "workspace.connections.use": [["own"], ["owner", "manager", "member"]],
  "workspace.connections.metadata.read": [
    ["owner", "admin"],
    ["owner", "manager"],
  ],
  "workspace.grants.manage": [
    ["owner", "admin"],
    ["owner", "manager"],
  ],
  "workspace.keys.create": [
    ["owner*", "admin*"],
    ["owner", "manager", "member"],
  ],
  "workspace.keys.manage": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
  "workspace.combos.manage": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
  "workspace.budgets.lower": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
  "workspace.budgets.read": [["owner", "admin"], WS],
  "workspace.usage.read": [["owner", "admin"], WS],
  "workspace.preferences.manage": [
    ["owner*", "admin*"],
    ["owner", "manager"],
  ],
};
const W = "ws-1";
const who = (instanceRole, wsRole) => ({
  userId: "u",
  instanceRole,
  workspaceIds: wsRole ? [W] : [],
  workspaceRoles: wsRole ? { [W]: wsRole } : {},
});

describe("ADR-0002 role → capability matrix", () => {
  it("covers every capability in the catalogue", () => {
    expect([...Object.keys(MATRIX), "gateway.use", "self.session"].sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });

  for (const [cap, [instance, ws]] of Object.entries(MATRIX)) {
    it(cap, () => {
      for (const role of INSTANCE) {
        // Outside any workspace: only plain instance grants (no * or own).
        expect(can(who(role), cap, { workspaceId: W }), `${role} non-member`).toBe(
          instance.includes(role),
        );
        if (cap.startsWith("instance.")) continue;
        for (const wsRole of WS) {
          const asMember =
            role !== "pending" &&
            (instance.includes(role) || instance.includes(`${role}*`) || ws.includes(wsRole));
          expect(can(who(role, wsRole), cap, { workspaceId: W }), `${role}/${wsRole}`).toBe(
            asMember,
          );
        }
      }
    });
  }

  it("denies pending, unknown capabilities and missing principals", () => {
    expect(can(who("pending", "owner"), "workspace.usage.read", { workspaceId: W })).toBe(false);
    expect(can(who("pending"), "self.session")).toBe(false);
    expect(can(who("owner"), "instance.nope")).toBe(false);
    expect(can(null, "self.session")).toBe(false);
    expect(can(who("user"), "self.session")).toBe(true);
    expect(can(who("user"), "gateway.use")).toBe(true);
  });

  it("never lets an admin use another user's personal-workspace connections", () => {
    expect(can(who("admin"), "workspace.connections.use", { workspaceId: W })).toBe(false);
    expect(can(who("admin"), "workspace.connections.manage", { workspaceId: W })).toBe(false);
  });

  it("keeps every instance.* route away from a user-role principal", () => {
    const member = who("user", "owner");
    for (const { route, sample, methods } of ROUTES) {
      for (const m of methods) {
        const { capability } = resolveRoutePolicy(sample, m);
        if (capability?.startsWith("instance.")) {
          expect(can(member, capability, { workspaceId: W }), `${m} ${route}`).toBe(false);
        }
      }
    }
  });
});

describe("inventory cleanups", () => {
  it("deletes the guard's path lists, including the dead PROTECTED_API_PATHS", () => {
    const guard = fs.readFileSync(path.join(ROOT, "src/dashboardGuard.js"), "utf8");
    expect(guard).not.toMatch(/PROTECTED_API_PATHS|LOCAL_ONLY_PATHS|PUBLIC_API_PATHS/);
  });

  it("drops the unused REQUIRE_API_KEY from .env.example", () => {
    expect(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")).not.toContain(
      "REQUIRE_API_KEY",
    );
  });
});

describe("YAN-366 oauth routes", () => {
  it("scopes every /api/oauth/* row except the host auto-imports", () => {
    const oauth = Object.entries(ROUTE_POLICY).filter(([k]) => k.startsWith("/api/oauth/"));
    expect(oauth.length).toBeGreaterThan(10);
    for (const [key, row] of oauth) {
      if (key.endsWith("/auto-import")) {
        expect(row, key).toMatchObject({ cap: "instance.hostOps", localOnly: true });
        expect(row.alwaysProtected, key).toBe(true);
      } else {
        expect(row.scoped, key).toBe(true);
      }
    }
  });
});

describe("YAN-365 key rotation routes", () => {
  it.each([["/api/settings/keys/rotate"], ["/api/workspaces/ws-1/keys/rotate"]])(
    "%s is owner-only, alwaysProtected and hidden while the switch is off",
    (p) => {
      const policy = resolveRoutePolicy(p, "POST");
      expect(policy).toMatchObject({
        capability: "instance.keys.rotate",
        multiUserOnly: true,
        alwaysProtected: true,
        public: false,
        gateway: false,
        scoped: false,
      });
      // Unlisted methods fail closed to hostOps rather than borrowing the owner cap.
      expect(resolveRoutePolicy(p, "GET").capability).toBe("instance.hostOps");
    },
  );

  it("only the owner holds instance.keys.rotate; admins and workspace managers do not", () => {
    expect(can({ instanceRole: "owner", workspaceIds: [] }, "instance.keys.rotate")).toBe(true);
    for (const role of ["admin", "user", "pending"]) {
      expect(can({ instanceRole: role, workspaceIds: [] }, "instance.keys.rotate")).toBe(false);
    }
    expect(
      can(
        { instanceRole: "user", workspaceIds: ["w"], workspaceRoles: { w: "manager" } },
        "instance.keys.rotate",
        { workspaceId: "w" },
      ),
    ).toBe(false);
  });
});
