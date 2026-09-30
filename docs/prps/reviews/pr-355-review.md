# PR Review #355 — fix(providers): pin Your providers on top and remove duplicate list controls

**Reviewed**: 2026-09-29
**Mode**: PR
**Author**: yandy-r
**Branch**: redesign/yan-405-providers-list-polish → re-design
**Decision**: REQUEST CHANGES

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-redesign-yan-405-providers-list-polish/ (branch: redesign/yan-405-providers-list-polish)

## Summary

The scope matches YAN-405, parity is preserved and validation is green. There is one HIGH finding: the optimistic toggle rollback misses HTTP failures. The same bug exists on the base branch, but this PR rewrites the handler, so it's fixed here. Three reviewers (correctness, security, quality) ran in parallel.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `src/app/(dashboard)/dashboard/providers/useProviderActions.js:39` — Enable/disable rollback only runs when the network request is rejected. A 4xx/5xx PUT leaves the optimistic `isActive` state in place, with no toast and no reload.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Treat `!o.value.ok` as a failure too: roll back, call `notifyError`, then `refreshData()`.

### MEDIUM

- **[F002]** `src/app/(dashboard)/dashboard/providers/useProviderActions.js:104` — `handleTestAccounts` ignores `res.ok`, so a failed test ends silently. This is inconsistent with `handleBatchTest`.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `if (!res.ok) notifyError("Account test failed");` before `refreshData()`.
- **[F003]** `src/app/api/providers/route.js:100` — Each connection's quota snapshot is read twice per GET (once for `effectiveWeight`, once for `quotaRemaining`), and `buildQuotaSnapshotView` also computes an effective weight that nothing uses.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Read `getSnapshot(c.id)` once and derive both fields from it.
- **[F004]** `src/app/(dashboard)/dashboard/providers/components/YourProviders.js:72` — Template-literal counts ("N accounts", "N% quota left", "N providers") and "Testing…" are skipped by the literal extractor.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: None in this PR. The pattern already exists on the base branch (`ProviderCard` counts, the old shell's "Testing…"), and parameterised copy belongs to the i18n owner (YAN-409 follow-up).

### LOW

- **[F005]** `src/app/(dashboard)/dashboard/providers/components/YourProviders.js:53` — The quota hint takes the minimum across disabled accounts too.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `quotaLeft(enabled)`.
- **[F006]** `src/app/(dashboard)/dashboard/providers/components/YourProviders.js:88` — A row Test can overlap Test all, sending two concurrent test-batch POSTs.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Disable row Test while `testingMode` is set, and disable Test all while `testAccountsMode` is set.
- **[F007]** `src/app/(dashboard)/dashboard/providers/useProviderActions.js:27` — The ref is written during render, so a discarded render can update it.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Sync the ref in `useEffect`.
- **[F008]** `src/app/(dashboard)/dashboard/providers/components/YourProviders.js:61` — The selected row is labelled "Close … details", but clicking it doesn't close anything.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Make a selected-row click toggle closed (pass `onClose`).
- **[F009]** `src/app/(dashboard)/dashboard/providers/useCollapsedGroups.js:19` — Accepts a persisted array.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Reject `Array.isArray(parsed)`.
- **[F010]** `src/app/(dashboard)/dashboard/providers/components/CatalogSection.js:111` — The "Show all N →" arrow doesn't mirror in RTL.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Use an icon span with `rtl:-scale-x-100`.
- **[F011]** `src/app/(dashboard)/dashboard/providers/sections.js:195` — Dead re-export of the compatible prefixes.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Remove the re-export and its import if nothing else uses it.
- **[F012]** `public/i18n/literals/zh-CN.json` — Formality mismatch: 你 in "Your providers" vs 您 elsewhere. `ar.json` uses موفر where the page uses مزود.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Use 您 in zh-CN and مزود in ar.
- **[F013]** `tests/unit/provider-sections.test.js` — No tests for `useCollapsedGroups` or `quotaLeft`.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: None. Per the goal, only critical tests are added; both are small and were verified in the browser.

## Validation Results

| Check      | Result                           |
| ---------- | -------------------------------- |
| Type check | Skipped (plain JS)               |
| Lint       | Pass                             |
| Tests      | Pass (no regression vs baseline) |
| Build      | Pass                             |

## Files Reviewed

- `src/app/(dashboard)/dashboard/providers/ProvidersListShell.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/providerSections.js` (Added)
- `src/app/(dashboard)/dashboard/providers/sections.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/useCollapsedGroups.js` (Added)
- `src/app/(dashboard)/dashboard/providers/useProviderActions.js` (Added)
- `src/app/(dashboard)/dashboard/providers/useProviderSections.js` (Added)
- `src/app/(dashboard)/dashboard/providers/components/BringYourOwnCard.js` (Added)
- `src/app/(dashboard)/dashboard/providers/components/CatalogSection.js` (Added)
- `src/app/(dashboard)/dashboard/providers/components/NeedsAttentionCard.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/components/ProviderCard.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/components/ProviderDetailSidePanel.js` (Modified)
- `src/app/(dashboard)/dashboard/providers/components/YourProviders.js` (Added)
- `src/app/api/providers/route.js` (Modified)
- `tests/unit/provider-sections.test.js` (Added)
- `public/i18n/literals/*.json` (Modified, 34 files)
