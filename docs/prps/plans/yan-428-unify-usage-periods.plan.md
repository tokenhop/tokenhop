# Plan: Unify usage period windows (YAN-428)

## Summary

Make `src/shared/utils/period.js` the single source of truth for usage period values and windows. Every usage endpoint (`/api/usage/stats`, `/api/usage/chart`, `/api/usage/savings`, `/api/home/summary`) accepts today/24h/7d/30d/60d, and the same period means the same calendar window everywhere. Home and Token saver offer the full period set.

## User Story

As a dashboard user, I want "7d" to mean the same window on every tile and to pick 24h or 60d on Home and Token saver, so that numbers and deltas agree across pages.

## Problem → Solution

Stats/chart use calendar windows (local midnight of today−(N−1)); savings and home summary use rolling N×24h and accept only today/7d/30d, so Home's Requests delta compares a calendar value with a rolling baseline. Period lists are duplicated in six places. → One period module (calendar `periodStart` + `previousPeriodRange`), validated with `isPeriod` everywhere; savings and summary use it; the client subset `SUMMARY_PERIODS` goes away.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-428, GitHub #587)
- **PRD Phase**: N/A
- **Estimated Files**: 14
- **Target release**: v1.1.0, into `master`, no backport, no switch needed (every endpoint and page works end to end in the PR)

## Batches

| Batch | Tasks                       | Depends on |
| ----- | --------------------------- | ---------- |
| B1    | 1.1 (server) , 1.2 (client) | —          |
| B2    | 2.1 (tests)                 | B1         |

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop-yan-428/ (branch: feat/yan-428-unify-usage-periods)

---

## UX Design

### Before

Home / Token saver period control: `Today | 7d | 30d`. A stored or URL 24h/60d is coerced up to 7d/30d.

### After

Home / Token saver period control: `Today | 24h | 7d | 30d | 60d`, same as Usage. Token saver hero copy covers 24h and 60d.

### Interaction Changes

| Touchpoint                      | Before                               | After                             | Notes                                  |
| ------------------------------- | ------------------------------------ | --------------------------------- | -------------------------------------- |
| Home period control             | 3 options                            | 5 options                         | `usePeriod()` default                  |
| Token saver period control      | 3 options                            | 5 options                         | fallback chain uses all larger periods |
| Home Requests delta             | calendar current vs rolling previous | calendar vs `previousPeriodRange` | matches Usage `compare=previous`       |
| Saved tile / Token saver totals | rolling 7d/30d                       | calendar 7d/30d                   | same window as Tokens/Cost tiles       |

---

## Mandatory Reading

| Priority | File                                                                                              | Lines                                                 | Why                                                     |
| -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| P0       | `src/shared/utils/period.js`                                                                      | 1-140                                                 | canonical periods, `periodStart`, `previousPeriodRange` |
| P0       | `src/lib/db/repos/usageRepo.js`                                                                   | 86-92, 483-491, 609-614, 785-802, 937-1063, 1150-1400 | duplicated windows to replace                           |
| P0       | `src/app/api/usage/stats/route.js`                                                                | all                                                   | already uses the shared module                          |
| P1       | `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js`                                        | 1-70, 190-220                                         | period-keyed copy                                       |
| P1       | `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js`                             | 36-60                                                 | fallback candidates                                     |
| P1       | `tests/unit/home-savings.test.js`, `tests/unit/period.test.js`, `tests/unit/usage-trends.test.js` | all                                                   | tests to update/extend                                  |

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// src/shared/utils/period.js
export const PERIOD_VALUES = PERIODS.map((p) => p.value);
export function isPeriod(value) {
  return PERIOD_VALUES.includes(value);
}
```

### ERROR_HANDLING

```js
// routes: 400 before try, generic 500 with [API] prefix
if (!isPeriod(period)) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
// repo: plain Error with "Invalid period:" prefix (tests match /Invalid period/)
if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
```

### LOGGING_PATTERN

```js
console.error("[API] Failed to get usage savings:", error);
```

### REPOSITORY_PATTERN

```js
// half-open window, ms -> ISO bind (getUsageTotals)
FROM usageHistory WHERE timestamp >= ? AND timestamp < ?`,
[new Date(start).toISOString(), new Date(end).toISOString()],
```

