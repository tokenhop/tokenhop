# Plan: Persist the remaining CLI tool cards (Cowork, guide tools) and move presets to the DB

## Summary

Finishes YAN-635. The Claude Cowork card (YAN-640) and the guide-tool card `DefaultToolCard` (YAN-641) move to the persisted tool settings (`useSetupSettings`), and the endpoint / API-key presets (YAN-642) move from browser `localStorage` to the DB behind a remote-safe route, with a one-time import.

## User Story

As a dashboard user (on the host or remotely), I want every CLI tool card and my saved endpoint/key presets to survive a refresh and follow me to other browsers, so that I don't redo setup every time.

## Problem → Solution

Cowork and guide cards keep fields in React state, and presets live in one browser's `localStorage` → every card reads/writes `/api/cli-tool-settings`, and presets read/write `/api/cli-tool-presets` (kv scope `cliToolPresets`).

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-640, YAN-641, YAN-642; GitHub #581, #582, #583)
- **PRD Phase**: N/A
- **Estimated Files**: 14
- **Target release**: v1.1.0 (into `master`, no backport)

## Batches

| Batch | Tasks         | Depends On | Parallel Width |
| ----- | ------------- | ---------- | -------------- |
| B1    | 1.1, 1.2, 1.3 | —          | 3              |
| B2    | 2.1           | B1         | 1              |

- **Total tasks**: 4
- **Total batches**: 2
- **Max parallel width**: 3

## Worktree Setup

- **Parent**: /home/yandy/.claude-worktrees/tokenhop-6b1661957219e94e/feat-yan-640-cli-tools-persist-rest/ (branch: feat/yan-640-cli-tools-persist-rest)

---

## UX Design

### Before

Cowork: models/plugins/custom MCPs/endpoint/key reset on refresh. Guide tools: model + key reset, no endpoint picker. Presets: only in the browser that saved them.

### After

Same controls, values persist (host and remote). Cowork and guide cards show the "Saved" / "Reset to defaults" row from `SetupScaffold`. Guide tools whose snippet uses `{{baseUrl}}` get the shared `EndpointSegmentedPicker`.

### Interaction Changes

| Touchpoint            | Before                | After                                | Notes                                    |
| --------------------- | --------------------- | ------------------------------------ | ---------------------------------------- |
| Cowork card           | state lost on refresh | autosaved                            | file "Reset" no longer wipes saved prefs |
| Guide card            | no endpoint picker    | picker when guide uses `{{baseUrl}}` | seeds model from `tool.defaultModels[0]` |
| Endpoint / key preset | `localStorage`        | DB, same picker UI                   | old presets imported once, then cleared  |
| Saved key preset pick | in memory only        | persisted as `apiKeyPreset` (name)   | typed, unsaved keys stay in memory       |

---

## Mandatory Reading

