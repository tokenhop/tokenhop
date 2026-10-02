# PR Review #560 — feat(cli-tools): persist single-model card settings (Cline, Kilo, DeepSeek TUI, jcode, Hermes)

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-638-single-model-card-settings → master
**Decision**: APPROVE (after fixes)

## Summary

Parallel review (correctness, security, quality). Correctness found nothing blocking. Security found one HIGH: the Hermes YAML builder interpolated the model and URL raw, and this PR makes those values remotely persistable. Quality flagged a misleading local name and a stale plan. All fixed in the follow-up commit.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `src/lib/cliToolConfigs/hermes.js:11` — `buildModelBlock` interpolated `model` and `baseUrl` into double-quoted YAML. A saved value with `"` and a newline (writable by any signed-in remote user since this PR) could inject top-level keys into `~/.hermes/config.yaml` on the host's next Apply.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Quote with `JSON.stringify` (valid YAML double-quoted scalar); test in `tests/unit/cli-setup-settings.test.js`.

### MEDIUM

- **[F002]** `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js:56` — The API accepts one nested object per key (Claude's `models`), so a saved `model: {…}` reached the inputs and Apply bodies of single-model cards.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: The hook returns `model` and `endpoint` as strings only (non-strings read as empty).
- **[F003]** `src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js:53` — Local `saved` held the whole helper bundle, including unsaved state; `useToolSettings` already uses `saved` for the stored row. Same in the other four cards.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Renamed to `setup`; cards read `setup.model` / `setup.setModel`.

### LOW

- **[F004]** `docs/prps/plans/yan-638-single-model-card-settings.plan.md:48` — Plan placed the hook in `setupCard.js`, omitted the new files, said "no new tests" and blurred the two resets.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Updated Architecture, Files to Change, Testing Strategy and Acceptance Criteria.
- **[F005]** `src/app/(dashboard)/dashboard/cli-tools/components/EndpointSegmentedPicker.js:94` — Mount-once init; a saved endpoint arriving after mount wouldn't reselect the picker. The scaffold renders the picker only after settings load, so this only happens on cross-tab edits. Inherited from #543.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: None now; revisit with YAN-647.
- **[F006]** `src/lib/cliToolConfigs/hermes.js:20` — `upsertEnvVar` writes the API key unquoted into `.env`. Pre-existing; the key is host-resolved, never remote text.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: None needed here.

## Validation Results

| Check      | Result                           |
| ---------- | -------------------------------- |
| Type check | Skipped (no tsconfig)            |
| Lint       | Pass                             |
| Tests      | Pass (`npm test`, 0 regressions) |
| Build      | Pass                             |

## Files Reviewed

- `src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/KiloToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/JcodeToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/setupCard.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/hooks/useSetupSettings.js` (Added)
- `src/lib/cliToolConfigs/hermes.js` (Modified)
- `src/lib/cliToolConfigs/jcode.js` (Modified)
- `src/shared/constants/cliTools.js` (Modified)
- `tests/unit/cli-setup-settings.test.js` (Added)
