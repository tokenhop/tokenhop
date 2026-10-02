# Plan: Intercept tools — full remote procedure and remote model mapping (YAN-622)

## Summary

A remote dashboard (any non-loopback host) shows only `127.0.0.1 <host>` lines for the
intercept (MITM) tools, and blocks MITM model-alias mapping although it is plain server
state. This change opens the alias route to authenticated remote users, drops the
"DNS must be on" gate on alias writes, shows one ordered remote procedure on both
`/dashboard/cli-tools` and `/dashboard/mitm`, renders the per-tool mapping cards remotely
(DNS controls hidden), and deletes the dead `AntigravityToolCard.js`.

## User Story

As a user opening the dashboard remotely, I want the complete intercept setup steps and
the ability to map IDE models to my providers, so that hosts lines actually reroute
traffic instead of passing it through unchanged.

## Problem → Solution

Remote: hosts lines only, contradictory "turn DNS on from the host" copy, alias mapping
403 `LOCAL_ONLY` and additionally gated on DNS → Remote: ordered procedure (host server,
CA trust, hosts/DNS, model mapping, restart IDE), alias GET/PUT allowed with dashboard
auth, mapping editable regardless of DNS, dead card removed.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-622, GitHub #502, parent YAN-616)
- **PRD Phase**: N/A
- **Estimated Files**: 11
- **Target release**: `v1.0.0` → base/PR `master`, no backport (RELEASING.md "Feature, refactor…").
- **Switch**: none needed — every change is complete and safe to ship as-is.

---

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/yan-622-intercept-remote/ (branch: feat/yan-622-intercept-remote-steps)

## Batches

| Batch | Tasks    | Notes                                      |
| ----- | -------- | ------------------------------------------ |
| 1     | 1.1, 1.2 | Disjoint files; run in parallel            |
| 2     | 2.1      | Validation (lint, brand guard, unit tests) |

---

## UX Design

### Before

```
/dashboard/cli-tools (remote)            /dashboard/mitm (remote)
Intercept tools                          [warn] MITM intercepts HTTPS…
"only work when IDE on same machine…     [lock] CLI tools require local access
 Turn DNS on from the dashboard…"        (nothing else)
[Antigravity] 127.0.0.1 …
[Kiro]        127.0.0.1 …
```

### After

```
/dashboard/cli-tools (remote)            /dashboard/mitm (remote)
Intercept tools                          [warn] MITM intercepts HTTPS…
Set up from a remote dashboard:          Set up from a remote dashboard:
 1 On the host: start MITM server        (same ordered steps)
 2 Trust the root CA on the host         [Antigravity ▾] hosts lines + model mappings
 3 Hosts: Start DNS on host, or add      [Kiro ▾]        hosts lines + model mappings
   the lines below by hand                (no DNS Start/Stop, no DNS badge)
 4 Map models (link → /dashboard/mitm)
 5 Restart the IDE
[Antigravity] 127.0.0.1 … · Map models →
[Kiro]        127.0.0.1 … · Map models →
```

### Interaction Changes

| Touchpoint                     | Before                           | After                                  | Notes                       |
| ------------------------------ | -------------------------------- | -------------------------------------- | --------------------------- |
| Remote cli-tools intercept     | hosts lines + contradictory copy | ordered 5-step procedure + hosts cards | cards link to mapping page  |
| Remote `/dashboard/mitm`       | LocalOnlyNotice only             | steps + mapping-only tool cards        | server card stays hidden    |
| Mapping inputs (host & remote) | disabled until DNS on            | always editable                        | server-side state           |
| Alias API remote               | 403 LOCAL_ONLY                   | GET/PUT allowed with dashboard auth    | other MITM routes unchanged |

---

## Mandatory Reading

| Priority | File                                                                   | Lines          | Why                                                        |
| -------- | ---------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| P0       | `src/dashboardGuard.js`                                                | 60-80, 205-220 | Local-only gate and the remote GET allowlist               |
| P0       | `src/app/api/cli-tools/antigravity-mitm/alias/route.js`                | all            | Route to open + validate                                   |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/InterceptTools.js` | 28-73          | Remote steps to replace                                    |
| P0       | `src/app/(dashboard)/dashboard/mitm/MitmPageClient.js`                 | all            | Remote branch to add                                       |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`   | all            | Card to run in remote mode                                 |
| P1       | `tests/unit/dashboard-guard.test.js`                                   | 254-300        | Test pattern for remote allowlist                          |
| P1       | `tests/unit/cli-tools-request-loop.test.js`                            | 44-60          | References the deleted card                                |
| P1       | `src/shared/brand/index.cjs`                                           | 30-60          | `ACTIVE.name`, `ACTIVE.dataDirName` for copy               |
| P2       | `src/mitm/dbReader.js`                                                 | all            | MITM re-reads aliases.json per request — no restart needed |
| P2       | `src/mitm/cert/rootCA.js`                                              | 1-10           | CA path `<DATA_DIR>/mitm/rootCA.crt`                       |

