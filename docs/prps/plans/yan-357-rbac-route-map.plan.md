# Plan: YAN-357 declarative route → capability map (RBAC)

## Summary

Replace the path lists in `src/dashboardGuard.js` with one declarative table,
`src/lib/auth/routePolicy.js`, that maps every `src/app/api/**/route.js` (and
method) to an ADR-0002 capability plus `public` / `gateway` / `localOnly` /
`alwaysProtected` / `cliAllowed` flags. Fill in `can(principal, capability,
resource)` with the ADR-0002 role matrix and add `authorize()` for handlers.
Switch off (`TOKENHOP_MULTI_USER`): byte-for-byte today's guard decisions.

## User Story

As the tokenhop maintainer, I want one table that says who may reach each API
route, so that Users & teams can enforce roles without scattered checks.

## Problem → Solution

Six path lists, deny-by-default "authenticated = admin", dead
`PROTECTED_API_PATHS`, owner-only `hasValidSession` stub → one route table,
capability check against the principal (switch on), today's gates unchanged
(switch off).

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A (Linear YAN-357, ADR-0002)
- **PRD Phase**: M1 Identity & sessions
- **Estimated Files**: ~14
- **Trunk landing**: ships anytime (behaviour-preserving with the switch off)

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-users-rbac-route-map/ (branch: users/yan-357-rbac-route-map)

## Batches

| Batch | Tasks         | Notes                           |
| ----- | ------------- | ------------------------------- |
| B1    | 1.1, 1.2, 1.3 | parallel, disjoint files        |
| B2    | 2.1           | guard refactor, needs 1.1 + 1.2 |
| B3    | 3.1           | tests + validation              |

---

## UX Design

### Before

N/A — internal change.

### After

N/A — internal change. Switch off: identical. Switch on: an authenticated
principal lacking the route's capability gets `403 {error:"Forbidden"}`.

### Interaction Changes

| Touchpoint                   | Before                              | After                                                 | Notes                    |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------- | ------------------------ |
| `/api/auth/{oidc,saml}/test` | public in guard, handler self-check | guard: `instance.settings.manage`, `cliAllowed:false` | same decision switch off |

## Mandatory Reading

| Priority | File                                      | Lines | Why                                                            |
| -------- | ----------------------------------------- | ----- | -------------------------------------------------------------- |
| P0       | `src/dashboardGuard.js`                   | all   | logic being replaced                                           |
| P0       | `src/lib/users/session.js`                | all   | principal, multiUserOn cache, hasValidSession stub             |
| P0       | `src/lib/users/principal.js`              | all   | `can` stub                                                     |
| P0       | `/tmp/opencode/yan357/route-inventory.md` | all   | per-route classes + capability proposal                        |
| P1       | `tests/unit/dashboard-guard.test.js`      | 1-80  | mocks, switch-off regression                                   |
| P1       | `tests/unit/principal-sessions.test.js`   | 1-130 | switch-on test pattern                                         |
| P1       | `tests/unit/tenancy-guard.test.js`        | 1-40  | fs walk pattern                                                |
| P2       | `tests/unit/gateway-status.test.js`       | 60-75 | reads `PUBLIC_API_PATHS` from source; must move to routePolicy |

## External Documentation

