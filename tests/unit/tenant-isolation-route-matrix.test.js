// YAN-378: real proxy/session/capability decisions; independent route-class
// and role tables. This edge audit does not replace per-resource handler checks.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Only rollout reader is mutable; session, CLI policy, route policy and can()
// stay real. Never import those policies into the expected-decision oracle.
const rollout = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: async () => rollout.on,
}));

const ROOT = path.resolve(__dirname, "../..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name === "route.js" ? [file] : [];
  });
}
const INVENTORY = walk(path.join(ROOT, "src/app/api"))
  .sort()
  .flatMap((file) => {
    const route = `/${path.relative(path.join(ROOT, "src/app"), path.dirname(file))}`;
    const source = fs.readFileSync(file, "utf8");
    const exports = new Set();
    for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/g))
      exports.add(match[1]);
    for (const match of source.matchAll(/export\s*\{([^}]*)\}/g))
      for (const name of match[1].split(","))
        exports.add(
          name
            .trim()
            .split(/\s+as\s+/)
            .pop(),
        );
    if (exports.has("GET")) exports.add("HEAD"); // Next-generated GET companion
    if (!METHODS.some((method) => exports.has(method))) throw new Error(`No methods: ${route}`);
    return METHODS.filter((method) => exports.has(method)).map((method) => ({
      route,
      method,
      sample: route.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1"),
    }));
  });

// Rewrites exercise the edge before Next rewrites: duplicate every /v1 and
// /v1beta management cell at its root alias. Synthetic gateway OPTIONS cover
// anonymous preflight gating, not downstream CORS/handler behavior.
for (const cell of [...INVENTORY]) {
  if (/^\/api\/v1(?:beta)?(?:\/|$)/.test(cell.route)) {
    INVENTORY.push({ ...cell, route: cell.route.slice(4), sample: cell.sample.slice(4) });
  }
}
for (const route of ["/codex/x", "/responses", "/infill", "/v1/v1/chat/completions"])
  for (const method of ["POST", "HEAD", "OPTIONS"])
    INVENTORY.push({ route, sample: route, method });
for (const route of new Set(
  INVENTORY.filter((c) => /^\/(?:api\/)?v1/.test(c.route)).map((c) => c.route),
)) {
  if (!INVENTORY.some((c) => c.route === route && c.method === "OPTIONS"))
    INVENTORY.push({
      route,
      sample: route.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1"),
      method: "OPTIONS",
    });
}

