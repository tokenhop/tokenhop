# Plan: Persist CLI tool card settings in the DB — foundation + Claude Code card (YAN-636, YAN-637)

## Summary

Every edit on a CLI tool card lives in React state and is lost on refresh, on tool switch,
and between the grid and `/dashboard/cli-tools/[toolId]`. Remote dashboards can't read any
`/api/cli-tools/*` route, so they always reseed hard-coded defaults. This adds a kv-backed
store (`cliToolSettings` scope), a session-authenticated route outside the local-only prefix,
a shared `useToolSettings` hook (zustand cache, debounced autosave, flush on unmount and
`beforeunload`), and migrates the Claude Code card onto it.

## User Story

As a user configuring Claude Code from the dashboard (on the host or remotely), I want my
model mapping, endpoint, API key, auto-compact, `[1m]` and Exa choices to survive a refresh,
so that I don't redo them every visit and the manual snippet always reflects them.

## Problem → Solution

Edits in `useState` only; remote reseeds `tool.defaultModels` → Values saved per tool in
`kv(cliToolSettings, <toolId>)`; on load precedence is saved → on-disk (host only) → defaults.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-636 + YAN-637, GitHub #512 + #513, parent YAN-635)
- **PRD Phase**: N/A
- **Estimated Files**: 12
- **Target release**: `v1.0.0` → base/PR `master`, no backport (RELEASING.md "Feature, refactor…").
- **Switch**: none. Each piece is complete when merged; nothing half-built is reachable.

---

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/yan-636-637/ (branch: feat/yan-636-cli-tool-settings)

## Batches

| Batch | Tasks    | Notes                                              |
| ----- | -------- | -------------------------------------------------- |
| 1     | 1.1, 1.2 | Server (repo/route/backup/tests) ∥ client plumbing |
| 2     | 2.1      | Claude card migration (depends on 1.2 hook API)    |
| 3     | 3.1      | Validation: lint, brand guard, tests, build, UI    |

---

## UX Design

### Before

```
Claude Code [Manual setup]
Model mapping  Fable cc/claude-fable-5 …   ← edit, refresh → defaults back
Apply | Manual config | Reset
```

### After

```
Claude Code [Manual setup]
Model mapping  Fable my/combo …            ← edit, refresh → still my/combo
…
Saved · Reset to defaults                  ← quiet status + per-tool reset (host and remote)
(host only, when saved ≠ file) Saved settings differ from ~/.claude/settings.json [Load from file]
Apply | Manual config | Reset              ← file-level Reset keeps saved preferences
```

---

## Mandatory Reading

| Priority | File                                                                            | Why                                                                         |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js`          | Card being migrated                                                         |
| P0       | `src/lib/db/helpers/kvStore.js`                                                 | `makeKv(scope)` API                                                         |
| P0       | `src/lib/db/repos/aliasRepo.js`                                                 | kv repo pattern (`mitmAlias`)                                               |
| P0       | `src/app/api/cli-tools/antigravity-mitm/alias/route.js`                         | Remote-writable route validation style                                      |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` | Mount-time `onChange` clobbers persisted endpoint                           |
| P1       | `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js`           | Status/reset slot                                                           |
| P1       | `src/app/(dashboard)/dashboard/settings/useSettingsField.js`                    | `debounce` helper + autosave states                                         |
| P1       | `src/lib/db/index.js`                                                           | Repo exports + `exportDb`/`importDb` per-scope lists                        |
| P1       | `tests/unit/cli-tools-request-loop.test.js`                                     | Source constraints on ClaudeToolCard                                        |
| P1       | `tests/unit/api-key-rename.test.js`                                             | Route-handler test pattern                                                  |
| P2       | `src/dashboardGuard.js`                                                         | Local-only prefix (lines 63-90, 217-246) `/api/cli-tools/` (trailing slash) |

## Patterns to Mirror

### KV_REPO

```js
// src/lib/db/repos/aliasRepo.js
const mitmKv = makeKv("mitmAlias");
export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
```