| Priority | File                                                                                                                                                                     | Lines          | Why                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------ |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js`                                                                                                      | all            | Hook every card uses                       |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/OpenClawToolCard.js`                                                                                                 | 40-240         | Migrated multi-field card to mirror        |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/KiloToolCard.js`                                                                                                     | all            | Migrated single-model card                 |
| P0       | `src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js`                                                                                               | all            | Preset store whose interface must stay     |
| P0       | `src/lib/cliToolConfigs/toolSettings.js`                                                                                                                                 | all            | Server-side shape validator                |
| P1       | `src/store/toolSettingsStore.js`                                                                                                                                         | all            | Load/save pattern                          |
| P1       | `src/app/api/cli-tool-settings/[toolId]/route.js`                                                                                                                        | all            | Route pattern (size cap, JSON, validation) |
| P1       | `src/lib/db/repos/cliToolSettingsRepo.js`, `src/lib/db/index.js`                                                                                                         | 86-91, 160-345 | Repo + export/import of kv scopes          |
| P1       | `src/app/api/cli-tools/cowork-settings/route.js`                                                                                                                         | 215-300        | `status.cowork` disk shape                 |
| P2       | `tests/unit/cli-tool-settings.test.js`, `tests/unit/dashboard-guard.test.js:322-338`, `tests/unit/cli-setup-settings.test.js`, `tests/unit/cli-endpoint-presets.test.js` | all            | Test patterns                              |

Research backstops: `docs/prps/plans/.prp-research/cli-tools-persist-rest/*.md`.

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/lib/db/repos/cliToolSettingsRepo.js:1-9
const kv = makeKv("cliToolSettings");
export async function getCliToolSettings(toolId) {
```

### ERROR_HANDLING

```js
// SOURCE: src/app/api/cli-tool-settings/[toolId]/route.js:37-47
const raw = await request.text();
if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
  return NextResponse.json({ error: "Settings payload too large" }, { status: 413 });
}
```

### LOGGING_PATTERN

```js
// SOURCE: src/app/api/cli-tool-settings/route.js:9-11
console.log("Error fetching CLI tool settings:", error.message);
return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
```

### REPOSITORY_PATTERN

```js
// SOURCE: src/lib/db/index.js (exportDb/importDb)
for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolSettings'`))
  out.cliToolSettings[r.key] = parseJson(r.value);
```

### SERVICE_PATTERN

```js
// SOURCE: OpenClawToolCard.js:57-99
const defaults = useMemo(() => ({ model: "", agentModels: {}, endpoint: "", apiKeyId: "" }), []);
const disk = useMemo(() => (status?.installed ? { ... } : null), [status, apiKeys]);
const setup = useSetupSettings({ toolId: "openclaw", apiKeys, defaults, disk, endpointContext });
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/cli-tool-settings.test.js:1-26
beforeAll(async () => { db = await import("@/lib/db/index.js"); await db.initDb(); ... });
const put = (toolId, body) => one.PUT(new Request(url(toolId), { method: "PUT", body }), ctx(toolId));
```

---

## Files to Change

| File                                                                       | Action | Justification                                                          |
| -------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `src/lib/cliToolConfigs/toolSettings.js`                                   | UPDATE | Accept arrays (≤64) of flat objects (Cowork plugins)                   |
| `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js`     | UPDATE | Use `useSetupSettings`                                                 |
| `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js`          | UPDATE | Drop now-unused `customBaseUrl` / `selectedApiKey` from `useSetupCard` |
| `src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js`    | UPDATE | Use `useSetupSettings` + endpoint picker                               |
| `src/lib/db/repos/cliToolSettingsRepo.js`                                  | UPDATE | `cliToolPresets` kv scope get/set                                      |
| `src/lib/db/index.js`                                                      | UPDATE | Export repo fns; add scope to `exportDb` / `importDb`                  |
| `src/app/api/cli-tool-presets/route.js`                                    | CREATE | GET all presets; PUT one list (remote-safe path)                       |
| `src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js` | UPDATE | DB-backed store, same interface, one-time import                       |
| `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js`        | UPDATE | Persist saved key-preset pick (`apiKeyPreset`)                         |
| `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js`     | UPDATE | Same `apiKeyPreset` handling                                           |
| `tests/unit/cli-tool-settings.test.js`                                     | UPDATE | Validator accepts flat-object arrays (Task 1.1 only)                   |
| `tests/unit/cli-tool-presets.test.js`                                      | CREATE | Presets route roundtrip/validation/backup (Task 1.3)                   |
| `tests/unit/dashboard-guard.test.js`                                       | UPDATE | `/api/cli-tool-presets` is remote-safe                                 |
| `tests/unit/cli-endpoint-presets.test.js`                                  | UPDATE | Import-once from localStorage (active + legacy keys)                   |

## NOT Building

- YAN-623 guide-content fixes (stale model ids, Roo `/api/tags`, Devin notes, Cursor visibility rule) beyond adding the picker.
- Per-user/workspace scoping (YAN-364/YAN-374); keys stay bare.
- Persisting typed (unsaved) API keys.
- Cross-tab merge of concurrent preset edits (last write wins).

---

## Step-by-Step Tasks

### Task 1.1: Cowork card persistence (YAN-640) — Depends on [none]

- **BATCH**: B1
- **ACTION**: Allow arrays of flat objects in `isValidToolSettings`; migrate `CoworkToolCard.js` to `useSetupSettings`; remove dead `customBaseUrl` / `selectedApiKey` from `useSetupCard`.
- **IMPLEMENT**: Validator: a top-level value may also be an array (≤64) of plain objects whose keys pass `validKeys` and whose values are scalars or flat scalar arrays (≤64). Card: defaults `{ models: [], plugins: DEFAULT_PLUGINS, localPlugins: [], customPlugins: [], endpoint: "", apiKeyId: "" }`; disk (installed only) from `status.cowork` (models; plugins/customPlugins only when non-empty; localPlugins; `apiKeyId` from `status.config?.inferenceGatewayApiKey`); never copy raw keys/config into saved values. Replace every `setX(prev => …)` with `setup.setField(key, nextValue)`; endpoint via picker `{...setup.pickerProps}` + `currentUrl`; `checking={card.checking || !setup.loaded}`; `{...setup.scaffoldProps(fileHint)}`; file Reset no longer wipes lists (comment: saved prefs stay; "Reset to defaults" clears them). `addMcpForm`, `draftAppliedId` stay `useState`. Guard reads with `asList` and an inline object-list guard (keep only objects with string `name` + `url`).
- **MIRROR**: SERVICE_PATTERN (OpenClaw / OpenCode cards)
- **IMPORTS**: `useMemo` from react; `useSetupSettings`, `asList` from `./setupCard` (re-exported there).
- **GOTCHA**: Saved arrays replace disk arrays whole (merge is one level, arrays not merged) — correct for lists. `defaults` / `disk` / `endpointContext` must be memoized. Parity test builds snippets from object arrays; keep the builder inputs identical.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/cli-tool-settings.test.js tests/unit/cli-tools-parity.test.js`; lint clean.

### Task 1.2: Guide tools persistence (YAN-641) — Depends on [none]

- **BATCH**: B1
- **ACTION**: Migrate `DefaultToolCard.js` to `useSetupSettings` and add the endpoint picker.
- **IMPLEMENT**: defaults `{ model: tool.defaultModels?.[0]?.defaultValue || "", endpoint: "", apiKeyId: "" }` (memo on `tool`); no disk; endpointContext from the props `ToolSetupPanel` already passes (`tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl, cloudEnabled, cloudUrl, requiresExternalUrl`). Render `<EndpointSegmentedPicker key={setup.pickerKey} value={setup.endpoint || baseUrl} {...setup.pickerProps} />` only when the guide/codeBlock text contains `{{baseUrl}}`. `replaceVars` uses `setup.endpoint || baseUrl`, `setup.selectedApiKey`, `setup.model`. `ApiKeySelect onChange={setup.onApiKeyChange}`; model row/modal use `setup.setModel`. Pass `checking={!setup.loaded}` and `{...setup.scaffoldProps("")}` to `SetupScaffold` (keep `hideActions`).
- **MIRROR**: SERVICE_PATTERN (KiloToolCard)
- **IMPORTS**: `useMemo`; `useSetupSettings` from `../hooks/useSetupSettings`; `EndpointSegmentedPicker` from `./EndpointSegmentedPicker`.
- **GOTCHA**: `scaffoldProps(fileHint)` with empty hint: `differs` is always empty (no disk), so no "Load from file". Keep `canShowGuide()` logic unchanged (YAN-623).
- **VALIDATE**: lint clean; `npm run build` compiles; manual: set model/endpoint/key, refresh.

### Task 1.3: Presets to the DB (YAN-642) — Depends on [none]

- **BATCH**: B1
- **ACTION**: kv scope `cliToolPresets` (keys `endpoints`, `apiKeys`; value = array), route `src/app/api/cli-tool-presets/route.js`, DB-backed client store, `apiKeyPreset` persistence.
- **IMPLEMENT**:
  - Repo (in `cliToolSettingsRepo.js`): `getCliToolPresets()` → `{ endpoints: [], apiKeys: [], ...getAll }`, `setCliToolPresets(kind, items)`. Export from `index.js`; add `cliToolPresets` to `exportDb` (object), the `importDb` DELETE scope list and an insert loop (arrays only).
  - Route: `GET` → `{ presets }`; `PUT` body `{ kind: "endpoints"|"apiKeys", items: [...] }`, 16 KB cap, ≤64 items, each `{ name: string 1..128, baseUrl|key: string 1..2048 }` (field by kind), no extra keys. 400 on bad shape, 413 on size, 500 logged like siblings. Comment why it's outside `/api/cli-tools/`.
  - Client `cliEndpointPresets.js`: keep exports and `createStore` interface. In-memory `items` cache (stable array ref) per store; `read()` returns it and kicks a single shared `load()` in the browser. `load()` GETs `/api/cli-tool-presets`; for each kind, if the DB list is empty and `localStorage` (active key, else legacy via `readStorageItem`) has items, PUT them, then `removeItem` both active and legacy keys; dispatch the change event. `upsert`/`remove` update cache, dispatch, PUT the list (fire-and-forget, log on failure). `rememberEndpoint` unchanged.
  - `useSetupSettings`: read key presets via `useSyncExternalStore(subscribeKeyPresets, readKeyPresets, () => EMPTY)`; `onApiKeyChange`: dashboard key → `setFields({ apiKeyId: id, apiKeyPreset: undefined })`; key preset match → `setFields({ apiKeyPreset: name, apiKeyId: undefined })`; else in-memory custom. `selectedApiKey` = custom ?? dashboard id key ?? preset key ?? first key. Update the ponytail comment (typed unsaved keys only). Same logic in `ClaudeToolCard.js` (it keeps its own copy).
- **MIRROR**: REPOSITORY_PATTERN, ERROR_HANDLING, LOGGING_PATTERN
- **IMPORTS**: `makeKv`; `NextResponse`; `useSyncExternalStore`.
- **GOTCHA**: `useSyncExternalStore` needs a stable snapshot — never return a fresh array from `read()`. `savedEndpointUrl` reads presets during render; unresolved ids fall back to the saved URL. Raw key presets are stored as-is (decision: they are by definition non-dashboard keys, so no id exists; same trust boundary as the `apiKeys` table and provider tokens; exported in DB backups like those).
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/cli-endpoint-presets.test.js tests/unit/cli-tool-presets.test.js tests/unit/dashboard-guard.test.js tests/unit/cli-setup-settings.test.js`. Do NOT edit `tests/unit/cli-tool-settings.test.js` (Task 1.1 owns it).

### Task 2.1: Integration validation — Depends on [1.1, 1.2, 1.3]

- **BATCH**: B2
- **ACTION**: Run lint, full tests, build; fix regressions.
- **IMPLEMENT**: `npm run lint`, `npm test`, `npm run build`.
- **MIRROR**: N/A
- **IMPORTS**: N/A
- **GOTCHA**: Run tests only via `npm test` or with `-c tests/vitest.config.js` (HOME isolation).
- **VALIDATE**: all green.

---

## Testing Strategy

### Unit Tests

| Test                             | Input                                                             | Expected Output                          | Edge Case? |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- | ---------- |
| Validator accepts plugin objects | `{ plugins: [{ name, url, transport, oauth, toolNames: [..] }] }` | 200 roundtrip                            | no         |
| Validator rejects deeper nesting | `{ plugins: [{ a: { b: 1 } }] }`                                  | 400                                      | yes        |
| Presets PUT/GET roundtrip        | `{ kind: "endpoints", items: [{ name, baseUrl }] }`               | GET returns it                           | no         |
| Presets bad shape                | unknown kind, extra key, >64 items, missing field                 | 400                                      | yes        |
| Presets in backup                | `exportDb` → `importDb`                                           | presets restored                         | no         |
| Guard                            | remote signed-in GET/PUT `/api/cli-tool-presets`                  | passes                                   | no         |
| Import once                      | localStorage (legacy key) + empty DB                              | PUT once, keys removed                   | yes        |
| Key preset persisted             | pick preset key                                                   | `apiKeyPreset` saved, `apiKeyId` cleared | no         |

### Edge Cases Checklist

- [x] Empty lists
- [x] Maximum size input (64 items / 16 KB)
- [x] Invalid types
- [ ] Concurrent access (last write wins, documented)
- [x] Network failure (load failure keeps empty cache; next read retries)

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: zero errors

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/cli-tool-settings.test.js tests/unit/cli-endpoint-presets.test.js tests/unit/dashboard-guard.test.js tests/unit/cli-setup-settings.test.js tests/unit/cli-tools-parity.test.js
```

EXPECT: all pass

### Full Test Suite

```bash
npm test
```

EXPECT: no regressions

### Browser Validation

```bash
npm run build
```

EXPECT: build succeeds

### Manual Validation

- [ ] Cowork: toggle plugins, add custom MCP, pick models, refresh — persists.
- [ ] Guide tool (Qwen): model seeded `coder-model`; change model/endpoint/key, refresh — persists.
- [ ] Save an endpoint preset; it appears in a second browser / remote dashboard.

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] No lint errors
- [ ] Matches UX design

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] Error handling matches route siblings
- [ ] No unnecessary scope additions
- [ ] Self-contained

## Risks

| Risk                          | Likelihood | Impact | Mitigation                                                        |
| ----------------------------- | ---------- | ------ | ----------------------------------------------------------------- |
| Raw key presets in DB         | M          | M      | Same boundary as `apiKeys` table; auth-guarded route; noted in PR |
| Import duplicates across tabs | L          | L      | Import only when DB list empty; keys cleared after                |
| Validator relaxed             | L          | M      | Bounded depth/size; tested                                        |

## Notes

- `v1.0.0` already shipped; open issues relabelled `v1.1.0` (trunk only, no backport). Nothing here is reachable half-built: each card works end to end in this PR.