No external research needed (Next.js App Router route precedence: static segments beat dynamic, catch-all last).

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/lib/users/featureSwitch.js:41-44
export async function requireMultiUser() {
  if (await isMultiUserEnabled()) return null;
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
```

### ERROR_HANDLING

```js
// SOURCE: src/lib/users/session.js:102-110 — fail closed
  } catch {
    return false; // fail closed: a broken users table never admits anyone
  }
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/principal-sessions.test.js — switch on via env + resetModules
vi.resetModules();
process.env[ENV] = state;
s = await import("@/lib/users/session");
```

```js
// SOURCE: tests/unit/tenancy-guard.test.js:28-36 — fs walk
if (e.isDirectory()) walk(p, out);
else if (/\.(m?js|jsx)$/.test(e.name)) out.push(p);
```

---

## Files to Change

| File                                                                                                                 | Action | Justification                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `src/lib/auth/routePolicy.js`                                                                                        | CREATE | route table, capability catalogue, `resolveRoutePolicy(pathname, method)`                      |
| `src/lib/users/principal.js`                                                                                         | UPDATE | ADR-0002 matrix in `can`, `CAPABILITIES`, `workspaceRoles` typedef                             |
| `src/lib/users/session.js`                                                                                           | UPDATE | `workspaceRoles` on principal, `hasValidSession` any live session, `principalCan`, `authorize` |
| `src/dashboardGuard.js`                                                                                              | UPDATE | use routePolicy; delete all path lists                                                         |
| `src/app/api/auth/oidc/test/route.js`                                                                                | UPDATE | drop handler self-check (guard covers it)                                                      |
| `src/app/api/auth/saml/test/route.js`                                                                                | UPDATE | same                                                                                           |
| `.env.example`, `README.md`, `README.zh-CN.md`, `i18n/README.*.md`, `UPGRADING.md`, `gitbook/content/*/upgrading.md` | UPDATE | remove unused `REQUIRE_API_KEY`                                                                |
| `docs/ARCHITECTURE.md`                                                                                               | UPDATE | point auth section at routePolicy                                                              |
| `tests/unit/route-policy.test.js`                                                                                    | CREATE | coverage, legacy-oracle regression, matrix, cleanups                                           |
| `tests/unit/principal-sessions.test.js`                                                                              | UPDATE | non-owner sessions + guard capability checks (switch on)                                       |
| `tests/unit/db-tenancy-schema.test.js`                                                                               | UPDATE | `can` stub assertion → matrix                                                                  |
| `tests/unit/gateway-status.test.js`                                                                                  | UPDATE | read policy instead of guard source                                                            |

## NOT Building

- Workspace scoping of handlers (YAN-361+), gateway key principals (YAN-363), audit writes (YAN-367), UI hiding (YAN-371/373/376).
- Fixing today's inconsistent non-local-only host routes (pxpipe, headroom restart, xiaomi auto-import…): preserved, listed in the PR.
- Custom roles / ACL UI (ADR-0002 non-goal).

---

## Step-by-Step Tasks

### Task 1.1: `can` matrix — Depends on: none

- **ACTION**: Rewrite `src/lib/users/principal.js`.
- **IMPLEMENT**: Export `CAPABILITIES` (frozen list: ADR-0002 caps + `gateway.use` + `self.session`). Instance role sets: owner = all `instance.*`; admin = all `instance.*` except `instance.ownership.transfer`, `instance.keys.rotate`. Cross-workspace (owner/admin, any workspace): `workspace.connections.metadata.read`, `workspace.grants.manage`, `workspace.budgets.read`, `workspace.usage.read`. Member-wide (owner/admin, workspaces they belong to): `members.manage, connections.manage, keys.create, keys.manage, combos.manage, budgets.lower, preferences.manage`. Workspace roles: owner/manager = every `workspace.*`; member = `connections.use, keys.create, budgets.read, usage.read`; viewer = `budgets.read, usage.read`. `gateway.use`/`self.session`: any non-pending principal. `pending` → false always. Workspace caps need `resource.workspaceId`; role read from `principal.workspaceRoles[wid]`. Unknown capability → false.
- **MIRROR**: existing JSDoc typedef style.
- **GOTCHA**: pure, no imports (proxy bundle).
- **VALIDATE**: matrix test in Task 3.1.

### Task 1.2: routePolicy table — Depends on: none

- **ACTION**: Create `src/lib/auth/routePolicy.js`.
- **IMPLEMENT**: `ROUTE_POLICY` object keyed by route path as in the filesystem (`/api/providers/[id]`, `/api/headroom/proxy/[...path]`) plus gateway prefixes `"/v1/**"`, `"/v1beta/**"`, `"/codex/**"`, `"/responses/**"`, `"/api/v1/**"`, `"/api/v1beta/**"` (boundary match incl. the bare prefix). Entry: `{ cap: string | {GET:..., POST:...}, public?, gateway?, localOnly?, remoteMethods?: string[], alwaysProtected?, cliAllowed? (default true) }`. Export `resolveRoutePolicy(pathname, method)` → `{ key, capability, public, gateway, localOnly, alwaysProtected, cliAllowed }` or null when the path is not `/api/*` and no gateway prefix matches. Normalise pathname (safe `decodeURIComponent`, collapse `//+`, strip trailing `/`). Precedence: exact key, then compiled patterns sorted by static-segment count desc, catch-all last. Unmapped `/api/*` path or method → `UNMAPPED` policy: auth required, capability `instance.hostOps`. `localOnly` true except methods in `remoteMethods`. Use the inventory's classes verbatim; capabilities per inventory with these decisions: settings GET/PATCH, pricing, proxy-pools, settings/environment, settings/proxy-test, catalog-sync POST → `instance.settings.manage`; `auth/setup-token` → `instance.ownership.transfer`; `auth/{oidc,saml}/test` → `instance.settings.manage` + `cliAllowed:false`; `auth/logout-all`, `gateway/status` → `self.session`; `shell/*`, `home/*`, `usage/*` GET → `workspace.usage.read`; media-providers voices → `workspace.connections.use`.
- **GOTCHA**: AP routes: shutdown, version/shutdown, settings/database, oauth/{cursor,kiro}/auto-import (the last two also localOnly). Remote exceptions: `cli-tools/cowork-mcp-registry` GET, `cli-tools/antigravity-mitm/alias` GET PUT. `cli-tool-settings*`, `cli-tool-presets` NOT localOnly. Keep ≤500 lines; pure module (proxy bundle).
- **VALIDATE**: coverage + oracle tests in Task 3.1.

### Task 1.3: cleanups — Depends on: none

- **ACTION**: Remove `REQUIRE_API_KEY` (never read by code) from `.env.example`, env tables in `README.md`, `README.zh-CN.md`, `i18n/README.*.md`, and the "never had a brand name" sentence in `UPGRADING.md` + `gitbook/content/*/upgrading.md`. Update `docs/ARCHITECTURE.md` auth lines to name `src/lib/auth/routePolicy.js`.
- **GOTCHA**: leave historical changelog-style mentions in i18n READMEs alone.
- **VALIDATE**: `rg REQUIRE_API_KEY .env.example README.md` empty.

### Task 2.1: guard + session — Depends on: 1.1, 1.2

- **ACTION**: Refactor `src/dashboardGuard.js`, extend `src/lib/users/session.js`.
- **IMPLEMENT**: session.js: `principalFor` adds `workspaceRoles`; `hasValidSession` → any live session (drop owner-only ponytail); new `principalCan(request, capability)` — switch off → true; else resolve principal; null principal → true only when zero active users (pre-bootstrap sole admin), else false; workspace caps checked against the Default workspace (`getMeta("defaultWorkspaceId")`, cached once non-null) because today's unscoped data lives there (ponytail: handlers take over per-resource checks via `authorize` once YAN-361+ scope data); fail closed on throw. New `authorize(capability, resource)` for handlers: switch off → null; else 401/403 JSON unless `can(await getPrincipal(), capability, resource)`. Guard: `policy = resolveRoutePolicy(pathname, method)`; if policy: localOnly gate (cli only if `cliAllowed`) → 403 LOCAL_ONLY; public → next; gateway → today's `canAccessPublicLlmApi`; auth = alwaysProtected ? cli||session : cli||isAuthenticated → 401; `principalCan` false → 403 `{error:"Forbidden"}`; next. Non-policy paths: `/skills`, `/dashboard`, `/` logic unchanged. Remove handler self-check from oidc/saml test routes. Keep `isLocalRequest` export and `__test__`.
- **GOTCHA**: Order today: public page, LO, AP, PL, PA, DA — keep LO before public/gateway. Guard tests mock featureSwitch off — no DB hits on the switch-off path.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/dashboard-guard.test.js tests/unit/local-request-peer-trust-3294.test.js` green unchanged.

