# PR Review #421 — feat(gateway): rename wire identifiers to tokenhop with legacy compatibility

**Reviewed**: 2026-10-01
**Mode**: PR
**Author**: yandy-r
**Branch**: rebrand/yan-327-wire-identifiers → master
**Decision**: APPROVE with comments (all MEDIUM findings except F005 fixed in this PR)

## Summary

The change is mechanical and does what the rebrand handbook asks: behavior on the default brand is unchanged, and the old 9router names are still accepted alongside the new ones. The parallel review (security and quality; the correctness reviewer returned no output) found no CRITICAL or HIGH issues. The one finding that matters functionally (F001) was that the launcher-recognition check only knew the `9router` script path. Under the tokenhop brand that would have stopped the launcher from killing an old launcher before starting. It is fixed.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

- **[F001]** `cli/src/cli/utils/processControl.js:117` — `isLauncherCommandLine` only matched `9router` script paths, while the PID file now follows the brand. Under the tokenhop brand, `killAllAppProcesses` and `killProcessOnPort` would never recognise a tokenhop launcher.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Build the pattern from `BRAND.slug` and `LEGACY.slug`, and add tokenhop launcher-path cases to the test.
- **[F002]** `src/sse/handlers/videoGeneration.js:117` — the legacy header emission branch had no `legacy(9router): remove in v2` marker.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Add the marker on the branch.
- **[F003]** `open-sse/handlers/chatCore.js:88` — the legacy read inside `readTokenSaverHeader` had no marker.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Add the marker on the legacy read line.
- **[F004]** `cli/src/cli/utils/processControl.js:227` and `cliEndpointPresets.js:5` — `getLegacyPidFilePath` and `readStorageItem` were exported but nothing outside their own files uses them.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Remove the exports.
- **[F005]** `tests/unit/cli-endpoint-presets.test.js:24`, `tests/unit/cli-process-control.test.js:76` — the brand-reload test setup is duplicated, and five earlier test files already have their own copies.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Extract `tests/setup/reloadBrand.js` and move every copy onto it in a follow-up. That touches test files outside this PR's scope.

### LOW

- **[F006]** `cli/src/cli/utils/processControl.js:74` — `removePidFileIfOwner` checked ownership through `readPidFile()`, which falls back to the legacy file, but it only deletes the active file.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Check `readPidRecord(getPidFilePath())` directly.
- **[F007]** `tests/unit/headroom-chat-core.test.js:276` — on the default brand both header names are the same, so `it.each` runs the same case twice.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: None needed. The second case covers the tokenhop CI run.
- **[F008]** `open-sse/handlers/chatCore.js`, `cli/cli.js` — both files were already over the ~500-line cap, and this PR grows them by 12 and 2 lines.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Split them in a separate refactor, not in this rename PR.

## Validation Results

| Check      | Result                                             |
| ---------- | -------------------------------------------------- |
| Type check | Skipped (plain JS)                                 |
| Lint       | Pass (`npm run lint`, `npm run lint:brand`)        |
| Tests      | Pass (`npm test` under both brands; 0 regressions) |
| Build      | Pass (`npm run build` under both brands)           |

## Files Reviewed

- `cli/cli.js` (Modified)
- `cli/src/cli/commands/xaiVideo.js` (Modified)
- `cli/src/cli/utils/processControl.js` (Modified)
- `open-sse/config/runtimeConfig.js` (Modified)
- `open-sse/handlers/chatCore.js` (Modified)
- `src/lib/db/migrations/003-pin-saml-issuer.js` (Added)
- `src/lib/db/migrations/index.js`, `src/lib/db/repos/settingsRepo.js` (Modified)
- `src/lib/auth/saml.js`, `src/app/api/auth/saml/test/route.js`, `SamlForm.js` (Modified)
- `src/lib/appUpdater.js`, `src/sse/handlers/videoGeneration.js` (Modified)
- cli-tools routes and cards, `cliEndpointPresets.js`, `DataSection.js`, `ConfigTransfer.js` (Modified)
- Global renames: cowork-mcp-registry route, `stdioSseBridge.js`, `forecastStore.js` (Modified)
- Tests: `cli-endpoint-presets.test.js`, `saml-issuer-pin.test.js` (Added) and 9 existing tests (Modified)
