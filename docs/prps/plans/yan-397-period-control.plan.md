# Plan: YAN-397 shared period control and smart quiet-period empty states

## Summary

Add one canonical period model (`today | 24h | 7d | 30d | 60d`, lowercase labels) with URL state (`?period=`) and a remembered default in safe localStorage. Home, Usage and Token saver all use it. Add a cheap `GET /api/usage/last-activity` and a shared `QuietPeriod` empty state ("Quiet today · Last request 2 days ago · Show 7d"). Adopt it on all three pages, and make the Home requests sparkline follow the selected period.

## User Story

As a 9router operator, I want the dashboard to remember my period across pages, and on a quiet day tell me when the last request happened and jump to a period with data, so I don't see a wall of false "no usage" states.

## Problem → Solution

Each page has its own period list and casing, nothing goes in the URL, and quiet days stack up to four empty states (one says "No usage recorded yet", which is false). → One `period.js` model, a `usePeriod` hook, a `PeriodControl`, a `QuietPeriod` empty state fed by `/api/usage/last-activity`, one empty state per page, and a Token saver hero that shows the best non-empty period.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A (Linear YAN-397, GitHub #308)
- **PRD Phase**: N/A
- **Estimated Files**: ~22

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-redesign-yan-397-period-control/ (branch: redesign/yan-397-period-control, base origin/re-design)

## Batches

| Batch | Tasks         | Depends on                                                             |
| ----- | ------------- | ---------------------------------------------------------------------- |
| B1    | 1.1, 1.2, 1.3 | none (1.3 imports 1.1 helpers; run 1.1 first or code to the Contracts) |
| B2    | 2.1           | B1                                                                     |
| B3    | 3.1, 3.2, 3.3 | B2                                                                     |

---

## UX Design

### Before

```
Home  [Today|7d|30d] (zh: 今天/7天/30天)   ─ full-width card "No traffic in this period"
Usage [Today|24h|7D|30D|60D]               ─ "No usage in this period" + "No data for this period" + "No usage recorded yet."
Token saver [Today|7d|30d]                 ─ 330px lime "No savings recorded today yet"
Period resets to Today on every page load; not in URL.
Home requests sparkline = last 10 minutes regardless of period.
```

### After

```
All pages: PeriodControl, labels "Today 24h 7d 30d 60d" (Home/Token saver expose today/7d/30d).
URL ?period=7d; the choice is remembered in localStorage and carried to the other pages.
Quiet period:  [bedtime] Quiet today · Last request 2 days ago         [Show 7d]
Fresh install: [bolt]    No traffic yet · Point any OpenAI-compatible client at <origin>/v1
Home: one inline QuietPeriod row in the stats row.
Usage: one QuietPeriod card; chart and breakdown hidden; topology stays.
Token saver: hero shows the best non-empty period ("Saved in the last 30d · 412k tokens") with a "None today" note.
Never saved in 30d: compact inline empty state instead of the hero.
Home requests sparkline = chart buckets for the selected period (same window as the cost sparkline).
```

### Interaction Changes

| Touchpoint                   | Before            | After                                                    | Notes                                     |
| ---------------------------- | ----------------- | -------------------------------------------------------- | ----------------------------------------- |
| Period switch                | local state       | URL `?period=` via `history.replaceState` + localStorage | Other params (`tab`) kept                 |
| Page entry without `?period` | Today             | stored period, coerced to the page subset                | 24h→7d, 60d→30d on subset pages           |
| Quiet period action          | "View Usage" link | "Show 7d" button (smallest period that has data)         | No action when no allowed period has data |

---

## Mandatory Reading

| Priority | File                                                                | Lines              | Why                                                    |
| -------- | ------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| P0       | `src/app/(dashboard)/dashboard/usage/page.js`                       | all                | Usage period + Suspense + tab URL pattern              |
| P0       | `src/app/(dashboard)/dashboard/home/HomeStats.js`                   | 1-194              | No-traffic card, sparkline helpers                     |
| P0       | `src/app/(dashboard)/dashboard/home/HomePageClient.js`              | all                | Period owner on Home                                   |
| P0       | `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js`          | 1-150              | Hero empty/filled                                      |
| P0       | `src/app/(dashboard)/dashboard/token-saver/TokenSaverPageClient.js` | 30-210             | Savings fetch (file is 485 lines: extract, don't grow) |
| P0       | `src/lib/db/repos/usageRepo.js`                                     | 863-990, 1027-1050 | Chart buckets, savings periods                         |
| P1       | `src/shared/components/SegmentedControl.js`                         | all                | Radio group API                                        |
| P1       | `src/shared/components/EmptyState.js`                               | all                | Primitive to extend                                    |
| P1       | `src/shared/utils/commandPalette.js`                                | 115-150            | Safe storage pattern                                   |
| P1       | `src/app/(dashboard)/dashboard/home/useHomeData.js`                 | 1-80               | Period hooks                                           |
| P1       | `tests/unit/usage-chart.test.js`, `tests/unit/home-savings.test.js` | all                | DB seeding + route test pattern                        |
| P2       | `src/app/(dashboard)/dashboard/endpoint/hooks/useEndpointShell.js`  | 24-36              | `${origin}/v1` hint                                    |
| P2       | `src/dashboardGuard.js`                                             | 42-60, 227-233     | `/api/usage` auth handled by proxy                     |

## External Documentation

| Topic                            | Source                                       | Key Takeaway                                                                                                            |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Native history + useSearchParams | Next.js docs, "Using the native History API" | `window.history.replaceState(null, "", url)` syncs with `useSearchParams`/`usePathname` with no RSC round trip          |
| `Intl.RelativeTimeFormat`        | MDN                                          | `new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-2, "day")` gives "2 days ago" (localized, RTL-safe) |

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// src/shared/utils/commandPalette.js:7 — namespaced storage keys
export const RECENT_KEY = "signal.commandPalette.recents";
```

Pure helpers in `src/shared/utils/*.js` (no JSX, importable by the node test runner); hooks in `src/shared/hooks/use*.js` with `"use client"` + JSDoc; components default-exported with PropTypes + JSDoc summary.

### ERROR_HANDLING

```js
// src/app/api/usage/savings/route.js:8-17
try {
  return NextResponse.json(await getUsageSavings(period));
} catch (error) {
  console.error("[API] Failed to get usage savings:", error);
  return NextResponse.json({ error: "Failed to fetch savings" }, { status: 500 });
}
```

Storage: try/catch, never throw (`commandPalette.js:121-147`).

### LOGGING_PATTERN

`console.error("[API] Failed to …:", error)` in routes; `console.error("[usageRepo] … failed:", e.message)` in repo.

### REPOSITORY_PATTERN

```js
// usageRepo.js — adapter access
const db = await getAdapter();
const row = db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ?`, [start]);
```

New repo fns are exported from `src/lib/db/index.js` (lines ~100-114) and, if used by routes via `@/lib/usageDb`, from `src/lib/usageDb.js`.

### SERVICE_PATTERN

URL state (`combos/CombosPageClient.js:43-80`): pure href builder, `router.replace(href, { scroll: false })`, skip no-op. Pages that call `useSearchParams` wrap their client in `<Suspense fallback={<CardSkeleton />}>` (`usage/page.js:33-37`).

### TEST_STRUCTURE

```js
// tests/unit/home-savings.test.js:266-270 — route handler test
const { GET } = await import("../../src/app/api/usage/savings/route.js");
const res = await GET(new Request("http://localhost/api/usage/savings?period=nope"));
expect(res.status).toBe(400);
```

DB tests: `const db = await import("@/lib/db/index.js"); await db.initDb?.(); await db.saveRequestUsage({...timestamp})` (see `tests/unit/usage-chart.test.js` top). Per-file isolated DATA_DIR is automatic (`tests/setup/isolateDataDir.js`). Node env, no DOM: test pure helpers only.

---

## Contracts (all tasks code against these — do not deviate)

**`src/shared/utils/period.js`** (pure, no React):

- `export const PERIODS = [{value:"today",label:"Today"},{value:"24h",label:"24h"},{value:"7d",label:"7d"},{value:"30d",label:"30d"},{value:"60d",label:"60d"}]`
- `export const PERIOD_VALUES = PERIODS.map(p => p.value)`
- `export const SUMMARY_PERIODS = ["today","7d","30d"]` (subset exposed by Home and Token saver — their APIs only accept these)
- `export const PERIOD_STORAGE_KEY = "signal.period"`
- `export const DEFAULT_PERIOD = "today"`
- `export function isPeriod(value)` → boolean
- `export function coercePeriod(value, allowed = PERIOD_VALUES)` → if allowed includes value return it; else the first allowed period whose rank ≥ value's rank; else the largest allowed; invalid/unknown value → `allowed.includes(DEFAULT_PERIOD) ? DEFAULT_PERIOD : allowed[0]`.
- `export function resolvePeriod({ urlValue, storedValue, allowed })` → URL value if valid (coerced), else stored if valid (coerced), else default (coerced).
- `export function periodOptions(allowed)` → PERIODS filtered to allowed, order preserved.
- `export function periodStart(period, now = Date.now())` → ms. today = local midnight; 24h = now − 24h; 7d/30d/60d = local midnight of (today − (N−1)) (calendar days, matching `getUsageStats` daily summary; stricter than the rolling windows used by savings/summary, so a hit is guaranteed on every page).
- `export function smallestPeriodWithData(lastAt, allowed = PERIOD_VALUES, now = Date.now())` → first allowed period (ascending rank) whose `periodStart ≤ t(lastAt)`; timestamps in the future count as "today"; null/invalid lastAt → null; none match → null.
- `export function loadStoredPeriod(storage = defaultStorage())` / `export function saveStoredPeriod(value, storage = defaultStorage())` → never throw; load returns a valid period or null.
- `export const QUIET_TITLES = { today:"Quiet today", "24h":"Quiet in the last 24h", "7d":"Quiet in the last 7d", "30d":"Quiet in the last 30d", "60d":"Quiet in the last 60d" }`
- `export const SHOW_PERIOD_LABELS = { today:"Show today", "24h":"Show 24h", "7d":"Show 7d", "30d":"Show 30d", "60d":"Show 60d" }`
- `export function formatRelativeFromNow(iso, locale = "en", now = Date.now())` → `new Intl.RelativeTimeFormat(locale, { numeric: "always" })`; `diff = max(0, now − t)`; `≥ 1 day` → `format(-floor(diff/day), "day")`; `≥ 1 hour` → hours; else `format(-max(1, floor(diff/min)), "minute")`. Invalid iso → `""`. Invalid locale → fall back to `"en"` (catch RangeError).

**`src/shared/hooks/usePeriod.js`** (`"use client"`):

- `export default function usePeriod(allowed = PERIOD_VALUES)` → `{ period, setPeriod, options }`. `period` is `null` until mounted (localStorage unknown on the server); then `resolvePeriod({ urlValue: searchParams.get("period"), storedValue: loadStoredPeriod(), allowed })`. A valid URL value resolves synchronously (no flash on reload); only the stored fallback waits for mount. `setPeriod(v)`: coerce, save to storage, update local stored state, then `window.history.replaceState(null, "", pathname + "?" + params + hash)` keeping other params (Next.js syncs `useSearchParams` with native history; no RSC round trip). Skip no-op. `options = periodOptions(allowed)`. Requires a Suspense boundary (uses `useSearchParams`).

**`src/shared/components/PeriodControl.js`**: `PeriodControl({ value, onChange, options = PERIODS, size, className, "aria-label" = "Period" })` → `SegmentedControl` (radiogroup). When `value` is null render the control with no selection (disabled look is not needed). Applies the zh label override currently in `HomeHeader.js:28-38` (moved here, extended: 今天 / 24小时 / 7天 / 30天 / 60天) so zh parity is kept on every page. Export from `src/shared/components/index.js`.

**`src/shared/components/EmptyState.js`**: add `compact` bool prop → horizontal row: `flex flex-row items-center gap-3 px-4 py-3 text-start`, icon tile `size-10`, heading `text-sm font-semibold`, body inline muted, action pushed to the end (`ms-auto`). Default rendering unchanged.

**`src/shared/components/QuietPeriod.js`**: `QuietPeriod({ period, lastRequestAt, loading, allowed, onSelectPeriod, compact, className })`

- `loading` → `LoadingState` (lines 1) / skeleton row.
- `lastRequestAt === null` (never) → `EmptyState` icon `bolt`, title "No traffic yet", body: "Point any OpenAI-compatible client at" + `<code>{baseUrl}</code>` (baseUrl from `useLocalBaseUrl`).
- else → icon `bedtime`, title `QUIET_TITLES[period]`, body `<span>Last request</span> <time dateTime={iso}>{formatRelativeFromNow(iso, getCurrentLocale())}</time>` (separate text nodes so the runtime i18n translates "Last request"), action: when `target = smallestPeriodWithData(lastRequestAt, allowed)` exists and its rank > current period's rank → `<Button variant="secondary" size="sm" onClick={() => onSelectPeriod(target)}>{SHOW_PERIOD_LABELS[target]}</Button>`; else no action.
- Wrapped in `role="status"`? No — static content; the parent region is enough.

**`GET /api/usage/last-activity`** → `200 { lastRequestAt: string|null }`; 500 `{ error: "Failed to fetch last activity" }`. No query params (any are ignored). Auth: `/api/usage` prefix is protected by `src/dashboardGuard.js` like its neighbours. Repo: `getLastActivity()` in `usageRepo.js` → `db.get("SELECT timestamp FROM usageHistory ORDER BY timestamp DESC LIMIT 1")?.timestamp ?? null` (uses `idx_uh_ts`), exported via `src/lib/db/index.js`.

**`src/shared/hooks/useLastActivity.js`**: `useLastActivity(enabled)` → `{ lastRequestAt (undefined until loaded), loading, error }`; fetches only when `enabled` is true, once per enable, abortable.

**`src/shared/hooks/useEndpointShell.js`**: move `useRemoteHost` + `useLocalBaseUrl` from `src/app/(dashboard)/dashboard/endpoint/hooks/useEndpointShell.js` (delete the old file, update `EndpointPageClient.js` import).

**Chart buckets**: `getChartData` adds `requests` to every bucket (today/24h: count rows per bucket; daily: `dayData.requests || 0`). `shapeChartSeries` passes `requests` through.

---

## Files to Change

| File                                                                  | Action         | Justification                                                        |
| --------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| `src/shared/utils/period.js`                                          | CREATE         | Canonical period model + pure helpers (testable)                     |
| `src/shared/hooks/usePeriod.js`                                       | CREATE         | URL + storage period state                                           |
| `src/shared/hooks/useLastActivity.js`                                 | CREATE         | Lazy last-activity fetch                                             |
| `src/shared/hooks/useEndpointShell.js`                                | CREATE (moved) | Shared `useLocalBaseUrl` for the "No traffic yet" hint               |
| `src/app/(dashboard)/dashboard/endpoint/hooks/useEndpointShell.js`    | DELETE         | Moved to shared hooks                                                |
| `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`        | UPDATE         | Import path                                                          |
| `src/shared/components/PeriodControl.js`                              | CREATE         | Shared control (zh labels moved from HomeHeader)                     |
| `src/shared/components/QuietPeriod.js`                                | CREATE         | Shared quiet/never empty state                                       |
| `src/shared/components/EmptyState.js`                                 | UPDATE         | `compact` row variant                                                |
| `src/shared/components/index.js`                                      | UPDATE         | Export PeriodControl, QuietPeriod                                    |
| `src/lib/db/repos/usageRepo.js`                                       | UPDATE         | `getLastActivity`; `requests` in chart buckets                       |
| `src/lib/db/index.js`                                                 | UPDATE         | Export `getLastActivity`                                             |
| `src/app/api/usage/last-activity/route.js`                            | CREATE         | New endpoint                                                         |
| `src/app/(dashboard)/dashboard/usage/lib/usageShapes.js`              | UPDATE         | Pass `requests` through                                              |
| `src/app/(dashboard)/dashboard/page.js`                               | UPDATE         | Suspense around HomePageClient                                       |
| `src/app/(dashboard)/dashboard/home/HomePageClient.js`                | UPDATE         | usePeriod + last activity                                            |
| `src/app/(dashboard)/dashboard/home/HomeHeader.js`                    | UPDATE         | PeriodControl; drop HOME_PERIODS + zh override                       |
| `src/app/(dashboard)/dashboard/home/HomeStats.js`                     | UPDATE         | QuietPeriod row; requests sparkline from buckets                     |
| `src/app/(dashboard)/dashboard/home/useHomeData.js`                   | UPDATE         | Null-period guard (no fetch until resolved)                          |
| `src/app/(dashboard)/dashboard/usage/page.js`                         | UPDATE         | usePeriod, single QuietPeriod                                        |
| `src/app/(dashboard)/dashboard/usage/components/UsageStatsCards.js`   | UPDATE         | Remove own empty state                                               |
| `src/app/(dashboard)/dashboard/usage/components/UsageBreakdown.js`    | UPDATE         | View-specific empty copy only; `text-start/end` in touched lines     |
| `src/app/(dashboard)/dashboard/token-saver/page.js`                   | UPDATE         | Suspense                                                             |
| `src/app/(dashboard)/dashboard/token-saver/TokenSaverPageClient.js`   | UPDATE         | usePeriod + extracted savings hook                                   |
| `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js` | CREATE         | Savings fetch + best-period fallback (keeps page < 500 lines)        |
| `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js`            | UPDATE         | Best-period hero + "None today" note + never-saved compact state     |
| `src/app/(dashboard)/dashboard/token-saver/tokenSaverUtils.js`        | UPDATE         | Drop `SAVINGS_PERIODS` (replaced by shared)                          |
| `tests/unit/period.test.js`                                           | CREATE         | Parsing/validation/fallback, smallest period, relative time, storage |
| `tests/unit/usage-last-activity.test.js`                              | CREATE         | Repo + route: empty DB, latest wins, 200 shape                       |
| `tests/unit/usage-chart.test.js`                                      | UPDATE         | Assert `requests` per bucket                                         |

## NOT Building

- 24h/60d support for `/api/usage/savings` and `/api/home/summary`: Home and Token saver expose the `today/7d/30d` subset (scope allows "Pages may expose a subset"); a shared 24h/60d choice is coerced up (24h→7d, 60d→30d) on those pages.
- A multi-period savings endpoint (the fallback does at most two extra calls, only on empty periods).
- Carrying `?period` in sidebar links: carry-over works through the remembered default.
- LiveRoutes, Home layout beyond the stats row, Usage stream work (YAN-407), RequestLog.
- Editing `public/i18n/literals/*.json`.
- Calendar-month savings ("this month"): the rolling window is labelled "last 30d".

---

## Step-by-Step Tasks

### Task 1.1: Period model + tests (B1)

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: Create `src/shared/utils/period.js` per the Contracts section and `tests/unit/period.test.js` (write the tests first).
- **IMPLEMENT**: Pure functions only. `defaultStorage()` wraps `window.localStorage` access in try/catch (copy `commandPalette.js:143-149`). Tests cover: `isPeriod`; `coercePeriod` (valid, 24h→7d and 60d→30d on SUMMARY_PERIODS, invalid→today); `resolvePeriod` precedence (URL > stored > default, invalid URL falls through); `periodOptions` order; `smallestPeriodWithData` (null, just now→today, yesterday 23:00→24h or 7d depending on now, 2 days ago→7d, 20 days→30d, 45 days→60d, 90 days→null, future→today, subset allowed skips 24h); `formatRelativeFromNow` ("2 days ago", "3 hours ago", "1 minute ago" in en; ar output non-empty and differs from en; invalid → ""); storage helpers with a throwing fake storage and a garbage value.
- **MIRROR**: TEST_STRUCTURE, NAMING_CONVENTION
- **VALIDATE**: `cd tests && npx vitest run unit/period.test.js`

### Task 1.2: Last-activity endpoint + chart `requests` (B1)

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: Add `getLastActivity()` to `usageRepo.js`, export it from `src/lib/db/index.js`, create `src/app/api/usage/last-activity/route.js` (`dynamic = "force-dynamic"`, guard comment like savings route), add `requests` to every `getChartData` bucket, pass `requests` through `shapeChartSeries` (both branches). Tests first: `tests/unit/usage-last-activity.test.js` (empty DB → `{lastRequestAt:null}`; after two `saveRequestUsage` with explicit timestamps the later wins, even if inserted first; route returns 200 JSON). Extend `tests/unit/usage-chart.test.js` so each period sums `requests` to the seeded count.
- **MIRROR**: REPOSITORY_PATTERN, ERROR_HANDLING, TEST_STRUCTURE
- **VALIDATE**: `cd tests && npx vitest run unit/usage-last-activity.test.js unit/usage-chart.test.js unit/usage-shapes.test.js`

### Task 1.3: Shared UI primitives (B1)

- **BATCH**: B1
- **Depends on**: 1.1
- **ACTION**: Create `usePeriod.js`, `useLastActivity.js`, move `useEndpointShell.js` to `src/shared/hooks/` (update `EndpointPageClient.js`, delete old), create `PeriodControl.js`, `QuietPeriod.js`, add `compact` to `EmptyState.js`, export new components from `src/shared/components/index.js`.
- **IMPLEMENT**: Follow the Contracts exactly. PeriodControl reads the locale with `getCurrentLocale()` + `onLocaleChange` (as TokenSaverPageClient does) for the zh labels, instead of `document.documentElement.lang`. QuietPeriod uses `Button` from `@/shared/components/Button`, `EmptyState`, `LoadingState`/`Skeleton`; relative time uses `getCurrentLocale()`. PropTypes + JSDoc on every export. Logical classes only.
- **MIRROR**: SERVICE_PATTERN, NAMING_CONVENTION
- **VALIDATE**: `npx biome check <files>`; `rg -n "useEndpointShell" src` shows only the shared path.

### Task 2.1: Home adoption (B2)

- **BATCH**: B2
- **Depends on**: 1.1, 1.2, 1.3
- **ACTION**: Wrap `HomePageClient` in `<Suspense fallback={<CardSkeleton />}>` in `dashboard/page.js`. `HomePageClient`: `const { period, setPeriod, options } = usePeriod(SUMMARY_PERIODS)`; `useHomeUsage/Chart/Savings/Summary` take a null period and skip fetching (pass `null` url to `useHomeResource`, which already handles it). Quiet detection: `const quiet = Boolean(usage.current) && !usage.current.totalRequests`; `useLastActivity(quiet)`. `HomeHeader` renders `PeriodControl` (`aria-label="Stats period"`, options from props); remove `HOME_PERIODS` + the zh effect; propTypes `period: PropTypes.oneOf(SUMMARY_PERIODS)` (allow null). `HomeStats`: replace the full-width no-traffic card with `<div className="min-w-0 sm:col-span-2 lg:col-span-4"><Card><QuietPeriod compact … allowed={SUMMARY_PERIODS} onSelectPeriod={onSelectPeriod} /></Card></div>`-style single row (Card padding none, compact row); new props `lastRequestAt`, `lastActivityLoading`, `onSelectPeriod`, `period`. Requests sparkline: `requestsSparkline(buckets)` reading `bucket.requests`; update its JSDoc; remove `last10Minutes` usage.
- **MIRROR**: SERVICE_PATTERN
- **VALIDATE**: `npx biome check src/app/(dashboard)/dashboard/home src/app/(dashboard)/dashboard/page.js`; `cd tests && npx vitest run unit/home-format.test.js unit/home-command-center.test.js`

### Task 3.1: Usage adoption (B3)

- **BATCH**: B3
- **Depends on**: 2.1
- **ACTION**: `usage/page.js`: `usePeriod()` (full set), `PeriodControl size="sm" aria-label="Stats period"` in place of the local `PERIODS` + SegmentedControl. `useUsageStats(period)` must not fetch while `period` is null (guard inside the effect). `const quiet = stats && statsPeriod === period && !stats.totalRequests`; `useLastActivity(Boolean(quiet))`. When quiet: render one `<Card><QuietPeriod … onSelectPeriod={setPeriod} /></Card>` in place of `UsageStatsCards` + `UsageTokensChart` + `UsageBreakdown`; keep `UsageTopology`. `UsageStatsCards`: delete the "No usage in this period" branch (page owns it). `UsageBreakdown`: the empty branch now only covers "period has requests but this view's list is empty"; change the `VIEWS[*].empty` copy to truthful sentences ("No usage by model in this period.", "No account usage in this period.", "No API key usage in this period.", "No endpoint usage in this period."); switch `text-left`/`text-right` to `text-start`/`text-end` in this file.
- **MIRROR**: SERVICE_PATTERN
- **VALIDATE**: `npx biome check src/app/(dashboard)/dashboard/usage`; `cd tests && npx vitest run unit/usage-shapes.test.js`

### Task 3.2: Token saver adoption (B3)

- **BATCH**: B3
- **Depends on**: 2.1
- **ACTION**: Wrap the client in Suspense (`token-saver/page.js`). Create `useSavingsWithFallback(period, refreshKey)` → `{ savings, loading, error, fallback: { period, savings } | null, neverSaved }`: fetch `/api/usage/savings?period=` for the current period; if `tokensSavedEst <= 0`, fetch the next larger periods of `SUMMARY_PERIODS` in order until one has savings (stop at the first hit); `neverSaved` is true when all larger periods are empty too. Move the savings fetch effect out of `TokenSaverPageClient` into this hook; the page uses `usePeriod(SUMMARY_PERIODS)`. `TokenSaverHeader` uses `PeriodControl` (`aria-label="Savings period"`). `SavingsHero`: when the current period is empty and `fallback` exists, render the normal filled hero for `fallback.savings` with eyebrow `Saved in the last 7d`/`Saved in the last 30d` and a note line "None today" / "None in the last 7d" (static map, full sentences); when `neverSaved`, render a compact `EmptyState` (not a 330px lime card) with the existing copy. Remove `SAVINGS_PERIODS` from `tokenSaverUtils.js` if unused.
- **MIRROR**: ERROR_HANDLING, SERVICE_PATTERN
- **VALIDATE**: `npx biome check src/app/(dashboard)/dashboard/token-saver`; `wc -l` on TokenSaverPageClient.js < 500; `cd tests && npx vitest run unit/token-saver.test.js`

### Task 3.3: Wiring check (B3)

- **BATCH**: B3
- **Depends on**: 3.1, 3.2
- **MIRROR**: N/A (verification only)
- **IMPLEMENT**: Fix any leftover reference found.
- **ACTION**: `rg -n "HOME_PERIODS|SAVINGS_PERIODS|7D|30D|60D|No traffic in this period|No usage recorded yet" src` returns nothing relevant; `rg -n "last10Minutes" src/app` returns nothing.
- **VALIDATE**: commands above

---

## Testing Strategy

### Unit Tests

| Test                     | Input                   | Expected               | Edge case |
| ------------------------ | ----------------------- | ---------------------- | --------- |
| `coercePeriod`           | "24h", SUMMARY          | "7d"                   | yes       |
| `resolvePeriod`          | url "bad", stored "30d" | "30d"                  | yes       |
| `smallestPeriodWithData` | 2 days ago              | "7d"                   | no        |
| `smallestPeriodWithData` | 90 days ago             | null                   | yes       |
| `formatRelativeFromNow`  | 2 days, "en"            | "2 days ago"           | no        |
| storage                  | throwing storage        | null / no throw        | yes       |
| `getLastActivity`        | empty DB                | null                   | yes       |
| `getLastActivity`        | out-of-order inserts    | latest timestamp       | yes       |
| chart buckets            | seeded rows             | `requests` sum matches | no        |

### Edge Cases Checklist

- [x] Empty DB (fresh install)
- [x] Invalid URL / stored period
- [x] Storage denied (private mode)
- [x] Future timestamps
- [x] Subset pages receiving 24h/60d

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: no new diagnostics in touched files

### Unit Tests

```bash
cd tests && npx vitest run unit/period.test.js unit/usage-last-activity.test.js unit/usage-chart.test.js unit/usage-shapes.test.js unit/home-format.test.js unit/token-saver.test.js
```

### Full Test Suite

```bash
npm test
```

EXPECT: baseline gate passes. Delete `tests/translator/__snapshots__/golden-url-header.test.js.snap` if created.

### Build

```bash
npm run build
```

### Browser Validation

```bash
PORT=20131 NEXT_PUBLIC_BASE_URL=http://localhost:20131 DATA_DIR=<tmp> npm run dev
```

Three DATA_DIRs: never used, last request 2 days ago, traffic today. Dark + light at 1440/1024/390, keyboard only, `ar` locale, zero console errors or warnings. Screenshots go to `/home/yandy/Projects/github.com/yandy-r/9router/docs/redesign/screenshots/YAN-397/`.

### Manual Validation

- [ ] `?period=7d` on Home survives reload; Usage opens on 7d; Token saver opens on 7d.
- [ ] Choose 60d on Usage, then open Home: it shows 30d.
- [ ] "Show 7d" switches the period and updates the URL.

## Acceptance Criteria

- [ ] One period option set and label casing everywhere; URL; survives reload; carries across pages; unit-tested.
- [ ] Quiet day: a single QuietPeriod line per page with the last-activity time and a working jump; fresh install shows "No traffic yet".
- [ ] Usage never shows more than one empty state for the same reason.
- [ ] Token saver hero shows real savings from the best available period.
- [ ] Sparkline matches its label (the requests sparkline follows the selected period).

## Completion Checklist

- [ ] Contracts followed exactly
- [ ] PropTypes + JSDoc on new components/hooks
- [ ] Logical properties only
- [ ] No new dependencies; no `public/i18n/literals` edits
- [ ] All files < 500 lines

## Risks

| Risk                                                     | Likelihood | Impact | Mitigation                                          |
| -------------------------------------------------------- | ---------- | ------ | --------------------------------------------------- |
| `useSearchParams` without Suspense breaks the build      | M          | H      | Suspense on Home + Token saver pages                |
| Hydration mismatch from localStorage                     | M          | M      | `period` null until mount; fetch hooks skip null    |
| Runtime i18n misses dynamic strings                      | M          | L      | Static per-period literal maps; separate text nodes |
| `history.replaceState` not synced with `useSearchParams` | L          | M      | Next ≥14.1 supports it; verify in the browser       |

## Notes

- The "smallest period" math uses calendar-day starts (≤ every API's window), so the jump target always has data.
- `last10Minutes` stays in the `/api/usage/stats` payload (contract), it is just unused by Home now.