---

## Patterns to Mirror

### NAMING_CONVENTION

```
// SOURCE: src/dashboardGuard.js:75-78
// Read-only GETs under a local-only prefix that remote dashboard users may call
const REMOTE_READABLE_GETS = new Set(["/api/cli-tools/cowork-mcp-registry"]);
```

### ERROR_HANDLING

```
// SOURCE: src/app/api/cli-tools/antigravity-mitm/alias/route.js:25-28
if (!tool || !mappings || typeof mappings !== "object") {
  return NextResponse.json({ error: "tool and mappings required" }, { status: 400 });
}
```

### LOGGING_PATTERN

```
// SOURCE: alias/route.js:16
console.log("Error fetching MITM aliases:", error.message);
```

### SERVICE_PATTERN

```
// SOURCE: dashboardGuard.js:211-212
const remoteReadable = request.method === "GET" && REMOTE_READABLE_GETS.has(pathname);
if (!remoteReadable && LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
```

### TEST_STRUCTURE

```
// SOURCE: tests/unit/dashboard-guard.test.js:264-278
const registry = await proxy(remote("/api/cli-tools/cowork-mcp-registry", "GET"));
expect(registry).toBe(mocks.nextResponse);
const probe = await proxy(remote("/api/cli-tools/cowork-mcp-tools", "POST"));
expect(probe.status).toBe(403);
```

---

## Files to Change

| File                                                                        | Action | Justification                                                                        |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `src/dashboardGuard.js`                                                     | UPDATE | Allow GET+PUT `/api/cli-tools/antigravity-mitm/alias` remotely (auth still required) |
| `src/app/api/cli-tools/antigravity-mitm/alias/route.js`                     | UPDATE | Drop DNS gate; validate `tool` ∈ MITM_TOOLS and string values                        |
| `tests/unit/dashboard-guard.test.js`                                        | UPDATE | Remote alias GET/PUT allowed, PATCH on MITM still 403, unauth 401                    |
| `src/app/(dashboard)/dashboard/cli-tools/components/MitmRemoteSteps.js`     | CREATE | Shared ordered remote procedure                                                      |
| `src/app/(dashboard)/dashboard/cli-tools/components/InterceptTools.js`      | UPDATE | Use steps; per-tool hosts cards link to mapping page                                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js`        | UPDATE | `remote` prop; mapping no longer DNS-gated                                           |
| `src/app/(dashboard)/dashboard/mitm/MitmPageClient.js`                      | UPDATE | Remote: steps + remote tool cards                                                    |
| `src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js` | DELETE | Dead code                                                                            |
| `src/app/(dashboard)/dashboard/cli-tools/components/index.js`               | UPDATE | Drop dead export, export MitmRemoteSteps if needed                                   |
| `tests/unit/cli-tools-request-loop.test.js`                                 | UPDATE | Remove assertions on the deleted card                                                |
| `scripts/brand-guard.baseline.json`                                         | UPDATE | Remove/lower counts for touched files                                                |

## NOT Building

- Remote MITM server start/stop, CA trust or DNS toggles (host-only, spawn + sudo).
- Serving `rootCA.crt` for download over HTTP.
- Procedure for an IDE on a different machine than the host (needs NODE_EXTRA_CA_CERTS etc.).
- Cursor/Copilot intercept hosts (YAN-625, already done).
- `MitmLinkCard.js` cleanup (not in issue scope).

---

## Step-by-Step Tasks

### Task 1.1: Guard + alias route + guard test — Depends on [none]

- **BATCH**: B1
- **ACTION**: Replace `REMOTE_READABLE_GETS` with a map of path → allowed methods: `cowork-mcp-registry: GET`, `antigravity-mitm/alias: GET, PUT`. In the alias PUT remove the `getMitmStatus` DNS check and import; reject `tool` not in `MITM_TOOLS` (400) and non-string mapping values (400). Add guard tests.
- **IMPLEMENT**: `const REMOTE_ALLOWED = new Map([[path, new Set(["GET"])], …])`; `remoteAllowed = REMOTE_ALLOWED.get(pathname)?.has(request.method)`. Update the comment to say the alias route reads/writes only the alias map (DB + aliases.json), no spawn or host secrets.
- **MIRROR**: SERVICE_PATTERN, ERROR_HANDLING, TEST_STRUCTURE.
- **IMPORTS**: `MITM_TOOLS` from `@/shared/constants/cliTools` in the route.
- **GOTCHA**: Exact pathname match only (no prefix), so `/api/cli-tools/antigravity-mitm` (PATCH DNS, POST start) stays local-only. Auth still runs afterwards via `PROTECTED_API_PATHS` `/api/cli-tools`.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/dashboard-guard.test.js`.