### DYNAMIC_ROUTE (Next 16: params is a Promise)

```js
export async function GET(_request, { params }) {
  const { id } = await params;
  return NextResponse.json({ error: "Combo not found" }, { status: 404 });
```

### REMOTE_WRITE_VALIDATION

```js
if (!Object.hasOwn(MITM_TOOLS, tool)) {
  return NextResponse.json({ error: "Unknown MITM tool" }, { status: 400 });
}
console.log("Error saving MITM aliases:", error.message);
```

### ZUSTAND_STORE

```js
export const useCliAccessStore = create(() => ({ localOnly: false }));
export const markLocalOnly = () => useCliAccessStore.setState({ localOnly: true });
```

### ROUTE_TEST

```js
({ PUT } = await import("@/app/api/keys/[id]/route.js"));
PUT(new Request(`http://localhost/api/keys/${id}`, { method: "PUT", body: JSON.stringify(body) }), {
  params: Promise.resolve({ id }),
});
```

### GUARD_TEST (remote signed-in request)

```js
const remote = (pathname, method) => ({
  ...request(pathname, { host: "router.example.com" }),
  method,
  cookies: { get: vi.fn(() => ({ value: "jwt" })) },
});
expect(await proxy(remote("/api/cli-tools/antigravity-mitm/alias", "PUT"))).toBe(
  mocks.nextResponse,
);
```

## Files to Change

| File                                                                            | Action | Justification                                           |
| ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| `src/lib/db/repos/cliToolSettingsRepo.js`                                       | CREATE | kv scope `cliToolSettings`                              |
| `src/lib/db/index.js`                                                           | UPDATE | export repo; include scope in `exportDb`/`importDb`     |
| `src/app/api/cli-tool-settings/route.js`                                        | CREATE | `GET` all                                               |
| `src/app/api/cli-tool-settings/[toolId]/route.js`                               | CREATE | `GET`/`PUT`/`DELETE` one tool                           |
| `src/app/(dashboard)/dashboard/cli-tools/lib/toolSettings.js`                   | CREATE | pure merge/diff helpers (testable, no React)            |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js`              | CREATE | zustand store + hook                                    |
| `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js`           | UPDATE | optional save status / Reset to defaults / differs hint |
| `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` | UPDATE | optional `savedUrl` init                                |
| `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js`          | UPDATE | use the hook                                            |
| `tests/unit/cli-tool-settings.test.js`                                          | CREATE | route + helpers                                         |
| `tests/unit/dashboard-guard.test.js`                                            | UPDATE | remote PUT/DELETE allowed                               |

## NOT Building

- Migrating other cards (YAN-638..641) and endpoint/key presets (YAN-642).
- Persisting custom-typed or localStorage-preset API keys (no raw secrets in the DB; YAN-642).
- Per-user/workspace scoping (YAN-364/374); key stays bare `toolId` = instance scope.
- A DOM test harness for the hook.

---

## Step-by-Step Tasks

### Task 1.1: Server — repo, route, backups, tests

- **BATCH**: B1
- **Depends on**: [none]
- **ACTION**: Create `cliToolSettingsRepo.js` (`getCliToolSettings(toolId?)`, `setCliToolSettings(toolId, value)`, `deleteCliToolSettings(toolId)`) on `makeKv("cliToolSettings")`; export from `src/lib/db/index.js`; add the scope to `exportDb` (`cliToolSettings: {}`) and `importDb` (wipe list + reinsert). Create `/api/cli-tool-settings` `GET` → `{ settings }` and `/[toolId]` `GET` → `{ settings }` (`{}` when none), `PUT` (replace) → `{ settings }`, `DELETE` → `{ success: true }`.
- **IMPLEMENT**: Validation on `[toolId]`: `Object.hasOwn(CLI_TOOLS, toolId)` else 400 `Unknown CLI tool`. PUT reads `request.text()`; > 16 KiB → 413; parse failure → 400; body must be a plain object (not array/null) → else 400. `export const dynamic = "force-dynamic"`. Errors: try/catch, `console.log("Error …:", error.message)`, 500 `{ error }`.
- **MIRROR**: KV_REPO, DYNAMIC_ROUTE, REMOTE_WRITE_VALIDATION
- **IMPORTS**: `NextResponse` from `next/server`; repo fns from `@/lib/db/index.js`; `CLI_TOOLS` from `@/shared/constants/cliTools`
- **GOTCHA**: Path must not start with `/api/cli-tools/` (local-only). Keep key = bare `toolId` so a later scoped prefix (e.g. `ws:<id>/<toolId>`) needs no migration.
- **VALIDATE**: `tests/unit/cli-tool-settings.test.js` route cases + guard case pass.