// Independently frozen route classes. New management routes must be assigned
// explicitly; no default class that silently grants access. GET/write splits
// below are declarations, not reads of ROUTE_POLICY/resolveRoutePolicy.
const GROUPS = {
  public: `health init locale settings/require-login auth/login auth/logout auth/status
    auth/oidc/start auth/oidc/callback auth/saml/start auth/saml/acs auth/saml/metadata`,
  self: `auth/logout-all me/preferences gateway/status`,
  settings: `settings settings/environment settings/proxy-test pricing proxy-pools
    proxy-pools/[id] proxy-pools/[id]/test proxy-pools/cloudflare-deploy
    proxy-pools/deno-deploy proxy-pools/vercel-deploy auth/oidc/test auth/saml/test`,
  host: `shutdown version/shutdown settings/database settings/config/export settings/config/import
    cli-tool-presets cli-tool-settings cli-tool-settings/[toolId]
    headroom/restart headroom/extras headroom/status pxpipe/health pxpipe/install pxpipe/logs
    pxpipe/restart pxpipe/start pxpipe/stats pxpipe/status pxpipe/stop
    translator/console-logs translator/console-logs/stream translator/load translator/save
    translator/send translator/translate tunnel/status
    auth/reset-password cli-tools/all-statuses cli-tools/antigravity-mitm
    cli-tools/antigravity-mitm/alias cli-tools/claude-settings cli-tools/cline-settings
    cli-tools/codex-settings cli-tools/copilot-settings cli-tools/cowork-mcp-registry
    cli-tools/cowork-mcp-tools cli-tools/cowork-settings cli-tools/deepseek-tui-settings
    cli-tools/devin-settings cli-tools/droid-settings cli-tools/grok-build-settings
    cli-tools/hermes-settings cli-tools/jcode-settings cli-tools/kilo-settings
    cli-tools/openclaw-settings cli-tools/opencode-settings mcp/[plugin]/message mcp/[plugin]/sse
    headroom/start headroom/stop headroom/proxy/[...path] tunnel/enable tunnel/disable
    tunnel/tailscale-check tunnel/tailscale-enable tunnel/tailscale-disable tunnel/tailscale-install
    oauth/cursor/auto-import oauth/kiro/auto-import oauth/xiaomi-mimo/auto-import`,
  owner: `auth/setup-token auth/reset-mode users/ownership-transfer users/ownership-transfer/sso
    settings/keys/rotate workspaces/[id]/keys/rotate`,
  admin: `users users/[id] users/[id]/password users/[id]/logout-all workspaces workspaces/[id]
    workspaces/[id]/reauth users/[id]/budgets users/[id]/budgets/[budgetId] auth/sso/preview`,
  session: `auth/change-password me/workspace me/identities me/identities/[id]
    me/sessions me/sessions/[id] me/reauth grants audit`,
  members: `workspaces/[id]/members workspaces/[id]/members/[userId]
    workspaces/[id]/invitations workspaces/[id]/invitations/[inviteId]`,
  grants: `providers/[id]/grants providers/[id]/grants/[grantId]`,
  connReadWrite: `providers providers/[id] provider-nodes`,
  connManage: `providers/[id]/billing-probe providers/validate provider-nodes/[id]
    oauth/[provider]/[action] oauth/codex/bulk-import oauth/codex/import-token oauth/cursor/import
    oauth/gitlab/pat oauth/grok-cli/bulk-import oauth/iflow/cookie oauth/kiro/api-key
    oauth/kiro/import oauth/kiro/import-cli-proxy oauth/kiro/social-authorize
    oauth/kiro/social-exchange oauth/xiaomi-mimo/api-key workspaces/[id]/move`,
  connManageDefault: `provider-nodes/validate`,
  metadata: `providers/[id]/models providers/client combos/[id]/headroom`,
  metadataDefault: `providers/kilo/free-models providers/suggested-models tags`,
  use: `providers/[id]/test providers/[id]/test-models providers/test-batch combos/[id]/test
    media-providers/tts/deepgram/voices media-providers/tts/elevenlabs/voices
    media-providers/tts/inworld/voices media-providers/tts/minimax/voices`,
  useDefault: `media-providers/tts/voices models/test`,
  comboReadWrite: `combos combos/[id] models models/alias models/custom models/disabled`,
  combos: `combos/reorder`,
  modelAvailability: `models/availability`,
  catalog: `models/catalog-sync`,
  keyCollection: `keys`,
  keyCreate: `keys/context`,
  keyManage: `keys/[id]`,
  usage: `usage/[connectionId] usage/chart usage/history usage/last-activity usage/logs
    usage/providers usage/request-details usage/request-logs usage/savings usage/stats usage/stream
    home/live-routes home/quota home/summary shell/summary shell/savings-milestone`,
  usageReadWrite: `usage/[connectionId]/codex-reset-credits`,
  preferencesReadWrite: `workspaces/[id]/settings`,
  preferences: `workspaces/[id]/export workspaces/[id]/import`,
  budgetsReadWrite: `workspaces/[id]/budgets`,
  budgetLower: `workspaces/[id]/budgets/[budgetId]`,
  invite: `invitations/accept`,
};
const classes = new Map();
for (const [category, routes] of Object.entries(GROUPS)) {
  for (const route of routes.trim().split(/\s+/)) {
    const full = `/api/${route}`;
    if (classes.has(full)) throw new Error(`Duplicate oracle row: ${full}`);
    classes.set(full, category);
  }
}
const set = (routes) =>
  new Set(
    routes
      .trim()
      .split(/\s+/)
      .map((route) => `/api/${route}`),
  );
