# Plan: YAN-404 Home polish — one primary, clickable recent requests, client-side links, one focus refresh

## Summary

Polish the dashboard Home command center (`src/app/(dashboard)/dashboard/home/`): status line above an in-page H1 with the period control on the H1 row, one copy control and one lime primary on the endpoint card, `next/link` everywhere with RTL-mirrored arrows, recent-request rows that open the shared request detail drawer, readable key names, natural-height bottom cards, and a single throttled, staleness-aware focus refresh backed by a de-duplicating GET store.

## User Story

As a 9router operator, I want Home to navigate instantly, open request details in place and stop re-fetching everything on every tab focus, so that the command center feels fast and consistent.

## Problem → Solution

13 `useHomeResource` instances each add a `visibilitychange` listener (13 GETs per focus, even when data is seconds old), `/api/settings` loads twice, eight raw `<a>` links reload the app, "All logs" opens the overview, rows are dead, the status line sits under the H1 → one listener with a 15 s throttle refreshing only entries older than 30 s, one GET per URL, `next/link`, `?tab=logs`, button rows opening `RequestDetailDrawer`, header order status → H1 + period.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-404, GitHub #315)
- **PRD Phase**: N/A
- **Estimated Files**: 14

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-redesign-yan-404-home-polish/ (branch: redesign/yan-404-home-polish)

## Batches

| Batch | Tasks         | Notes                                    |
| ----- | ------------- | ---------------------------------------- |
| 1     | 1.1, 1.2, 1.3 | Disjoint files; run in parallel          |
| 2     | 2.1           | Lint/test/build + re-measure, sequential |

---

## UX Design

### Before

```
[shell] Command center                         [⌘K] [♥] [EN]
All routes humming                                [Today|7d|30d]
┌ YOUR ENDPOINT ─────────────── Endpoint settings (full reload) ┐
│ http://…/v1  [⧉]   [ Copy ]  ← two copy controls             │
│ Local · Tailscale · Cloudflare [Enable h-6] · API key        │
Recent requests rows: static <li>; "All logs →" → /dashboard/usage
Bottom row: three cards stretched to equal height
```

### After

```
[shell]                                        [⌘K] [♥] [EN]
All routes humming                       (status line, muted)
Command center                                  [Today|7d|30d]
┌ YOUR ENDPOINT ─────────────── Endpoint settings (next/link) ┐
│ http://…/v1 (mono block)   [ Copy ]  ← one control, lime    │
│ Local · Tailscale · Cloudflare [Enable outline] · API key   │
Recent requests rows: <button> → RequestDetailDrawer; "All logs →" → ?tab=logs
Bottom row: cards size to content (items-start)
```

### Interaction Changes

| Touchpoint | Before                     | After                                | Notes                                |
| ---------- | -------------------------- | ------------------------------------ | ------------------------------------ |
| Tab focus  | 13 GETs every focus        | ≤1 GET per stale URL, throttled 15 s | staleness 30 s                       |
| Home load  | `/api/settings` ×2         | ×1                                   | shared store dedupes                 |
| Card links | full reload                | client nav                           | arrows mirror in RTL                 |
| Recent row | static                     | Enter/Space/click opens drawer       | fallback rows (no id) stay static    |
| Keys       | name squeezed to "Defaul…" | name keeps width, mask shrinks       | `duplicateKeyLabel` already suffixes |

---

## Mandatory Reading

| Priority | File                                                                     | Lines            | Why                                                             |
| -------- | ------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------- |
| P0       | `src/app/(dashboard)/dashboard/home/useHomeResource.js`                  | all              | Hook being replaced by the store-backed version                 |
| P0       | `src/app/(dashboard)/dashboard/home/useHomePollingResource.js`           | all              | Folded into `useHomeResource` (intervalMs option), then deleted |
| P0       | `src/app/(dashboard)/dashboard/home/useHomeData.js`                      | all              | Callers                                                         |
| P0       | `src/shared/hooks/useShellStatus.js`                                     | 55-160           | Module store, throttle, coalescing pattern to mirror            |
| P0       | `src/app/(dashboard)/dashboard/usage/components/RequestDetailDrawer.js`  | 60-90, 260-275   | Drawer API `{detail,isOpen,onClose,providerName}`               |
| P0       | `src/app/(dashboard)/dashboard/usage/components/RequestLog.js`           | 1-30, 240-290    | Current opener + private `providerLabel`                        |
| P1       | `src/shared/components/Header.js`                                        | 200-215, 280-330 | `getPageInfo('/dashboard')`, in-page H1 precedent               |
| P1       | `src/app/(dashboard)/dashboard/providers/detail/ProviderDetailHeader.js` | 45-60            | In-page H1 classes                                              |
| P1       | `tests/unit/shell-summary.test.js`                                       | 128-190          | Store/visibility test pattern                                   |