### Task 1.2: Remote UI + dead code — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `MitmRemoteSteps.js` (ordered list: host starts MITM server with router URL + API key; trust root CA on host — `mitm/rootCA.crt` in the data dir `~/.${ACTIVE.dataDirName}`; Start DNS on host or add the hosts lines by hand; map models at `/dashboard/mitm`, otherwise requests pass through unchanged; restart the IDE; note the IDE must run on the host). Use it in `InterceptTools` remote view (replace the contradictory paragraph; each tool card gets a "Map models" link to `/dashboard/mitm`) and in `MitmPageClient` when `localOnly` (in place of `LocalOnlyNotice`, followed by `MitmToolCard remote` per tool). `MitmToolCard`: new `remote` prop hides the DNS badge, DNS Start/Stop block and sudo modal trigger; mapping inputs/Select no longer depend on `dnsActive` (remove "Enable DNS to edit model mappings"). Delete `AntigravityToolCard.js`, its export and its test assertions.
- **IMPLEMENT**: Product name via `ACTIVE.name` from `@/shared/brand` — no new `9router` literals. Plain JSX strings (i18n extracts them in CI).
- **MIRROR**: existing Tailwind tokens in `InterceptTools.js` / `Callout` usage in `MitmPageClient.js`.
- **IMPORTS**: `Link` from `next/link`, `ACTIVE` from `@/shared/brand`, `TOOL_HOSTS`.
- **GOTCHA**: `MitmPageClient` learns `localOnly` from `MitmServerCard`'s first GET (403 → `markLocalOnly`), so keep rendering `MitmServerCard` until then. Keep `MitmToolCard`'s `isWin`/sudo props working on host.
- **VALIDATE**: `npm run lint`; `npx vitest run -c tests/vitest.config.js tests/unit/cli-tools-request-loop.test.js`.

### Task 2.1: Validate — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Run lint, brand guard (`npm run lint:brand -- --update` if counts dropped), full `npm test`, `npm run build`.
- **VALIDATE**: All green.

---

## Testing Strategy

### Unit Tests

| Test                       | Input                                   | Expected Output       | Edge Case? |
| -------------------------- | --------------------------------------- | --------------------- | ---------- |
| remote alias GET with JWT  | GET alias, remote host                  | `NextResponse.next()` | no         |
| remote alias PUT with JWT  | PUT alias, remote host                  | `NextResponse.next()` | no         |
| remote MITM PATCH with JWT | PATCH `/api/cli-tools/antigravity-mitm` | 403 LOCAL_ONLY        | yes        |
| remote alias PUT no auth   | PUT alias, no cookie                    | 401                   | yes        |

### Edge Cases Checklist

- [x] Unknown tool id → 400
- [x] Non-string mapping value → 400
- [x] Permission denied (unauthenticated remote) → 401

---

## Validation Commands

### Static Analysis

```bash
npm run lint && npm run lint:brand
```

EXPECT: Zero errors

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/dashboard-guard.test.js tests/unit/cli-tools-request-loop.test.js
```

EXPECT: All pass

### Full Test Suite

```bash
npm test
```

EXPECT: No regressions

### Browser Validation

```bash
npm run build
```

EXPECT: Build succeeds

### Manual Validation

- [ ] Remote host: cli-tools shows the 5 steps + hosts cards with "Map models" links.
- [ ] Remote host: `/dashboard/mitm` shows steps + cards; editing a mapping saves (PUT 200).
- [ ] Localhost: MITM page unchanged except mappings editable with DNS off.

---

## Acceptance Criteria

- [ ] Remote users see the full procedure (host server, CA trust, hosts lines, mapping, restart).
- [ ] Alias reads/writes work remotely with dashboard auth; all other MITM routes stay local-only.
- [ ] `AntigravityToolCard.js` removed.
- [ ] Lint, brand guard, tests, build green.

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] No new `9router` literals
- [ ] No unnecessary scope additions

## Risks

| Risk                                      | Likelihood | Impact | Mitigation                                                  |
| ----------------------------------------- | ---------- | ------ | ----------------------------------------------------------- |
| Remote write surface grows                | Med        | Low    | Exact path+method allowlist, auth required, input validated |
| Mapping before DNS on confuses host users | Low        | Low    | Mapping is inert until DNS is on; copy explains order       |

## Notes

MITM standalone server re-reads `aliases.json` per request (`src/mitm/dbReader.js`), so a
remote PUT takes effect immediately.