// Independently declared: routes whose edge answers per exact URL workspace.
const MEMBERS_ROUTES = set(`workspaces/[id]/members workspaces/[id]/members/[userId]
  workspaces/[id]/invitations workspaces/[id]/invitations/[inviteId]`);
const HIDDEN = set(`auth/reset-mode users users/[id] users/[id]/password users/[id]/logout-all
  users/ownership-transfer users/ownership-transfer/sso users/[id]/budgets users/[id]/budgets/[budgetId]
  workspaces workspaces/[id] workspaces/[id]/reauth auth/sso/preview
  workspaces/[id]/members workspaces/[id]/members/[userId] workspaces/[id]/invitations
  workspaces/[id]/invitations/[inviteId] workspaces/[id]/move workspaces/[id]/budgets
  workspaces/[id]/budgets/[budgetId] invitations/accept providers/[id]/grants
  providers/[id]/grants/[grantId] grants me/workspace me/identities me/identities/[id]
  me/sessions me/sessions/[id] me/reauth audit settings/keys/rotate workspaces/[id]/keys/rotate workspaces/[id]/export workspaces/[id]/import`);
const ALWAYS = set(`shutdown version/shutdown settings/database oauth/cursor/auto-import
  oauth/kiro/auto-import oauth/xiaomi-mimo/auto-import auth/change-password auth/reset-mode
  users users/[id] users/[id]/password users/[id]/logout-all users/ownership-transfer
  users/ownership-transfer/sso workspaces workspaces/[id] workspaces/[id]/reauth auth/sso/preview
  workspaces/[id]/members workspaces/[id]/members/[userId] users/[id]/budgets users/[id]/budgets/[budgetId]
  me/workspace me/identities me/identities/[id] me/sessions me/sessions/[id] me/reauth audit settings/keys/rotate
  workspaces/[id]/keys/rotate workspaces/[id]/export workspaces/[id]/import`);
const NO_CLI = set(`auth/oidc/test auth/saml/test auth/change-password users/ownership-transfer/sso
  users/[id]/logout-all workspaces/[id] workspaces/[id]/reauth auth/sso/preview
  workspaces/[id]/invitations workspaces/[id]/invitations/[inviteId] providers/[id]/grants
  providers/[id]/grants/[grantId] grants workspaces/[id]/budgets workspaces/[id]/budgets/[budgetId]
  workspaces/[id]/move users/[id]/budgets users/[id]/budgets/[budgetId] me/workspace
  me/identities me/identities/[id] me/sessions me/sessions/[id] me/reauth workspaces/[id]/export
  workspaces/[id]/import`);
const LOCAL = set(`auth/reset-password auth/reset-mode auth/setup-token mcp/[plugin]/message
  mcp/[plugin]/sse headroom/start headroom/stop headroom/proxy/[...path]
  tunnel/enable tunnel/disable tunnel/tailscale-check tunnel/tailscale-enable
  tunnel/tailscale-disable tunnel/tailscale-install oauth/cursor/auto-import
  oauth/kiro/auto-import oauth/xiaomi-mimo/auto-import`);
const REMOTE_METHODS = {
  "/api/cli-tools/antigravity-mitm/alias": ["GET", "PUT"],
  "/api/cli-tools/cowork-mcp-registry": ["GET"],
};

