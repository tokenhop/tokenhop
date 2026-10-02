# PR Review #505 — feat(skills): add tokenhop agent skills behind the brand switch

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: rebrand/yan-333-skills → master
**Decision**: APPROVE (with comments)

## Summary

Correct and safe. The route allowlist is still an exact-match Set, the default brand is unchanged, and the tokenhop skills are brand-only copies with tagged legacy fallbacks. Only MEDIUM and LOW maintainability and scope items were found. Three parallel reviewers covered correctness, security and quality.

## Findings

### MEDIUM

- **[F001]** `src/shared/components/Header.js:135` — The Skills page subtitle "Teach any AI agent to use your 9router with one line." still names 9router under a tokenhop build.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: This is out of scope for YAN-333. It is user-visible product-name copy and an i18n key, which YAN-335 (product name across the dashboard) owns. Record it on YAN-335. (Done: comment on YAN-335.)

### LOW

- **[F002]** `src/shared/constants/skills.js:165` — Legacy ids are derived with `slice(ENTRY_SKILL_ID.length)`, which silently assumes every id starts with the slug.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Give each entry a `suffix` and build both the active and the legacy ids from it.
- **[F003]** `src/shared/constants/skills.js:158-185` — `getSkillRawUrl` / `getSkillBlobUrl` have no callers, and their "Legacy helpers … used by" JSDoc is inaccurate.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Delete both functions and the now-unused `SKILLS_RAW_BASE`.
- **[F004]** `tests/helpers/cliToolsBrand.js:1` — The header comment says it is only for the CLI-tool tests, but the skills test now uses it too.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Broaden the wording.
- **[F005]** `tests/unit/dashboard-guard.test.js:72` — The public-access test only requests the 9router entry id.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: None needed. The guard matches the `/skills` prefix and never looks at the id, and `skills-brand.test.js` covers both id sets at the route.
- **[F006]** `src/app/skills/[...slug]/route.js:36` — Each request reads the file from disk on a public route. This predates the PR.
  - **Status**: Open
  - **Category**: Performance
  - **Suggested fix**: Out of scope (the behaviour predates the PR, and the files are 5–10 KB). Revisit if the route gets traffic.

## Validation Results

| Check      | Result                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Type check | Skipped (plain JS)                                                        |
| Lint       | Pass (biome, prettier and markdownlint on changed files; `lint:brand` OK) |
| Tests      | Pass (default and tokenhop brands, 0 regressions)                         |
| Build      | Pass (default and tokenhop brands)                                        |

## Files Reviewed

- `skills/tokenhop*/SKILL.md` (Added, 9)
- `src/shared/constants/skills.js` (Modified)
- `src/app/skills/[...slug]/route.js` (Modified)
- `src/app/(dashboard)/dashboard/skills/SkillsPageClient.js` (Modified)
- `tests/unit/skills-brand.test.js` (Added)
- `tests/unit/skills-urls.test.js` (Modified)
- `scripts/brand-guard.baseline.json` (Modified)
- `docs/prps/plans/yan-333-skills.plan.md` (Added)