### SERVICE_PATTERN

```js
// stats route compare=previous
const currentRange = { start: periodStart(period, now), end: now };
const previousRange = previousPeriodRange(period, now);
```

### TEST_STRUCTURE

```js
// DST: spawn child node with TZ=America/New_York (period.test.js:67-77)
execFileSync(process.execPath, ["--input-type=module", "-e", script], {
  env: { ...process.env, TZ: "America/New_York" },
  encoding: "utf8",
});
// DB: temp DATA_DIR + vi.resetModules() + initDb(); seed via adapter.run INSERT with ISO timestamp
```

---

## Files to Change

| File                                                                                                     | Action | Justification                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/utils/period.js`                                                                             | UPDATE | drop `SUMMARY_PERIODS`; export `PERIOD_DAYS` (was private `DAY_COUNTS`); document calendar definition                                                     |
| `src/lib/db/repos/usageRepo.js`                                                                          | UPDATE | drop `SAVINGS_PERIODS`, `savingsPeriodRange`, `PERIOD_MS`, local day maps; savings/summary use `periodStart`/`previousPeriodRange`; accept optional `now` |
| `src/lib/home/savings.js`                                                                                | UPDATE | drop `VALID_PERIODS`; `resolvePeriodRange` delegates to period.js                                                                                         |
| `src/lib/home/summary.js`                                                                                | UPDATE | JSDoc period set                                                                                                                                          |
| `src/app/api/usage/{stats,chart,savings}/route.js`, `src/app/api/home/summary/route.js`                  | UPDATE | validate with `isPeriod`                                                                                                                                  |
| `src/app/(dashboard)/dashboard/home/{HomePageClient,HomeHeader,HomeStats,useHomeData}.js`                | UPDATE | full period set                                                                                                                                           |
| `src/app/(dashboard)/dashboard/token-saver/{TokenSaverPageClient,SavingsHero,useSavingsWithFallback}.js` | UPDATE | full period set + 24h/60d copy                                                                                                                            |
| `tests/unit/period.test.js`, `tests/unit/home-savings.test.js`                                           | UPDATE | coercion tests use explicit subset; window math + previous window + 24h/60d acceptance                                                                    |

## NOT Building

- 90d / all-time / custom ranges (YAN-421, YAN-426).
- Period-over-period UI changes (YAN-429).
- Rewriting `getUsageStats`/`getChartData` aggregation (already calendar; only their period lists change).
- Deleting the test-only `computeHomeSummary` module.
- Locale translations (CI `i18n-translate.yml` translates new English literals after merge).

---

## Step-by-Step Tasks

### Task 1.1: Server period unification

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: Make period.js the only server period definition and switch savings/summary to calendar windows.
- **IMPLEMENT**: In `period.js` rename `DAY_COUNTS` to exported `PERIOD_DAYS`, delete `SUMMARY_PERIODS`, document "calendar days from local server midnight; 24h is rolling". In `usageRepo.js` import `isPeriod, periodStart, previousPeriodRange, PERIOD_DAYS` from `@/shared/utils/period`; `getUsageSavings(period = "7d", now = Date.now())` and `getHomeSummary(period = "7d", now = Date.now())` throw `Invalid period:` when `!isPeriod`, current window `[periodStart, now]`; summary previous count via `getUsageTotals(previousPeriodRange(period, now)).requests` (half-open, same as stats compare). Replace `PERIOD_MS`, `periodDays`, chart `bucketCount` ternary and today/24h cutoff with `PERIOD_DAYS` / `periodStart`. Routes validate with `isPeriod` (stats: `period === "all" || isPeriod(period)`). `src/lib/home/savings.js`: `resolvePeriodRange` returns `{startMs: periodStart, endMs: now, prevStartMs, prevEndMs}` from period.js, throwing `Invalid period` for unknown.
- **MIRROR**: SERVICE_PATTERN, ERROR_HANDLING, REPOSITORY_PATTERN.
- **VALIDATE**: `npm run lint`; `npx vitest run -c tests/vitest.config.js tests/unit/home-savings.test.js tests/unit/usage-trends.test.js` (from repo root).

### Task 1.2: Client full period set

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: Home and Token saver use the full period set.
- **IMPLEMENT**: Replace `usePeriod(SUMMARY_PERIODS)` with `usePeriod()`; HomeStats drops `allowed={SUMMARY_PERIODS}` (QuietPeriod defaults to `PERIOD_VALUES`); PropTypes use `PERIOD_VALUES`; JSDoc period unions list all five. `SavingsHero` uses default `PeriodControl` options (`PERIODS`) and adds 24h/60d keys to `SAVED_COPY`/`FALLBACK_COPY`, 24h/30d to `QUIET_NOTES` (literal English phrases, keyed). `useSavingsWithFallback` candidates from `PERIOD_VALUES`.
- **MIRROR**: NAMING_CONVENTION.
- **VALIDATE**: `npm run lint`; `grep -rn SUMMARY_PERIODS src` returns nothing.

### Task 2.1: Tests

- **BATCH**: B2
- **Depends on**: 1.1, 1.2
- **ACTION**: Update and add critical tests only.
- **IMPLEMENT**: `period.test.js` coercion cases pass an explicit subset `["today","7d","30d"]` instead of `SUMMARY_PERIODS`. `home-savings.test.js`: `resolvePeriodRange` expects calendar starts (7d = local midnight of today−6) and accepts 24h/60d; add one DB test seeding rows just inside/outside the 7d calendar window and in the previous window with fixed `now`, asserting `getUsageSavings`/`getHomeSummary` counts and `previousRequests`; add route test that `period=24h` and `period=60d` return 200 on savings and home summary. DST already covered by period.test.js/usage-trends.test.js for the shared functions now used everywhere.
- **MIRROR**: TEST_STRUCTURE.
- **VALIDATE**: `npm test` (no regressions vs baseline gate).

---

## Testing Strategy

### Unit Tests

- Window math: `resolvePeriodRange`/`getUsageSavings`/`getHomeSummary` with fixed `now`.
- Previous window: `getHomeSummary.previousRequests` counts only rows in `previousPeriodRange`.
- Validation: 24h/60d accepted (200), unknown rejected (400 / throw).

### Edge Cases Checklist

- [ ] Row exactly at previous-window end is not counted twice.
- [ ] `today` previous = same elapsed slice of yesterday.
- [ ] DST day (shared `periodStart`/`previousPeriodRange` tests already spawn TZ=America/New_York).
- [ ] Stored `signal.period` of 24h/60d now opens Home on that period instead of coercing.

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/period.test.js tests/unit/home-savings.test.js tests/unit/home-summary.test.js tests/unit/usage-trends.test.js
```