### Task 3.1: tests — Depends on: 2.1

- **ACTION**: Create `tests/unit/route-policy.test.js`; update principal-sessions, db-tenancy-schema, gateway-status tests.
- **IMPLEMENT**: (a) coverage: walk `src/app/api`, every `route.js` + exported method (incl. `export {..} from` and `export const`) resolves (sample path: `[x]`→`x1`, `[...x]`→`a/b`) to a non-UNMAPPED policy whose capability is in `CAPABILITIES` or public; every table key matches a route file or is a gateway prefix. (b) legacy oracle: frozen copies of today's lists in the test; for every route+method, new flags == legacy classification (documented exception: oidc/saml test). (c) matrix: ADR-0002 table literal × roles vs `can`. (d) `user` principal denied every `instance.*` policy. (e) cleanups: no `/api/cloud` keys, guard source has no `_PATHS = [`, `.env.example` lacks `REQUIRE_API_KEY`. principal-sessions: B's session now valid; guard `proxy()` with B → 403 on `/api/providers`, `/api/settings`, `/api/tunnel/status`; A → next; legacy and CLI still pass.
- **VALIDATE**: full gate below.

---

## Testing Strategy

### Unit Tests

| Test            | Input                     | Expected Output    | Edge Case?                 |
| --------------- | ------------------------- | ------------------ | -------------------------- |
| coverage        | every route file × method | explicit policy    | yes: re-exports, catch-all |
| oracle          | every route × method      | legacy class equal | yes: LO+AP stacking        |
| matrix          | caps × 8 roles            | ADR-0002 table     | yes: `x*`, `own†`, pending |
| switch-on guard | B session on admin routes | 403                | yes                        |

## Validation Commands

```bash
npm run lint
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run build
npm run lint:brand
```

## Acceptance Criteria

- Every API route has an explicit policy (test-enforced).
- A `user`-role principal can't reach any `instance.*` route.
- Single-user behaviour unchanged (oracle + existing guard suites).

## Completion Checklist

- [ ] all tasks done, gate green both switch states, build + brand guard green
- [ ] PR with Closes YAN-357 / Closes #224, Decisions, Isolation matrix, Verification evidence

## Risks

| Risk                                              | Mitigation                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Static vs dynamic precedence mismatch             | coverage test resolves each file's own sample path to its own key              |
| Switch-on non-owner reaching unscoped global data | workspace caps checked against Default workspace (owner-only membership today) |
| Pre-bootstrap lockout                             | null principal allowed only with zero active users                             |

## Notes

Decisions are recorded in the PR body (Decisions section).
