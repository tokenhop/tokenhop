# PR Review #449 — feat(cli-tools): write tokenhop entries into TOML/YAML tool configs and migrate legacy ones

**Reviewed**: 2026-10-01
**Mode**: PR (parallel: correctness, security, quality)
**Author**: yandy-r
**Branch**: rebrand/yan-331-cli-tools-toml → master
**Decision**: APPROVE with comments

## Summary

No CRITICAL or HIGH findings. The MEDIUMs were default-brand drift (extra fields carried over when no migration happened) and a Grok marker-dedupe edge case. Both are fixed in the follow-up commit, together with the worthwhile LOWs.

## Findings

### MEDIUM

- **[F001]** `src/app/api/cli-tools/codex-settings/route.js:166` — default-brand Apply merged the existing entry's extra fields, so output differed from before
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: carry over fields only from a migrated legacy entry; test asserts the exact default-brand entry
- **[F002]** `src/app/api/cli-tools/jcode-settings/route.js:155` — same drift for jcode `default_model` and extra fields
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `takeLegacyEntry(config.providers) ?? {}` only
- **[F003]** `src/lib/grokBuildConfig.js:172` — marker dedupe checked a stale snapshot and required `=` spacing while the rename accepted any spacing
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: rename and dedupe in one replace with one pattern
- **[F004]** `src/lib/grokBuildConfig.js:137` — `||` treats an empty recorded previous default as missing
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: use `??`; pre-existing restore code, Apply never records an empty value, left out of this rebrand diff

### LOW

- **[F005]** `src/app/api/cli-tools/jcode-settings/route.js:117` — env file holding the API key written with the default umask; migration now creates a fresh copy
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: `mode: 0o600`
- **[F006]** `src/app/api/cli-tools/jcode-settings/route.js:109` — env values written unescaped
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: escape quotes and newlines (pre-existing; local-only route)
- **[F007]** `src/app/api/cli-tools/jcode-settings/route.js:203` — POST returns raw `error.message`
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: generic message (pre-existing)
- **[F008]** `src/lib/cliToolBrand.js:16` — unused `LEGACY_JCODE_API_KEY_ENVS` export
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: remove
- **[F009]** `src/app/api/cli-tools/codex-settings/route.js:137` — stale `9Router` handler comments
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: brand-neutral wording
- **[F010]** `src/app/api/cli-tools/grok-build-settings/route.js:150` — Reset message named only the active slot
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: brand-neutral message
- **[F011]** `tests/unit/cli-tools-brand-migration.test.js:207` — `loadLib` duplicated the brand-reload ritual; new test file held unmarked legacy literals
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: one `loadModule`; legacy names from `LEGACY`
- **[F012]** `docs/prps/plans/yan-331-cli-tools-toml.plan.md:36` — plan text drifted from the implementation
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: update Grok and Tests sections
- **[F013]** `src/lib/grokBuildConfig.js:migrateLegacySlots` — when legacy and current slots coexist, the legacy section is dropped without merging
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: none; slots are gateway-generated and rewritten on every Apply
- **[F014]** `src/app/api/cli-tools/jcode-settings/route.js:178` — Apply moves the legacy env file's other vars into the new file
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: none; intended, the file is jcode's provider file for us and is removed afterwards, so nothing is lost

## Validation Results

| Check      | Result                                           |
| ---------- | ------------------------------------------------ |
| Type check | Skipped (plain JS)                               |
| Lint       | Pass (`npm run lint`, `lint:brand`)              |
| Tests      | Pass (baseline gate, default and tokenhop brand) |
| Build      | Pass (default and tokenhop brand)                |

## Files Reviewed

- `src/lib/cliToolBrand.js` (Added)
- `src/lib/grokBuildConfig.js`, `src/lib/cliToolConfig.js` (Modified)
- `src/app/api/cli-tools/{codex,jcode,deepseek-tui,grok-build,hermes}-settings/route.js` (Modified)
- 8 other `src/app/api/cli-tools/*-settings/route.js` (Modified: status field rename)
- `src/app/(dashboard)/dashboard/cli-tools/**` cards and `lib/toolStatus.js` (Modified)
- `cli/src/cli/menus/cliTools.js`, `cli/src/cli/api/client.js` (Modified)
- `tests/unit/cli-tools-brand-migration.test.js`, `tests/fixtures/legacy/cli-tools/*` (Added)
- `tests/unit/{grok-build-config,cli-tools-status,cli-tools-request-loop}.test.js` (Modified)
- `scripts/brand-guard.baseline.json`, `docs/prps/plans/yan-331-cli-tools-toml.plan.md` (Modified/Added)
