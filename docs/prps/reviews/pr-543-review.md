# PR Review #543 — feat(cli-tools): persist tool card settings in the DB, starting with Claude Code

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-636-cli-tool-settings → master
**Decision**: REQUEST CHANGES

## Summary

Storage, route and card migration work end to end (verified on host and remote). The client saver has two real races: reset vs. an in-flight PUT, and a failed initial load followed by a whole-row PUT. Both need fixing before merge, along with input-shape hardening and a few convention cleanups.

## Findings

### HIGH

- **[F001]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:117` — `reset()` cancels only the debounce timer. A PUT already in flight can land after the DELETE and re-create the row, so the reset reverts itself on the next load.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Serialize per tool: keep an `inFlight` promise on the saver, chain sends onto it, and `await` it in `reset()` before the DELETE.
- **[F002]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:62` — A failed initial GET sets `saved: {}` and caches the failed promise. The next edit then PUTs only the edited keys, and because PUT replaces the whole row, every previously saved field is wiped.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: On load failure, record `loadFailed`, skip autosave (status "error"), and clear the cached promise so the next mount retries.

### MEDIUM

- **[F003]** `src/app/api/cli-tool-settings/[toolId]/route.js:47` — PUT accepts any JSON object shape. Saved values later flow into host files on Apply.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Validate generically. Values must be string/number/boolean or one nested plain object of those. Strings ≤ 2048 chars, ≤ 64 keys per level. Reject `__proto__` / `constructor` / `prototype` keys.
- **[F004]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:22` — Overlapping sends can land out of order. A failed send clears `dirty`, so flush never retries it.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Chain sends on the `inFlight` promise (F001), and set `dirty = true` again on failure.
- **[F005]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:8` — The global zustand store lives in a route-group file. Every other store is in `src/store/`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Move the store and its actions to `src/store/toolSettingsStore.js`. Keep only the React hook in `cli-tools/hooks/`.
- **[F006]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:5` — `debounce` is imported across route groups from the settings page's hook module.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Move `debounce` to `src/shared/utils/debounce.js` and import it from both places.
- **[F007]** `src/lib/db/index.js:341` — `importDb` stores `cliToolSettings` values without the route's plain-object check.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: Skip entries whose value isn't a plain object.
- **[F008]** `tests/unit/cli-tool-settings.test.js` — The saver lifecycle (reset vs. in-flight save, load failure) is untested.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Once the store actions are plain functions (F005), add node tests with a stubbed `fetch` for the reset ordering and the load-failure guard.

### LOW

- **[F009]** `src/app/api/cli-tool-settings/[toolId]/route.js:37` — The size cap counts UTF-16 units, not bytes.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `Buffer.byteLength(raw, "utf8") > MAX_BYTES`.
- **[F010]** `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js:330` — `currentUrl={currentBaseUrl}` is dead: `savedUrl` supersedes it, and `values.endpoint` already carries the on-disk URL.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Drop `currentUrl` and `currentBaseUrl` from this card.
- **[F011]** `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js:137` — The comment says a deleted key falls back to the first key, but the disk token comes first.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Fix the comment.
- **[F012]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js:147` — `hasSaved` is true for an empty `{}` row (after Load from file), so "Reset to defaults" shows with nothing saved. Reset also leaves "Saved" as the status.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `hasSaved` requires at least one key. Clear the status on reset.

## Validation Results

| Check      | Result                            |
| ---------- | --------------------------------- |
| Type check | Skipped (JS project)              |
| Lint       | Pass                              |
| Tests      | Pass (`npm test`, no regressions) |
| Build      | Pass                              |

## Files Reviewed

- `docs/prps/plans/yan-636-637-cli-tool-settings.plan.md` (Added)
- `src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/SetupScaffold.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/hooks/useToolSettings.js` (Added)
- `src/lib/cliToolConfigs/toolSettings.js` (Added)
- `src/store/toolSettingsStore.js` (Added, fix pass)
- `src/shared/utils/debounce.js` (Added, fix pass)
- `src/app/api/cli-tool-settings/route.js` (Added)
- `src/app/api/cli-tool-settings/[toolId]/route.js` (Added)
- `src/lib/db/index.js` (Modified)
- `src/lib/db/repos/cliToolSettingsRepo.js` (Added)
- `tests/unit/cli-tool-settings.test.js` (Added)
- `tests/unit/dashboard-guard.test.js` (Modified)

## Fix pass

All 12 findings were fixed in a follow-up commit on this PR:

- F001/F004: writes for each tool go through one promise queue. A reset waits for any in-flight PUT, and a failed send is marked dirty again so the next edit or flush retries it. The regression test fails against the old reset and passes with the fix.
- F002: a failed initial load sets `loadFailed`, turns autosave off (status "Couldn't save") and lets the next mount retry.
- F003/F007/F009: `isValidToolSettings` (scalars ≤ 2048 chars, one nested level, ≤ 64 keys, no prototype keys) runs in the route. `importDb` skips values that aren't plain objects. The size cap counts UTF-8 bytes.
- F005/F006: the store moved to `src/store/toolSettingsStore.js`, `debounce` moved to `src/shared/utils/debounce.js`, and the pure helpers moved to `src/lib/cliToolConfigs/toolSettings.js` because the route and `importDb` now import them.
- F008: node tests with a stubbed `fetch` cover the reset ordering and the load-failure guard.
- F010/F011/F012: removed the dead `currentUrl`, fixed the API-key comment, `hasSaved` now requires at least one key, and a successful reset clears the status.