### Full Test Suite

```bash
npm test
```

### Browser Validation (if applicable)

```bash
npm run build
```

### Manual Validation

- Home: pick 24h and 60d; tiles load, Requests delta renders.
- Token saver: pick 24h and 60d; hero shows "Saved last 24h"/"Saved last 60d" or fallback copy.

---

## Acceptance Criteria

- [ ] Every usage endpoint accepts today/24h/7d/30d/60d, and the same period means the same window everywhere.
- [ ] One source of truth for period values and windows; no duplicated lists (`SUMMARY_PERIODS`, `SAVINGS_PERIODS`, `VALID_PERIODS`, route Sets, `PERIOD_MS` gone).
- [ ] Unit tests cover window math (DST via shared functions) and the previous-window calculation.

## Completion Checklist

- [ ] Lint clean
- [ ] `npm test` no regressions
- [ ] `npm run build` passes
- [ ] PR into `master` with `Closes YAN-428` and `Closes #587`

## Risks

| Risk                                                         | Likelihood | Impact | Mitigation                                                    |
| ------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------- |
| Saved totals for 7d/30d shrink slightly (calendar < rolling) | High       | Low    | Intended: matches other tiles; note in PR                     |
| Server timezone differs from browser                         | Medium     | Low    | Already true for stats/chart; unchanged behavior              |
| `@/` import in usageRepo                                     | Low        | Medium | `settingsRepo.js` already imports `@/shared/brand` statically |

## Notes

Definition chosen: calendar (local server midnight) for today/7d/30d/60d, rolling for 24h, because stats and chart (the bulk of tiles, including the daily `usageDaily` rollup keyed by local `dateKey`) already work that way; rolling windows cannot be served from the daily rollup.
