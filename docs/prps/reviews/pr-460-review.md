# PR Review #460 — feat(cli-tools): write tokenhop entries into JSON tool configs and migrate legacy ones

**Reviewed**: 2026-10-01
**Mode**: PR (parallel: correctness, security, quality)
**Author**: yandy-r
**Branch**: rebrand/yan-332-cli-tools-json → master
**Decision**: APPROVE with comments

## Summary

No CRITICAL or HIGH findings. Default-brand Apply output is unchanged; detect/Reset accept every
name; the one real migration gap (a config holding both legacy spellings) is fixed. Remaining
LOW items are pre-existing or design notes outside this PR's scope.

## Findings

### MEDIUM

- **[F001]** `src/app/api/cli-tools/opencode-settings/route.js:135` — `takeLegacyEntry` returns only the first legacy entry but deletes both spellings, so a config with `9router` and `9Router` lost the second one's models/options on Apply.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Merge every legacy spelling plus ours before writing; test `apply merges ours and every legacy spelling without losing a model`.
- **[F002]** `src/app/api/cli-tools/openclaw-settings/route.js:222` — same shape: a second legacy spelling's extra provider fields are not carried over.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: Accepted: OpenClaw Apply rewrites the provider's models, baseUrl, apiKey and api, so only unknown extra fields of a second hand-made duplicate could be dropped. Not worth a merge path.
- **[F003]** `src/app/api/cli-tools/openclaw-settings/route.js:303` — Reset leaves our refs in `defaults.model.fallbacks` and per-agent fallbacks.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Pre-existing Reset scope (master never cleaned fallbacks or per-agent files); track with the Reset parity work (YAN-616).
- **[F004]** `src/lib/cliToolBrand.js:66` — `isCustomModelId` lacks a string guard.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: Already guarded with `typeof id === "string"` on the PR head (reviewer read a stale line).
- **[F005]** `tests/unit/cli-tools-brand-opencode.test.js` — no test for both legacy spellings plus an active entry.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Added the merge test (see F001).

### LOW

- **[F006]** `src/lib/cliToolBrand.js:46` — `isLegacyModelRef` exported but unused.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Made module-private.
- **[F007]** `src/lib/cliToolBrand.js:40` — `splitModelRef("9router/")` returned an empty model.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Return null when nothing follows the slash.
- **[F008]** `src/app/api/cli-tools/copilot-settings/route.js:113` — legacy duplicates linger when the active entry already exists.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Drop legacy-named duplicates on every Apply (no-op under the default brand).
- **[F009]** `src/app/api/cli-tools/kilo-settings/route.js:54` — a legacy auth entry is not inspected when `openai-compatible` exists.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Accepted: detection already true via `openai-compatible`; Reset removes every key.
- **[F010]** `src/lib/cliToolBrand.js:53` — `urlNamesClient` is a substring match (now also `tokenhop`).
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Pre-existing heuristic (master matched the legacy key the same way); hostname/path-segment matching belongs with the Reset parity work.
- **[F011]** `cli/src/cli/menus/cliTools.js:337`, `DroidToolCard.js:62` — unreachable `<prefix>0` fallback lookups.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: The card fallback is pre-existing; the CLI helper keeps the active-first preference explicit. Leave.
- **[F012]** pre-existing: GET returns plaintext API keys, key-bearing files written 0644, OpenClaw `agentDir` unvalidated, `__proto__` model names, Droid reorder quirk, `cliTools.js` > 500 lines.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Out of scope for the rebrand; unchanged from master. Candidates for a hardening issue.

## Validation Results

| Check      | Result                                         |
| ---------- | ---------------------------------------------- |
| Type check | Skipped (plain JS)                             |
| Lint       | Pass (biome: no new errors; brand guard OK)    |
| Tests      | Pass (baseline gate, both brands; 80 targeted) |
| Build      | Pass (both brands)                             |

## Files Reviewed

- `src/lib/cliToolBrand.js` (Modified)
- `src/app/api/cli-tools/{opencode,openclaw,kilo,droid,copilot,cline}-settings/route.js` (Modified)
- `src/app/api/cli-tools/antigravity-mitm/route.js` (Modified)
- `src/app/(dashboard)/dashboard/cli-tools/components/{OpenCode,OpenClaw,Droid,Copilot}ToolCard.js` (Modified)
- `cli/src/cli/menus/cliTools.js` (Modified)
- `scripts/brand-guard.baseline.json` (Modified)
- `tests/helpers/cliToolsBrand.js`, `tests/unit/cli-tools-brand-{json,opencode}.test.js`, `tests/unit/cli-tools-menu-brand.test.js`, fixtures (Added)
- `tests/unit/cli-tools-brand-migration.test.js`, `tests/unit/cli-tools-config-safety.test.js` (Modified)
- `docs/prps/plans/yan-332-cli-tools-json.plan.md` (Added)
