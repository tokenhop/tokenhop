# PR Review #584 — feat(cli-tools): persist Cowork and guide cards and move presets to the DB

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-640-cli-tools-persist-rest → master
**Decision**: COMMENT (own PR; findings to fix before merge)

## Worktree Setup

- **Parent**: /home/yandy/.claude-worktrees/tokenhop-6b1661957219e94e/feat-yan-640-cli-tools-persist-rest/ (branch: feat/yan-640-cli-tools-persist-rest)

## Summary

Solid migration that follows the sibling cards; no blockers. The fixes worth making are a prototype-key gap and a retry storm in the new presets code, two small regressions in the Cowork endpoint, and a few consistency cleanups. Dismissed as false positive: "Cowork Apply drops plugin `toolPolicy`/`oauth`". `asPluginList` filters and does not map, so the full objects survive.

## Findings

### MEDIUM

- **[F001]** `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js:92` — The `disk` memo has no `endpoint`, so the on-disk gateway URL no longer seeds the picker (master seeded it from `status.cowork.baseUrl`). "Load from file" also can't restore it, because a saved `endpointId` keeps winning.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Add `endpoint: status.cowork?.baseUrl || undefined` to `disk`. In `useSetupSettings.loadFromFile`, also clear `endpointId` when `differs` includes `endpoint` (same as the Claude card).
- **[F002]** `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js:426` — Marketplace plugin objects (`description`, long `toolNames`) are saved unsanitized. One item that fails `isValidToolSettings` makes every later Cowork autosave fail with 400.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: On add, keep only `name`, `title`, `url`, `transport`, `oauth` and `toolNames`.
- **[F003]** `src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js:55` — A failed presets GET is retried on every `read()`, and `read()` runs during render. A server that keeps failing gets a render-rate fetch storm.
  - **Status**: Open
  - **Category**: Performance
  - **Suggested fix**: Record the failure time and skip `load()` for a short cooldown (e.g. 5 s).
- **[F004]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js:22` — `savedEndpointUrl` reads endpoint presets during render, but the hook never subscribes to them. A saved preset id resolves against an empty list until some unrelated re-render. `ClaudeToolCard.js:158` has the same gap.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Read endpoint presets with `useSyncExternalStore(subscribePresets, readPresets, …)` and pass them to `resolveSavedEndpoint`.
- **[F005]** `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js:165` — The API-key selection and change logic duplicates `useSetupSettings` line for line; only the Claude disk-token fallback differs.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Export two small pure helpers from `useSetupSettings.js` (selected key resolution and the change-to-patch mapping) and use them in both places.
- **[F006]** `src/app/api/cli-tool-presets/route.js:21` — `KINDS[body?.kind]` follows the prototype chain: `{kind:"__proto__",items:[]}` passes validation and writes a junk kv row.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Use `Object.hasOwn(KINDS, kind)`, and add a regression case to `tests/unit/cli-tool-presets.test.js`.
- **[F007]** `src/lib/cliToolConfigs/toolSettings.js:78` — Remote-saved Cowork plugin lists now reach the host's Claude Desktop config when a host user clicks Apply. This is the same model as the endpoints the merged cards already persist (#543, #570): the host user sees the values before applying, and the route requires a signed-in session.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Record this decision in the PR body (no code change).
- **[F008]** `tests/unit/cli-endpoint-presets.test.js:93` — The failure paths have no tests: a failed GET must block saves and retry later.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Add one test: GET fails, `upsert` does not PUT, and a later `read()` after the cooldown retries and loads.

### LOW

- **[F009]** `src/app/api/cli-tool-presets/route.js:33` — An endpoint preset's `baseUrl` is not checked to be an http(s) URL.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: For `endpoints`, require `/^https?:\/\//i`.
- **[F010]** `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js:44` — The `asPluginList` comment says it keeps "{name, url} objects only", but it keeps whole objects. It is also defined in the card, while its sibling guards live in `useSetupSettings.js`.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Move it to `useSetupSettings.js` as `asObjectList` next to `asList`/`asMap`, and fix the comment.
- **[F011]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js:60` — The fallback comment predates `apiKeyPreset`.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Use the Claude card's updated wording.
- **[F012]** `src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js:63` — A preset upserted before the first load finishes is replaced by the server list. The write already logs "not saved".
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Accepted: the window is the first GET only, and Apply/"Save current as" come later. Merge on load if this is ever reported.
- **[F013]** `src/app/api/cli-tool-presets/route.js:13` — The 16 KB cap can reject a list under 64 items when the entries are very long.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Accepted: typical entries are ~100 bytes.

## Validation Results

| Check      | Result                |
| ---------- | --------------------- |
| Type check | Skipped (JS project)  |
| Lint       | Pass                  |
| Tests      | Pass (no regressions) |
| Build      | Pass                  |

## Files Reviewed

- `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js` (Modified)
- `src/app/api/cli-tool-presets/route.js` (Added)
- `src/app/api/cli-tool-settings/[toolId]/route.js` (Modified)
- `src/lib/cliToolConfigs/toolSettings.js` (Modified)
- `src/lib/db/index.js` (Modified)
- `src/lib/db/repos/cliToolSettingsRepo.js` (Modified)
- `tests/unit/cli-endpoint-presets.test.js` (Modified)
- `tests/unit/cli-setup-settings.test.js` (Modified)
- `tests/unit/cli-tool-presets.test.js` (Added)
- `tests/unit/cli-tool-settings.test.js` (Modified)
- `tests/unit/dashboard-guard.test.js` (Modified)
