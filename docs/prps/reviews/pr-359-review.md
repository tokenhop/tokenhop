# PR Review #359 — refactor(media): move media provider detail and combo pages onto the Signal sections

**Reviewed**: 2026-09-29
**Mode**: PR (parallel: correctness, security, quality)
**Author**: yandy-r
**Branch**: redesign/yan-402-media-signal → re-design
**Decision**: REQUEST CHANGES

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.claude/worktrees/9router-media-signal/ (branch: redesign/yan-402-media-signal)

## Summary

The refactor keeps API contracts, keeps the cURL previews free of real keys (they always show `YOUR_KEY`), and passes lint, tests, build and CI. Three HIGH issues block the merge: a combo Retry race, a duplicated helper, and a shared component importing from a feature route. Several MEDIUM items are about reuse and edge cases.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `src/app/(dashboard)/dashboard/media-providers/combo/[id]/useMediaCombo.js:34` — `fetchAll` never sets `loading` back to true. A Retry after a failed load therefore renders `notFound()` while the refetch is still in flight.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: `setLoading(true)` at the top of `fetchAll`.
- **[F002]** `src/app/(dashboard)/dashboard/media-providers/combo/[id]/mediaComboConfig.js:76` — `maskB64` is duplicated verbatim in `genericExampleLogic.js`.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Keep one implementation. Have `mediaComboConfig` import it from `genericExampleLogic`, and drop the duplicate test.
- **[F003]** `src/shared/components/Header.js:14` — the shared shell component imports a feature route module (`media-providers/components/mediaPageInfo`).
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Move `mediaPageInfo.js` to `src/shared/utils/` and import it from there.

### MEDIUM

- **[F004]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/useMediaProviderDetail.js:47` — `loadNode` lost the unmount/stale-response cancellation the original effect had.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Ignore stale responses with a request-sequence ref.
- **[F005]** `src/app/(dashboard)/dashboard/media-providers/combo/[id]/useMediaCombo.js:158` — move, add and remove compute from the `providers` snapshot taken at click time. Quick successive clicks can therefore revert an earlier change.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Disable the list mutations while a models save is in flight.
- **[F006]** `src/shared/components/Select.js:14` — `groupSelectOptions` has no tests.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Add unit tests for runs, interleaving and empty input.
- **[F007]** `src/app/(dashboard)/dashboard/media-providers/combo/[id]/mediaComboConfig.js:9` — `KIND_LABELS` duplicates the labels in `MEDIA_PROVIDER_KINDS`, and the header comment is inaccurate.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Derive the labels from `MEDIA_PROVIDER_KINDS` and fix the comment.
- **[F008]** `src/app/(dashboard)/dashboard/media-providers/combo/[id]/components/ComboTestCard.js:46` — the latency is hand-built instead of using `LatencyBadge`.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Render `<LatencyBadge>`.
- **[F009]** `TtsExampleResult.js:33`, `GenericExampleResult.js:94`, `ComboTestCard.js:53,75` — the Download link markup is repeated 4 times.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Add a `DownloadLink` to `exampleShared.js` and reuse it.
- **[F010]** `src/app/(dashboard)/dashboard/media-providers/web/page.js:96` — hand-rolled lazy loading of the Drawer (pre-existing code, only moved).
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Out of scope for YAN-402 (unchanged from base).

### LOW

- **[F011]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/useGenericExample.js:150` — `binaryImageUrl` isn't reset when a new run starts.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: `setBinaryImageUrl("")` at the start of the run.
- **[F012]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/useMediaProviderDetail.js:70` — if only the models load fails, the page renders as a success.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Out of scope. `useModels` already reports failures with a toast, the same as the LLM detail page.
- **[F013]** `src/shared/components/Select.js:14` — `groupSelectOptions` groups consecutive runs of options, not all options with the same label.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Document that it groups runs in the JSDoc.
- **[F014]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js:118` — the back nav is duplicated.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Extract a local `BackNav`.
- **[F015]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js:288` — the models title is `Models — ${kind.toUpperCase()}`.
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Out of scope. The legacy card used the same title; YAN-414 covers the copy-tone sweep.
- **[F016]** `src/app/(dashboard)/dashboard/media-providers/web/page.js:94` — empty `propTypes` (pre-existing).
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Out of scope (unchanged from base).
- **[F017]** `src/shared/components/Select.js:101` — the `|| index` key fallback is dead code.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: `key={group.label}`.
- **[F018]** `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js:304` — a nested ternary picks the provider config (pre-existing).
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Out of scope (unchanged from base).
- **[F019]** `src/app/(dashboard)/dashboard/media-providers/components/mediaPageInfo.js:32` — the combo breadcrumb always links to the media root (pre-existing in `Header.js`).
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Out of scope (unchanged from base).

## Validation Results

| Check      | Result                     |
| ---------- | -------------------------- |
| Type check | Skipped (plain JS)         |
| Lint       | Pass                       |
| Tests      | Pass (0 fails vs baseline) |
| Build      | Pass                       |
| CI         | Pass (10/10 checks)        |

## Files Reviewed

See `git diff --name-only origin/re-design...redesign/yan-402-media-signal`: 49 source/test files (Added/Modified), 2 deleted (`ConnectionsCard.js`, `ModelsCard.js`), and 34 locale files (translation carry-over only).
