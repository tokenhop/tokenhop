# Plan: YAN-333 — tokenhop agent skills behind the brand switch

## Summary

Add `skills/tokenhop*` (9 skills) next to `skills/9router*`, and make the skills
constants, the dashboard Skills page and the public `/skills/[...slug]` route
pick the skill set from the active brand (`ACTIVE.slug`). The default brand stays
byte-for-byte the same. The legacy pointer stubs and the `skills/README.md` flip
wait for a release-day PR, because they can't be switched in code.

## User Story

As an agent user on a tokenhop build, I want the dashboard to hand me `tokenhop*`
skills that use `TOKENHOP_URL`/`TOKENHOP_KEY`, and old `9router*` skill links to
keep working, so the rebrand doesn't break my agents.

## Problem → Solution

Skill ids, paths and the entry id are hardcoded as `9router*` in
`src/shared/constants/skills.js` and `SkillsPageClient.js`. Change: build the ids
from `ACTIVE.slug`, add the tokenhop markdown, and have the route also serve the
legacy ids under the tokenhop brand (read-legacy).

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A (Linear YAN-333, GitHub #203)
- **PRD Phase**: N/A
- **Estimated Files**: 15 (9 new markdown files, 3 source files, 2 tests, the guard baseline)
- **Target release**: `v1.0.0`. Base `master`, PR into `master`, no backport (RELEASING.md)

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-skills/ (branch: rebrand/yan-333-skills)

---

## UX Design

### Before

The Skills page lists `9router*` skills. The hero copies `<base>/skills/9router/SKILL.md`.

### After

- Default brand: identical.
- tokenhop brand: the page lists `tokenhop*` skills, the hero copies
  `<base>/skills/tokenhop/SKILL.md`, the entry card is named "tokenhop entry
  skill", and the GitHub links point at `skills/tokenhop*`. `/skills/9router*`
  still serves.

### Interaction Changes

| Touchpoint           | Before       | After (tokenhop brand)       | Notes                    |
| -------------------- | ------------ | ---------------------------- | ------------------------ |
| Hero copy line       | `9router` id | `tokenhop` id                | `ENTRY_SKILL_ID`         |
| Card ids, links      | `9router-*`  | `tokenhop-*`                 | Built from `ACTIVE.slug` |
| `/skills/<id>` route | 9router ids  | tokenhop ids plus legacy ids | `SERVED_SKILL_IDS`       |

---

## Mandatory Reading

| Priority | File                                                       | Lines          | Why                                                 |
| -------- | ---------------------------------------------------------- | -------------- | --------------------------------------------------- |
| P0       | `src/shared/constants/skills.js`                           | all            | File being changed                                  |
| P0       | `src/shared/brand/index.cjs`                               | 140-170        | `ACTIVE`, `LEGACY`, brand-independent keys          |
| P0       | `src/app/skills/[...slug]/route.js`                        | all            | Allowlist                                           |
| P1       | `src/app/(dashboard)/dashboard/skills/SkillsPageClient.js` | 15-35, 205-210 | Entry id, open URL                                  |
| P1       | `tests/helpers/cliToolsBrand.js`                           | 1-35           | Brand-reload test pattern                           |
| P1       | `scripts/brand-guard.mjs`                                  | 20-60          | `legacy(9router)` line marker                       |
| P2       | `skills/9router/SKILL.md`                                  | all            | Source for the tokenhop copies (and the 8 siblings) |

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js:1
import { ACTIVE, LEGACY } from "@/shared/brand";
```

### ERROR_HANDLING

```js
// SOURCE: src/shared/constants/skills.js:22-24
const skill = SKILLS.find((entry) => entry.id === id);
if (!skill) throw new Error(`Unknown skill: ${id}`);
```

### LOGGING_PATTERN

No logging. A legacy skill URL is a document fetch, not a config input, so it
doesn't need `warnLegacyOnce`.

### REPOSITORY_PATTERN

```js
// SOURCE: src/app/skills/[...slug]/route.js:36
const filePath = path.join(process.cwd(), "skills", id, "SKILL.md");
```

### SERVICE_PATTERN

```js
// SOURCE: src/shared/brand/index.cjs:144-150 (repoSlug is brand-independent)
const BRAND_INDEPENDENT_KEYS = new Set(["repoSlug", "repoUrl", ...]);
```

### TEST_STRUCTURE

```js
// SOURCE: tests/helpers/cliToolsBrand.js:21-26
process.env.NEXT_PUBLIC_BRAND = brand;
delete require.cache[BRAND_CJS];
vi.resetModules();
return import(specifier);
```

---

## Files to Change

| File                                                       | Action | Justification                                                          |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `skills/tokenhop*/SKILL.md` (9)                            | CREATE | tokenhop copies of the skills                                          |
| `src/shared/constants/skills.js`                           | UPDATE | Build ids from `ACTIVE.slug`; add `ENTRY_SKILL_ID`, `SERVED_SKILL_IDS` |
| `src/app/skills/[...slug]/route.js`                        | UPDATE | Allowlist = `SERVED_SKILL_IDS`                                         |
| `src/app/(dashboard)/dashboard/skills/SkillsPageClient.js` | UPDATE | Use `ENTRY_SKILL_ID`                                                   |
| `tests/unit/skills-urls.test.js`                           | UPDATE | Brand-neutral ids, so the tokenhop CI leg passes                       |
| `tests/unit/skills-brand.test.js`                          | CREATE | Every listed id has a SKILL.md; route serves legacy ids                |
| `scripts/brand-guard.baseline.json`                        | UPDATE | Lower the counts for the touched files                                 |

## NOT Building

- Legacy pointer stubs in `skills/9router*` and the `skills/README.md` flip.
  Release day (handbook §5.1), tracked as a follow-up Linear issue.
- Main README skills section (YAN-338).
- Translations of the new entry-skill name. It's a template literal, so it isn't
  extracted, and the current "9router entry skill" has no translation either.

---

## Step-by-Step Tasks

### Task 1.1: tokenhop skill markdown

- **ACTION**: Create the `skills/tokenhop*` copies of all 9 `skills/9router*/SKILL.md` files.
- **IMPLEMENT**: Brand-only edits, nothing else changes: `9Router`/`9router` → `tokenhop`, `9router-<x>` → `tokenhop-<x>`, `NINEROUTER_URL`/`NINEROUTER_KEY` → `TOKENHOP_URL`/`TOKENHOP_KEY`, raw URL `skills/9router/` → `skills/tokenhop/`, `x-9router-connection-id` → `x-tokenhop-connection-id`, `9router xai video` → `tokenhop xai video`, the example fetch URL `https://9router.com` → `https://example.com`. Add the legacy env fallback: in the entry skill, `export TOKENHOP_URL="${TOKENHOP_URL:-$NINEROUTER_URL}"` and the same for the key, each on a line tagged `# legacy(9router): remove in v2`. In each capability skill's "Requires" line, add a fallback sentence ending in `<!-- legacy(9router): remove in v2 -->`.
- **MIRROR**: The source skills.
- **GOTCHA**: The brand guard fails on any `9router` match in the new files unless the line has the `legacy(9router)` marker. Keep the name lowercase, even at the start of a sentence or in a heading.
- **VALIDATE**: `npm run lint:brand`. `diff` each pair: only brand tokens and the fallback lines differ.

### Task 1.2: brand-aware constants, route and page

- **ACTION**: Update `skills.js`, `route.js` and `SkillsPageClient.js`.
- **IMPLEMENT**: In `skills.js`, `const PREFIX = ACTIVE.slug`; ids are `PREFIX + suffix`, paths are `` `${id}/SKILL.md` ``, `REPO = ACTIVE.repoSlug`. Export `ENTRY_SKILL_ID`, plus `SERVED_SKILL_IDS` = active ids ∪ the ids built from `LEGACY.slug` (`// legacy(9router): remove in v2`). The entry name is `` `${PREFIX} entry skill` ``. The route builds its Set from `SERVED_SKILL_IDS`. The page uses `ENTRY_SKILL_ID`.
- **MIRROR**: NAMING_CONVENTION.
- **IMPORTS**: `import { ACTIVE, LEGACY } from "@/shared/brand";` (or a relative path, if tests import skills.js without the alias).
- **GOTCHA**: The default brand must keep the same ids and order. `SERVED_SKILL_IDS` under the default brand equals the SKILLS ids.
- **VALIDATE**: unit tests, both brands.

### Task 2.1: tests and guard baseline

- **ACTION**: Make `skills-urls.test.js` brand-neutral (use `ENTRY_SKILL_ID` and `SKILLS` ids), add `skills-brand.test.js`, run `npm run lint:brand -- --update`.
- **IMPLEMENT**: For each brand (load fresh modules), check that every SKILLS entry has `skills/<id>/SKILL.md` on disk with frontmatter `name: <id>`. Under tokenhop, the route GET serves `tokenhop` and the legacy `9router` id. Under the default brand, it 404s on `tokenhop` (still behind the switch). Mock `process.cwd()` to the repo root for the route.
- **MIRROR**: TEST_STRUCTURE.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/skills-*.test.js`, with and without `NEXT_PUBLIC_BRAND=tokenhop`.

---

## Testing Strategy

### Unit Tests

| Test                              | Input                   | Expected Output                 | Edge Case? |
| --------------------------------- | ----------------------- | ------------------------------- | ---------- |
| every listed skill has a SKILL.md | both brands             | file exists, `name:` = id       | no         |
| route serves the legacy id        | tokenhop, `9router`     | 200 markdown                    | yes        |
| route hides tokenhop on default   | default, `tokenhop`     | 404                             | yes        |
| hosted URL uses the entry id      | base + `ENTRY_SKILL_ID` | `<base>/skills/<slug>/SKILL.md` | no         |

### Edge Cases Checklist

- [x] Unknown id still 404s (existing tests)
- [x] Path traversal still rejected (existing allowlist)

---

## Validation Commands

### Static Analysis

```bash
npm run lint && npm run lint:brand
```

EXPECT: green

### Unit Tests

```bash
npx vitest run -c tests/vitest.config.js tests/unit/skills-urls.test.js tests/unit/skills-brand.test.js tests/unit/dashboard-guard.test.js
NEXT_PUBLIC_BRAND=tokenhop npx vitest run -c tests/vitest.config.js tests/unit/skills-urls.test.js tests/unit/skills-brand.test.js tests/unit/dashboard-guard.test.js
```

EXPECT: All pass

### Full Test Suite

```bash
npm test && NEXT_PUBLIC_BRAND=tokenhop npm test
```

EXPECT: No regressions vs the known-fails baseline

### Browser Validation

```bash
npm run build && NEXT_PUBLIC_BRAND=tokenhop npm run build
PORT=20131 NEXT_PUBLIC_BRAND=tokenhop npm run dev
```

EXPECT: `/skills/tokenhop/SKILL.md` and `/skills/9router/SKILL.md` return 200. The Skills page lists the tokenhop skills.

### Manual Validation

- [ ] `curl $TOKENHOP_URL/api/health` and `/v1/models` work with only `TOKENHOP_*` set, and with only the legacy vars set (using the fallback export)

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] Lint, brand guard, tests (both brands), build (both brands) green
- [ ] Default-brand Skills page and route unchanged

## Completion Checklist

- [ ] Ids derive from the brand module; no new hardcoded literals
- [ ] Legacy lines tagged `legacy(9router)`
- [ ] Follow-up release-day issue filed for the stubs and the README

## Risks

| Risk                                         | Likelihood | Impact | Mitigation                   |
| -------------------------------------------- | ---------- | ------ | ---------------------------- |
| tokenhop CI leg breaks on hardcoded test ids | High       | Medium | Make the tests brand-neutral |
| Route test can't find skills (cwd = tests/)  | Medium     | Low    | Mock `process.cwd()`         |

## Notes

The repo slug is brand-independent (`tokenhop/tokenhop`), so the raw GitHub URLs
for `skills/tokenhop*` work as soon as this merges.
