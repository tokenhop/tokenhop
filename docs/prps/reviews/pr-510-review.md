# PR Review #510 — fix(dashboard): count percentage-only quota rows as empty and key combo rows by id

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: fix/yan-643-yan-644-quota-empty-and-combo-rows → master
**Decision**: APPROVE with comments

## Worktree Setup

- **Parent**: .claude/worktrees/yan-643-644/ (branch: fix/yan-643-yan-644-quota-empty-and-combo-rows)

## Summary

Both fixes are correct and backport cleanly to `release/0.6`. The PR base matches RELEASING.md (`master`, `backport:0.6`). No CRITICAL or HIGH findings survived verification. The security reviewer's HIGH (kimi `makeQuota` placeholder 0) is a false positive: every call site passes `total > 0`, so the `total 0` branch never runs.

## Findings

### MEDIUM

- **[F001]** `src/app/(dashboard)/dashboard/quota/quotaSummary.js:123` — `hasRemaining` uses `!== undefined`, so `remaining: null` or `remainingPercentage: null` with total 0 reads as 0% and counts as depleted
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Use `quota?.remaining != null || quota?.remainingPercentage != null`

- **[F002]** `src/shared/components/ComboFormModal.js:127` — A second stable-id scheme (ref counter) next to `assignStepIds` in ComboEditor, and the reason isn't documented
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Say in the comment why a counter fits here (the modal owns its list, and `assignStepIds` derives ids from model strings)

- **[F003]** `open-sse/services/usage/zed.js:40` — `parseZedUsageLimit(null)` gives `total: 0`, so a bucket with no `limit` field becomes a `{ total: 0, remainingPercentage: 0 }` row and is now a bulk "off" target
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: None in this PR. The card already shows this row as "Empty" (`getAccountWorstRemaining`), and the bulk action is user-triggered. Telling "missing" apart from `limited: 0` is a parser change for a follow-up.

### LOW

- **[F004]** `src/shared/components/ComboFormModal.js:174` — The duplicate notice clears only on a successful edit, so it lingers after add, remove or deselect
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Clear `editNotice` in `handleAddModel`, `handleDeselectModel` and `handleRemoveModel`

- **[F005]** `src/shared/components/ComboFormModal.js:286` — The notice uses `role="status"`, while `nameError` in the same file uses `role="alert"`
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Keep `role="status"`. The live region stays mounted, so screen readers announce changes, and a rejected duplicate isn't urgent.

- **[F006]** `src/shared/components/ComboFormModal.js:130` — `models` is re-derived on every render
  - **Status**: Open
  - **Category**: Performance
  - **Suggested fix**: None. At combo-list size the cost is negligible.

## Validation Results

| Check      | Result                           |
| ---------- | -------------------------------- |
| Type check | Skipped (JS project)             |
| Lint       | Pass (Biome)                     |
| Tests      | Pass (`npm test`, 0 regressions) |
| Build      | Pass (`npm run build`)           |

## Files Reviewed

- `src/app/(dashboard)/dashboard/quota/quotaSummary.js` (Modified)
- `src/shared/components/ComboFormModal.js` (Modified)
- `tests/unit/quota-summary.test.js` (Modified)