## External Documentation

No external research needed — internal patterns only (`next/link` already used across the dashboard).

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: home/useHomeData.js:14
export function useHomeUsage(period, refreshKey = 0) {
  const { data, loading, error } = useHomeResource(`/api/usage/stats?period=${period}`, refreshKey);
```

### ERROR_HANDLING

```js
// SOURCE: home/useHomePollingResource.js:36-46 — keep last good data, surface error
setState((current) => ({
  ...current,
  loading: false,
  error: error.message || "Unable to load data",
}));
```

### REPOSITORY_PATTERN (module store)

```js
// SOURCE: src/shared/hooks/useShellStatus.js:56-65
const store = {
  state: INITIAL_STATE,
  listeners: new Set(),
  timer: null,
  inFlight: null,
  queued: false,
  lastRefreshAt: 0,
};
export const FOCUS_THROTTLE_MS = 15_000;
```

### LINK + RTL ARROW

```js
// SOURCE: settings/sections/AutoPingList.js:82-90
<Link href={…} className="text-[13px] font-semibold text-coral-ink hover:text-coral">
  … <span aria-hidden="true" className="inline-block rtl:-scale-x-100">→</span>
```

### IN-PAGE H1

```js
// SOURCE: providers/detail/ProviderDetailHeader.js:52
<h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-text lg:text-[42px] lg:leading-[1.05]">
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/shell-summary.test.js:128-150
vi.stubGlobal("fetch", fetchMock);
const mod = await import("@/shared/hooks/useShellStatus.js");
```

---

## Files to Change

| File                                                                                               | Action | Justification                                                       |
| -------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `src/app/(dashboard)/dashboard/home/homeResourceStore.js`                                          | CREATE | URL-keyed GET store: dedupe, staleness, throttled focus refresh     |
| `src/app/(dashboard)/dashboard/home/useHomeResource.js`                                            | UPDATE | Subscribe to the store; no per-hook listener; optional `intervalMs` |
| `src/app/(dashboard)/dashboard/home/useHomePollingResource.js`                                     | DELETE | Folded into `useHomeResource`                                       |
| `src/app/(dashboard)/dashboard/home/useHomeData.js`                                                | UPDATE | Live routes uses `useHomeResource(url, key, { intervalMs })`        |
| `src/app/(dashboard)/dashboard/home/HomePageClient.js`                                             | UPDATE | One visibility listener; bottom grid `items-start`                  |
| `src/app/(dashboard)/dashboard/home/HomeHeader.js`                                                 | UPDATE | Status line above in-page H1, period control on H1 row              |
| `src/shared/components/Header.js`                                                                  | UPDATE | `/dashboard` title "" (page renders its own H1)                     |
| `src/app/(dashboard)/dashboard/home/WidgetStates.js`                                               | UPDATE | Shared `CardLink` (next/link + mirrored arrow)                      |
| `src/app/(dashboard)/dashboard/home/EndpointHero.js`                                               | UPDATE | One copy control, outline Enable, Link                              |
| `src/app/(dashboard)/dashboard/home/KeysSummary.js`                                                | UPDATE | Name width                                                          |
| `src/app/(dashboard)/dashboard/home/{HomeStats,QuotaWatch,CombosTop,ProviderHealth,LiveRoutes}.js` | UPDATE | `<a>` → Link/CardLink (LiveRoutes: one link only; YAN-406 merged)   |
| `src/app/(dashboard)/dashboard/home/RecentRequests.js`                                             | UPDATE | Button rows, drawer, `?tab=logs`                                    |
| `src/app/(dashboard)/dashboard/usage/components/RequestDetailDrawer.js`                            | UPDATE | Export shared `providerLabel` entry                                 |
| `src/app/(dashboard)/dashboard/usage/components/RequestLog.js`                                     | UPDATE | Import `providerLabel` from the drawer module                       |
| `tests/unit/home-resource-store.test.js`                                                           | CREATE | Critical: dedupe, staleness, throttle                               |

## NOT Building

- Period URL state / `PeriodControl` / QuietPeriod / sparkline — YAN-397 (in progress; `period` stays a plain prop so YAN-397 swaps it in).
- Live routes map behaviour (YAN-412), provider health rules (YAN-391).
- Combos card top-3 redesign — the bottom row uses natural heights instead (scope item 7 offers either).
- Locale JSON edits (`public/i18n/literals/*.json`).

---

## Step-by-Step Tasks

### Task 1.1: Shared GET store + single focus refresh

- **BATCH**: 1
- **Depends on**: none
- **ACTION**: Create `homeResourceStore.js`; rewrite `useHomeResource.js` on it; delete `useHomePollingResource.js`; update `useHomeData.js` and `HomePageClient.js`; add `tests/unit/home-resource-store.test.js`.
- **IMPLEMENT**: Store keyed by URL `{ data, error, at, inflight, inflightKey, subs:Set }`. `subscribe(url, fn)` (drops the entry when the last subscriber leaves), `loadResource(url, { key })` joins an in-flight request started for the same key (dedupes same-URL hooks in one commit) else starts a new one; `refreshStaleResources(now)` reloads subscribed entries older than `STALE_MS=30_000` with no in-flight request; `onHomeFocus(now)` throttles to `FOCUS_THROTTLE_MS=15_000` then calls it. Hook keeps last good data on refresh (loading only when no data), surfaces errors, supports `intervalMs` polling paused while hidden. `HomePageClient` registers one `visibilitychange` listener calling `onHomeFocus()`; bottom grid gets `items-start`.
- **MIRROR**: REPOSITORY_PATTERN, ERROR_HANDLING, TEST_STRUCTURE.
- **IMPORTS**: `react` (`useEffect`, `useState`).
- **GOTCHA**: Don't change `useHomeData` hook signatures — YAN-397 edits the period hooks. Mutations bump `refreshKey`, which must force a fresh GET (new key ≠ in-flight key).
- **VALIDATE**: `cd tests && npx vitest run unit/home-resource-store.test.js`; prod-build measurement shows `/api/settings` ×1 on load and 0 GETs on an immediate focus.

### Task 1.2: Header, endpoint card, keys, links

- **BATCH**: 1
- **Depends on**: none
- **ACTION**: Update `Header.js`, `HomeHeader.js`, `WidgetStates.js`, `EndpointHero.js`, `KeysSummary.js`, `HomeStats.js`, `QuotaWatch.js`, `CombosTop.js`, `ProviderHealth.js`, `LiveRoutes.js`.
- **IMPLEMENT**: `getPageInfo('/dashboard')` → `title: ""`. `HomeHeader`: muted status `<p>` above `<h1>Command center</h1>`, `SegmentedControl` right-aligned on the H1 row (`sm:items-end`). `CardLink({href, children})` in `WidgetStates.js` renders `next/link` with coral classes plus `<span aria-hidden className="inline-block rtl:-scale-x-100">→</span>`. Endpoint: replace `CopyField` with a plain mono block (no inline icon), Enable → `variant="outline"`. Keys: name `max-w-[60%] shrink-0 truncate`, mask `min-w-0 flex-1 truncate`. Replace all internal `<a href>` with `Link`/`CardLink`.
- **MIRROR**: LINK + RTL ARROW, IN-PAGE H1.
- **IMPORTS**: `next/link`.
- **GOTCHA**: Keep the copy live-region (`CopyStatus`). Copy stays plain English sentence case. Don't touch `RecentRequests.js` (Task 1.3). In `LiveRoutes.js` change only the "Inspect" anchor.
- **VALIDATE**: `grep -n "<a " src/app/(dashboard)/dashboard/home/*.js` returns nothing; lint passes.

### Task 1.3: Clickable recent requests

- **BATCH**: 1
- **Depends on**: none (uses CardLink from 1.2 if present)
- **ACTION**: Update `RecentRequests.js`, `RequestDetailDrawer.js`, `RequestLog.js`.
- **IMPLEMENT**: Move `providerLabel(id, cache)` into `RequestDetailDrawer.js` as a named export (shared entry point); `RequestLog` imports it. In `RecentRequests`, lazily load the drawer with `next/dynamic` (`ssr:false`); rows from `details` (have `id`) render `<button type="button">` filling the `<li>` (text-start, focus ring, hover), click sets the selected raw row and opens the drawer; fallback rows stay static. Errors show visible "Error <code>" text next to the red dot. "All logs" action and empty-state CTA go to `/dashboard/usage?tab=logs` via `CardLink` (from Task 1.2 — if absent, use `Link` with the same classes).
- **MIRROR**: LINK + RTL ARROW; RequestLog opener.
- **IMPORTS**: `next/dynamic`, `useState`.
- **GOTCHA**: Redacted payload sections are expected; the drawer already renders EmptyState for them.
- **VALIDATE**: Keyboard: Tab to a row, Enter opens drawer, Esc closes and returns focus.

### Task 2.1: Validate and re-measure

- **BATCH**: 2
- **Depends on**: 1.1, 1.2, 1.3
- **ACTION**: Run lint, tests, build; re-run `/tmp/opencode/yan404/measure.mjs` and `shots.mjs` against the new build.
- **IMPLEMENT**: Save after-counts and screenshots to `docs/redesign/screenshots/YAN-404/` (main checkout).
- **MIRROR**: N/A.
- **IMPORTS**: N/A.
- **GOTCHA**: `.next/standalone/node_modules` symlink must be absolute in a worktree.
- **VALIDATE**: All commands exit 0; zero console errors besides pre-existing ones.

---

## Testing Strategy

### Unit Tests

| Test             | Input                                 | Expected Output                    | Edge Case? |
| ---------------- | ------------------------------------- | ---------------------------------- | ---------- |
| dedupe           | two loads same URL + key              | 1 fetch, both subscribers get data | no         |
| forced reload    | load with new key during flight       | second fetch                       | yes        |
| staleness        | focus at +10 s / +31 s                | 0 / 1 fetch per URL                | yes        |
| throttle         | two focuses 5 s apart after staleness | 1 refresh                          | yes        |
| error keeps data | 500 after success                     | data kept, error set               | yes        |

### Edge Cases Checklist

- [x] Fallback recent rows without `id` are not clickable
- [x] Unmount clears the store entry (fresh fetch on next visit)
- [x] Hidden tab: polling paused

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: exit 0

### Unit Tests

```bash
cd tests && npx vitest run unit/home-resource-store.test.js
```

EXPECT: all pass

### Full Test Suite

```bash
npm test
```

EXPECT: no regressions vs `tests/__baseline__/known-fails.txt`

### Build

```bash
npm run build
```

EXPECT: exit 0

### Browser Validation

```bash
node /tmp/opencode/yan404/measure.mjs http://127.0.0.1:20140 stale
node /tmp/opencode/yan404/shots.mjs http://127.0.0.1:20140 <dir> theme
```

EXPECT: load has no duplicate GETs; immediate focus 0 GETs; stale focus ≤ 1 per URL.

### Manual Validation

- [ ] Keyboard: recent row → drawer → Esc
- [ ] RTL (ar): arrows mirrored
- [ ] Dark/light at 1440/1024/390

---

## Acceptance Criteria

- [ ] Home has one lime primary and one copy control per value.
- [ ] No full page reloads from Home; "All logs" opens the request log; arrows mirror in RTL.
- [ ] Recent request rows open the detail drawer by mouse and keyboard.
- [ ] Tab focus triggers at most one batched refresh of stale data; load has no duplicate GETs (before/after counts in PR).
- [ ] Header order matches the Main board; key names readable; bottom row has no large dead areas.

## Completion Checklist

- [ ] Lint, tests, build green
- [ ] Before/after measurements + screenshots in `docs/redesign/screenshots/YAN-404/`
- [ ] PR against `re-design` with `Closes #315`, YAN-404
- [ ] Merge held until YAN-397 lands; rebase onto it

## Risks

| Risk                                                             | Likelihood | Impact | Mitigation                                              |
| ---------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| YAN-397 conflicts in `HomeHeader`/`HomePageClient`/`useHomeData` | High       | Medium | Keep `period` a plain prop; rebase after YAN-397 merges |
| In-page H1 leaves an empty shell title slot                      | Low        | Low    | Same precedent as provider/media detail (YAN-314)       |
| Store keeps stale data after error                               | Low        | Low    | Cards show error state first; Retry forces reload       |

## Notes

Baseline (prod build, 2026-09-29): load 15 `/api/*` GETs with `/api/settings` ×2; immediate focus 13 GETs; focus after 60 s 14 GETs.