### Task 1.2: Client plumbing — helpers, store/hook, scaffold, picker

- **BATCH**: B1
- **Depends on**: [none]
- **ACTION**: Create `lib/toolSettings.js` with `mergeToolSettings(defaults, disk, saved)` (defaults ← defined disk fields ← saved fields) and `diffFromDisk(saved, disk)` (saved keys whose value ≠ defined disk value). Create `hooks/useToolSettings.js`.
- **IMPLEMENT**: Store `useToolSettingsStore = create(() => ({ saved: {}, loaded: false, status: {} }))`; module-level one-shot `GET /api/cli-tool-settings` load. `useToolSettings(toolId, defaults, disk = null)` returns `[values, setField, { loaded, status, setFields, reset, differs, loadFromDisk }]`. `setFields(patch)` merges into `saved[toolId]` (a value of `undefined` deletes the key) and schedules a 500 ms debounced `PUT` (reuse `debounce` from `settings/useSettingsField.js`); `status[toolId]` ∈ `saving|saved|error`. Flush pending PUT on unmount and on `beforeunload` (`fetch(..., { keepalive: true })`). `reset()` cancels pending, `DELETE`s, clears `saved[toolId]`. `differs` = `diffFromDisk` keys; `loadFromDisk()` = `setFields` with those keys set `undefined`. SetupScaffold: new optional props `saveStatus`, `onResetDefaults`, `differsHint`, `onLoadFromFile`, rendered in one small row after children (visible host and remote). Picker: optional `savedUrl`; init prefers saved preset, then built-in option whose URL equals `savedUrl`, else Custom showing `savedUrl`; without `savedUrl` behavior is unchanged except the mount call becomes `onChange(url, { init: true })`.
- **MIRROR**: ZUSTAND_STORE; `useSettingsField` debounce
- **IMPORTS**: `create` from `zustand`; `debounce` from `../../settings/useSettingsField`
- **GOTCHA**: `values` must be `useMemo`-stable; `defaults`/`disk` objects come from the card — memoize there. New UI strings: sentence case, no brand literals (brand guard, copy-tone).
- **VALIDATE**: helper unit tests in `tests/unit/cli-tool-settings.test.js`; `npm run lint`.

### Task 2.1: Claude Code card on `useToolSettings("claude", …)`