function category({ route, method }) {
  if (
    /^\/(?:api\/)?v1(?:beta)?(?:\/|$)/.test(route) ||
    /^\/(?:codex|responses|infill)(?:\/|$)/.test(route)
  )
    return "gateway";
  const kind = classes.get(route);
  if (!kind) throw new Error(`Missing independent oracle: ${method} ${route}`);
  const read = method === "GET" || method === "HEAD";
  return (
    {
      connReadWrite: read ? "metadata" : "connManage",
      comboReadWrite: read ? "metadata" : "combos",
      modelAvailability: read ? "metadata" : "use",
      catalog: read ? "metadataDefault" : "settings",
      keyCollection: read || method === "POST" ? "keyCreate" : "keyManage",
      usageReadWrite: read ? "usage" : "connManage",
      preferencesReadWrite: read ? "use" : "preferences",
      budgetsReadWrite: read ? "budgetRead" : "budgetLower",
    }[kind] ?? kind
  );
}
// Explicit capability-category × principal grants for fixture below. Owner and
// CLI own Default; admin owns only personal workspace; plain user owns personal
// plus Default member. Named workspace roles have ONLY Default membership, so
// their scoped results exercise that role rather than personal-owner fallback.
const ALL = ["owner", "admin", "user", "manager", "member", "viewer", "cli"];
const MANAGE = ["owner", "admin", "user", "manager", "cli"];
const GRANTS = {
  public: ALL,
  invite: ALL,
  self: ALL,
  session: ALL,
  host: ["owner", "admin", "cli"],
  settings: ["owner", "admin", "cli"],
  owner: ["owner", "cli"],
  admin: ["owner", "admin", "cli"],
  members: MANAGE,
  grants: MANAGE,
  connManage: MANAGE,
  metadata: MANAGE,
  combos: MANAGE,
  keyManage: MANAGE,
  preferences: MANAGE,
  budgetLower: MANAGE,
  budgetRead: ALL,
  usage: ALL,
  use: ["owner", "admin", "user", "manager", "member", "cli"],
  keyCreate: ["owner", "admin", "user", "manager", "member", "cli"],
  metadataDefault: ["owner", "admin", "manager", "cli"],
  connManageDefault: ["owner", "manager", "cli"],
  useDefault: ["owner", "user", "manager", "member", "cli"],
};
const PRINCIPALS = [
  "owner",
  "admin",
  "user",
  "pending",
  "manager",
  "member",
  "viewer",
  "keyUser",
  "keyService",
  "cli",
  "singleUser",
  "unauthenticated",
];
const MODES = [
  { name: "on-established", on: true, established: true },
  { name: "off-established", on: false, established: true },
  { name: "off-pristine", on: false, established: false },
];
function expected(cell, principal, local, mode) {
  const kind = category(cell);
  if (HIDDEN.has(cell.route) && !mode.on) return 404;
  const single = principal === "singleUser" && !mode.established;
  const session =
    ["owner", "admin", "user", "manager", "member", "viewer"].includes(principal) ||
    (principal === "pending" && !mode.established);
  const cli = principal === "cli" && !NO_CLI.has(cell.route) && (local || !mode.established);
  const localOnly =
    LOCAL.has(cell.route) ||
    (cell.route.startsWith("/api/cli-tools/") &&
      !REMOTE_METHODS[cell.route]?.includes(cell.method));
  if (localOnly && !(cli || (local && (session || single)))) return 403;
  if (kind === "public" || kind === "invite") return 200;
  if (kind === "gateway") return local || cli || principal.startsWith("key") ? 200 : 401;
  if (!(cli || session || (single && !ALWAYS.has(cell.route)))) return 401;
  if (!mode.established) return 200;
  // YAN-360 spec219: members and invitations routes sample foreign workspace
  // x1. Instance admin/owner pass to the handler (the owner CLI only where the
  // route admits it: NO_CLI invitations already answered 401 above); every
  // other principal is a non-member there, so the hidden answer is 404.
  if (MEMBERS_ROUTES.has(cell.route)) {
    if (["owner", "admin", "cli"].includes(principal)) return 200;
    if (["user", "manager", "member", "viewer"].includes(principal)) return 404;
  }
  return GRANTS[kind].includes(principal) ? 200 : 403;
}

let adapter;
let db;
let proxy;
let cliToken;
const tokens = {};
const keyTokens = { keyUser: `th_${"U".repeat(32)}`, keyService: `th_${"S".repeat(32)}` };
const envNames = ["TOKENHOP_MASTER_KEY", "TOKENHOP_PEER_TOKEN", "TOKENHOP_MULTI_USER"];
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const master = Buffer.alloc(32, 37);
let hashKid;
let schema;

