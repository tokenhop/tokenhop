# PR Review #396 — fix(grok-cli): make GROK_CLI_VERSION env-configurable and bump to 1.0.44

**Reviewed**: 2026-09-30
**Mode**: PR
**Author**: yandy-r
**Branch**: fix/yan-610-grok-cli-version → master
**Decision**: APPROVE

## Worktree Setup

- **Parent**: <repo-root>/.claude/worktrees/tokenhop-fix-yan-610-grok-cli-version/ (branch: fix/yan-610-grok-cli-version)

## Summary

The fix is correct and complete for a v0.5.x patch. `GROK_CLI_VERSION` is validated strictly: the regex is anchored, ASCII-only, and applied after trimming, so CRLF can't get into a header. Every Grok CLI call site reads the shared constants. The key is read-only in PATCH and in config import/export. Three parallel reviewers (correctness, security, quality) found no CRITICAL/HIGH/MEDIUM issues, only LOW polish items. Items that belong with the wider 1.0.x alignment are deferred to YAN-611.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

- **[F001]** `open-sse/config/grokCli.js:1` — The comment says the version is "reported to cli-chat-proxy.grok.com and auth.x.ai". In fact, only the device-code login calls send it to auth.x.ai. Token refresh (`refreshXaiToken`) sends no Grok fingerprint.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Say "auth.x.ai device-code login" and note that token refresh sends no client fingerprint. Also mention keeping the compose pins in step with the default (see F005).
- **[F002]** `open-sse/providers/registry/grok-cli.js:4` — "re-verified by wire capture against 1.0.44" overstates it. Only the version was bumped; full 1.0.x header alignment is YAN-611.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Reword to "headers from an official CLI wire capture; version from GROK_CLI_VERSION (1.0.x header alignment: YAN-611)".
- **[F003]** `src/app/api/settings/validateSectionSettings.js:35` — `GROK_CLI_VERSION` comes after `ZED_CLIENT_VERSION` here, in `settingsConfigDoc.js` `READ_ONLY_SETTING_KEYS`, and in the `route.js` GET import/response. `CLIENT_PINS` and the test list put it before Zed.
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Put `GROK_CLI_VERSION` before `ZED_CLIENT_VERSION` in both read-only sets and in the route import/response.
- **[F004]** `src/lib/oauth/providers/grok-cli.js:66` — `postExchange` still hardcodes `https://cli-chat-proxy.grok.com/v1/user`. The `testUtils.js:150` `userUrl` fallback can never run, like the headers fallback this PR removed.
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Use `` `${GROK_CLI_BASE_URL}/user` `` in `postExchange`, and `PROVIDERS["grok-cli"].userUrl` without the fallback in `testUtils.js`.
- **[F005]** `compose.yml:22` — `GROK_CLI_VERSION: 1.0.44` is duplicated in both compose files, so a later default bump can miss them and bring the 426 back for compose users. This matches the existing Claude/Codex pin convention.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Keep the pins, per the existing convention. Add a note in `grokCli.js` to bump the compose files together with the default.
- **[F006]** `open-sse/services/tokenRefresh.js:166` — The Grok CLI refresh grant uses the shared xAI refresh (`User-Agent: grok-cli/9router`, no `x-grok-client-version`). Nothing shows auth.x.ai gates on it today.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Defer to YAN-611: a grok-cli-specific refresh that reuses the auth headers.
- **[F007]** `open-sse/executors/grok-cli.js` — A future upstream minimum bump would reach users as a bare 426. Zed already maps this case to a "set ZED_CLIENT_VERSION" hint.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Defer to YAN-611: map an upstream 426 to an error that names `GROK_CLI_VERSION`.
- **[F008]** `open-sse/config/envOverride.js:9` — This helper already existed before the PR. Its error message echoes the raw env value into logs and into the settings GET 500 body. The value is operator-controlled, and CODEX/CLAUDE behave the same way.
  - **Status**: Open
  - **Category**: Security
  - **Suggested fix**: Separate PR: drop or truncate the raw value in the `envString` error.

## Validation Results

| Check      | Result                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| Type check | Skipped (plain JS, no tsconfig)                                            |
| Lint       | Pass (`npm run lint`)                                                      |
| Tests      | Pass (`npm test` regression gate: no regression; `verify-providers` equal) |
| Build      | Pass (`npm run build`)                                                     |

Live check (dev container, real Grok Build connection):

- 0.2.99 returns 426.
- 1.0.44 returns 200 on a chat through `GrokCliExecutor`.
- The `GROK_CLI_VERSION=1.0.13` override returns 200.
- `v1` throws at startup.
- The OAuth device-code request returns 200 and sends the new headers.

## Files Reviewed

- `.env.example` (Modified)
- `README.md` (Modified)
- `compose.yml` (Modified)
- `compose.dev.yml` (Modified)
- `open-sse/config/grokCli.js` (Modified)
- `open-sse/providers/registry/grok-cli.js` (Modified)
- `public/i18n/literals/*.json` (Modified, 34 locales)
- `scripts/translate-literals.mjs` (Modified)
- `src/app/(dashboard)/dashboard/settings/sections/ProvidersModelsSection.js` (Modified)
- `src/app/api/providers/[id]/test/testUtils.js` (Modified)
- `src/app/api/settings/route.js` (Modified)
- `src/app/api/settings/validateSectionSettings.js` (Modified)
- `src/lib/oauth/providers/grok-cli.js` (Modified)
- `src/lib/settingsConfigDoc.js` (Modified)
- `tests/__baseline__/providers-baseline.json` (Modified)
- `tests/unit/grok-cli-executor.test.js` (Modified)
- `tests/unit/grok-cli-models.test.js` (Modified)
- `tests/unit/grok-cli-usage.test.js` (Modified)
- `tests/unit/grok-cli-version.test.js` (Added)
- `tests/unit/i18n-literals.test.js` (Modified)
- `tests/unit/settings-sections-validation.test.js` (Modified)