- **BATCH**: B2
- **Depends on**: [1.2]
- **ACTION**: Replace `modelMappings`, `customBaseUrl`, `selectedApiKey`, `autoCompactWindow`, `oneMContext`, `exaMcpEnabled` state with hook fields `models` (alias→value), `endpoint`, `apiKeyId`, `autoCompactWindow`, `oneMContext`, `exaMcpEnabled`.
- **IMPLEMENT**: `defaults` = `{ models: <defaultValue per alias>, endpoint: "", apiKeyId: "", autoCompactWindow: "", oneMContext: false, exaMcpEnabled: false }`. `disk` (host + installed only) from `claudeStatus.settings.env` + `claudeStatus.exaMcpEnabled`; null remotely. Drop both seeding effects and `hasInitializedModels`. API key: `selectedApiKey` derived = key for `apiKeyId` in `apiKeys`, else (host) disk `ANTHROPIC_AUTH_TOKEN`, else `apiKeys[0]?.key`; a transient `customKey` state holds a typed/preset key (not persisted, `ponytail:` note). `onChange` from `ApiKeySelect`: matching DB key → `apiKeyId`, else `customKey`. `[1m]` toggle writes toggle + rewritten mappings in one `setFields`. Picker gets `savedUrl={values.endpoint}` and `onChange={(u) => setField("endpoint", u)}`; render form only after `loaded` (`checking || !loaded`). File-level `handleReset` no longer touches preferences. Pass `saveStatus`, `onResetDefaults={reset}`, `differsHint`/`onLoadFromFile` (host only) to SetupScaffold. `buildEnv`/`getManualConfigs`/`handleApply` read hook values. Keep `fetchStatus` `useCallback(..., [])` and `onStatusUpdateRef`.
- **MIRROR**: existing card structure
- **IMPORTS**: `useToolSettings` from `../hooks/useToolSettings`
- **GOTCHA**: `tests/unit/cli-tools-request-loop.test.js` regexes. The picker's mount-time `onChange` is not a user edit: picker passes `{ init: true }` as 2nd arg on that call; the card stores it in a transient `initUrl` state instead of persisting. Effective URL = `values.endpoint || initUrl || baseUrl`. `values.endpoint` already includes the on-disk `ANTHROPIC_BASE_URL` on the host via merge precedence, so `savedUrl` supersedes `currentUrl`.
- **VALIDATE**: `cli-tools-request-loop`, `cli-tools-parity` tests green; manual UI check host + remote.

### Task 3.1: Validate

- **BATCH**: B3
- **Depends on**: [1.1, 1.2, 2.1]
- **ACTION**: Run lint, brand guard, full `npm test`, `npm run build`, and a browser check against a dev server on an isolated `DATA_DIR`.
- **VALIDATE**: All green; refresh keeps values; Reset to defaults restores `cc/claude-*` defaults.

## Testing Strategy

- Route: unknown tool 400; PUT→GET roundtrip; GET all; DELETE clears; array body 400; oversize 413.
- Helpers: merge precedence; `undefined`/missing disk fields fall through; diff keys.
- Guard: signed-in remote `PUT`/`DELETE /api/cli-tool-settings/claude` → `NextResponse.next()`.
- Backups: existing `exportDb / importDb roundtrip` still passes.

## Validation Commands

```bash
npm run lint
npm run lint:brand
npx vitest run -c tests/vitest.config.js tests/unit/cli-tool-settings.test.js tests/unit/dashboard-guard.test.js tests/unit/cli-tools-request-loop.test.js tests/unit/cli-tools-parity.test.js
npm test
npm run build
```

## Acceptance Criteria

- [ ] Repo, route, hook in place with route + helper tests.
- [ ] Route works for signed-in remote users (not local-only).
- [ ] Claude card: all six settings survive refresh on host (installed or not) and remote; manual snippet reflects them.
- [ ] Reset to defaults restores `cc/claude-fable-5`, `cc/claude-opus-5`, `cc/claude-sonnet-5`, `cc/claude-haiku-4-5-20251001`.
- [ ] Grid panel and detail route show the same values.

## Completion Checklist

- [ ] Lint, brand guard, tests, build green
- [ ] PR records decisions: saved values win over the file (with Load from file); file-level Reset keeps preferences

## Risks

| Risk                                              | Mitigation                                                      |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Picker mount `onChange` overwrites saved endpoint | `savedUrl` init + `{ init: true }` flag ignored for persistence |
| Lost edit on tab close                            | `beforeunload` keepalive flush                                  |
| Raw key leak into DB                              | only `apiKeyId` persisted                                       |
| Backup restore drops settings                     | scope added to `exportDb`/`importDb`                            |

## Notes

Decisions for the PR: (1) on the host, saved values win over the on-disk file; a hint offers
"Load from file". (2) File-level Reset removes our config from the file but keeps saved
preferences; "Reset to defaults" clears them.