const isolatedDataDir = process.env.DATA_DIR;
async function seed(mode) {
  // Separate stores: no simulated downgrade/reseed of durable security markers.
  fs.mkdirSync(isolatedDataDir, { recursive: true });
  process.env.DATA_DIR = fs.mkdtempSync(path.join(isolatedDataDir, "route-matrix-"));
  vi.resetModules();
  rollout.on = false;
  process.env.TOKENHOP_MASTER_KEY = master.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "matrix-peer";
  // Clear env override before lazy bootstrap imports; mocked reader is authority.
  delete process.env.TOKENHOP_MULTI_USER;
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  schema = await import("@/lib/db/schema.js");
  const { deriveApiKeyHashKey, hashApiKey, masterKeyId } = await import(
    "@/lib/security/masterKey.js"
  );
  const { insertHashedApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
  hashKid = masterKeyId(master);
  await db.updateSettings({ requireLogin: true });
  const now = new Date().toISOString();
  for (const principal of ["owner", "admin", "user", "pending", "manager", "member", "viewer"]) {
    const role = ["owner", "admin", "pending"].includes(principal) ? principal : "user";
    adapter.run(
      `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt)
      VALUES (?, ?, 'active', ?, ?)`,
      [principal, role, now, now],
    );
    if (!mode.established && principal !== "owner")
      adapter.run("UPDATE users SET status = 'disabled' WHERE id = ?", [principal]);
  }
  for (const [id, kind] of [
    ["default", "shared"],
    ["admin-personal", "personal"],
    ["user-personal", "personal"],
  ]) {
    adapter.run(`INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?,?,?,?,?)`, [
      id,
      id,
      kind,
      now,
      now,
    ]);
  }
  for (const [user, workspace, role] of [
    ["owner", "default", "owner"],
    ["admin", "admin-personal", "owner"],
    ["user", "user-personal", "owner"],
    ["user", "default", "member"],
    ["manager", "default", "manager"],
    ["member", "default", "member"],
    ["viewer", "default", "viewer"],
  ]) {
    adapter.run(`INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?,?,?,?)`, [
      workspace,
      user,
      role,
      now,
    ]);
  }
  await db.setMeta("defaultWorkspaceId", "default");
  if (mode.established) {
    adapter.exec("DROP TABLE apiKeys");
    adapter.exec(schema.buildCreateTableSql("apiKeys", schema.HASHED_API_KEYS_TABLE));
    await db.setMeta("apiKeysHashedVersion", "1");
    await db.setMeta("apiKeysHashKid", hashKid);
    for (const [principal, raw] of Object.entries(keyTokens)) {
      insertHashedApiKeySync(adapter, {
        id: principal,
        workspaceId: "default",
        userId: principal === "keyUser" ? "user" : null,
        createdByUserId: "owner",
        keyHash: hashApiKey(raw, deriveApiKeyHashKey(master)),
        hashKid,
        prefix: "th_test",
        name: principal,
        legacy: 0,
        isActive: 1,
        createdAt: now,
      });
    }
  } else {
    for (const [id, raw] of Object.entries(keyTokens))
      adapter.run("INSERT INTO apiKeys(id,key,name,isActive,createdAt) VALUES (?,?,?,1,?)", [
        id,
        raw,
        id,
        now,
      ]);
  }
  const jwt = await import("@/lib/auth/dashboardSession.js");
  for (const principal of ["owner", "admin", "user", "pending", "manager", "member", "viewer"]) {
    const user = await db.getUserUnscoped(principal);
    tokens[principal] = await jwt.createDashboardAuthToken({
      sub: user.id,
      sv: user.sessionVersion,
    });
  }
  // Prove key fixtures resolve before auditing proxy (no expected-policy use).
  const { resolveApiKey } = await import("@/lib/auth/apiKeyPrincipal.js");
  if (mode.established)
    for (const raw of Object.values(keyTokens)) expect(await resolveApiKey(raw)).not.toBeNull();
  ({ proxy } = await import("../../src/dashboardGuard.js"));
  cliToken = await (await import("@/lib/auth/cliToken.js")).getCliToken();
  rollout.on = mode.on;
  assertFixture(mode);
}
afterAll(() => {
  process.env.DATA_DIR = isolatedDataDir;
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function request(cell, principal, local) {
  const headers = new Headers({ host: local ? "localhost" : "router.example.test" });
  if (local) {
    headers.set("x-9r-peer-token", "matrix-peer");
    headers.set("x-9r-real-ip", "127.0.0.1");
    headers.set("origin", "http://localhost");
  }
  if (tokens[principal]) headers.set("cookie", `auth_token=${tokens[principal]}`);
  if (keyTokens[principal]) headers.set("authorization", `Bearer ${keyTokens[principal]}`);
  if (principal === "cli") headers.set("x-tokenhop-cli-token", cliToken);
  return new NextRequest(`http://localhost${cell.sample}`, { method: cell.method, headers });
}
function assertFixture(mode) {
  const n = adapter.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n;
  expect(n).toBe(mode.established ? 7 : 1);
  const cols = adapter.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
  expect(cols.includes("keyHash")).toBe(mode.established);
  expect(cols.includes("key")).toBe(!mode.established);
  expect(
    adapter.get("SELECT value FROM _meta WHERE key = 'apiKeysHashedVersion'")?.value ?? null,
  ).toBe(mode.established ? "1" : null);
  expect(adapter.get("SELECT value FROM _meta WHERE key = 'apiKeysHashKid'")?.value ?? null).toBe(
    mode.established ? hashKid : null,
  );
}
async function configure(mode, principal) {
  rollout.on = mode.on;
  assertFixture(mode);
  await db.updateSettings({ requireLogin: principal !== "singleUser" });
}

// Evaluate every cell, including thrown exceptions, before asserting report.
async function checkCells(cells, principal, local, mode) {
  const mismatches = [];
  for (const cell of cells) {
    const label = `${cell.method} ${cell.route}`;
    try {
      const response = await proxy(request(cell, principal, local));
      const want = expected(cell, principal, local, mode);
      if (response.status !== want)
        mismatches.push(`${label}: ${response.status}, expected ${want}`);
      if (response.status === 200 && response.headers.get("x-middleware-next") !== "1")
        mismatches.push(`${label}: missing pass-through header`);
      if (response.status === 404) {
        const hiddenBody =
          mode.on && MEMBERS_ROUTES.has(cell.route)
            ? '{"error":"Workspace not found","code":"not_found"}'
            : '{"error":"Not found"}';
        if (JSON.stringify(await response.json()) !== hiddenBody)
          mismatches.push(`${label}: unexpected hidden body`);
      }
    } catch (err) {
      mismatches.push(`${label}: threw ${err.message}`);
    }
  }
  expect(mismatches).toEqual([]);
}

it("inventory matches independent management declarations", () => {
  const routes = new Set(INVENTORY.map((cell) => cell.route));
  expect(routes.size).toBeGreaterThan(150);
  expect(INVENTORY.length).toBeGreaterThan(300);
  for (const cell of INVENTORY) {
    expect(category(cell)).toBeTruthy();
    if (/^\/api\/v1beta(?:\/|$)/.test(cell.route))
      expect(
        INVENTORY.some(
          (alias) => alias.route === cell.route.slice(4) && alias.method === cell.method,
        ),
      ).toBe(true);
  }
  expect([...classes.keys()].filter((route) => !routes.has(route))).toEqual([]);
});

for (const mode of MODES) {
  describe(mode.name, () => {
    beforeAll(async () => seed(mode));
    for (const principal of PRINCIPALS) {
      for (const local of [false, true]) {
        it(`${principal} ${local ? "direct-local" : "remote"}`, async () => {
          await configure(mode, principal);
          await checkCells(INVENTORY, principal, local, mode);
        }, 60000);
      }
    }
  });
}
