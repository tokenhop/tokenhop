# YAN-327 — tokenhop wire identifiers

Target: `v1.0.0` → base/PR `master`, no backport (RELEASING.md). Trunk landing:
**behind the brand switch** for changed defaults; read-both compat ships unconditionally.

Brand module (`src/shared/brand/index.cjs`) already holds every value: `ACTIVE`,
`BRAND`, `LEGACY`, `header()`, `legacyHeaderNames()`, `warnLegacyOnce()`. No new
brand keys are added.

## Items

| #   | Item            | Change                                                                                                                                                                                                                                                                                                                              | Files                                                                                                                                                                                                        |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Default key     | Fallbacks → `ACTIVE.defaultApiKey`; codex auth.json cleanup accepts `BRAND` and `LEGACY` key                                                                                                                                                                                                                                        | `api/cli-tools/{copilot,deepseek-tui,grok-build,opencode,codex}-settings/route.js`, `initializeApp.js`, cli-tools cards (`ApiKeySelect`, `ClaudeToolCard`, `DefaultToolCard`, `MitmServerCard`, `setupCard`) |
| 2   | Headers         | Token-saver: read `x-tokenhop-token-saver`, then legacy (warn once). Connection id: emit `header()` + `legacyHeaderNames()` (both under tokenhop, one under default). CLI reads new, then legacy. No `Access-Control-Expose-Headers` exist (routes use `Allow-Headers: *`)                                                          | `open-sse/config/runtimeConfig.js`, `open-sse/handlers/chatCore.js`, `src/sse/handlers/videoGeneration.js`, `cli/src/cli/commands/xaiVideo.js`                                                               |
| 3   | SAML issuer     | Default → `ACTIVE.samlIssuerDefault`. Migration `003-pin-saml-issuer` pins `LEGACY.samlIssuerDefault` on existing settings rows without an issuer (fresh DB has no row → untouched). `updateSettings` pins `ACTIVE.samlIssuerDefault` the first time a `saml*` key is saved without an issuer, so later installs can't drift either | `src/lib/db/migrations/{003-pin-saml-issuer.js,index.js}`, `settingsRepo.js`, `auth/saml.js`, `api/auth/saml/test/route.js`, `SamlForm.js`                                                                   |
| 4   | PID file        | Write `ACTIVE.pidFile`; read active then legacy; `readPidFiles()` returns both records so the launcher stops either; `writePidFile` removes a legacy file whose launcher is dead. `appUpdater.stopLauncher` checks both files                                                                                                       | `cli/src/cli/utils/processControl.js`, `cli/cli.js`, `src/lib/appUpdater.js`                                                                                                                                 |
| 5   | Storage keys    | `createStore` read: new key, else legacy key copied forward; writes only new key. `combo-weights-open` no longer exists (removed in the redesign)                                                                                                                                                                                   | `cli-tools/components/cliEndpointPresets.js`                                                                                                                                                                 |
| 6   | Backup filename | `ACTIVE.backupFilePrefix`; config export `${ACTIVE.slug}-config-`. Import is content-only (no name/marker check) — accepts both                                                                                                                                                                                                     | `DataSection.js`, `ConfigTransfer.js`                                                                                                                                                                        |
| 7   | Globals         | `__tokenhop*` for cowork MCP cache, SAML request cache, MCP bridges, quota forecast. `grokBuildConfig` sentinel is persisted into user TOML → YAN-331                                                                                                                                                                               | 4 files                                                                                                                                                                                                      |

## Tests (legacy fixture first)

- `tests/unit/saml-issuer-pin.test.js`: stored issuer kept; no issuer → legacy pinned; fresh DB → no row, active default; `up` twice idempotent; `updateSettings` pin.
- `tests/unit/cli-process-control.test.js`: legacy only / new only / both / stale legacy cleanup (tokenhop brand).
- `tests/unit/headroom-chat-core.test.js`: new header opts out too (legacy already covered).
- `tests/unit/xai-video-handler.test.js` + `cli-xai-video.test.js`: both headers under tokenhop; CLI reads new header.
- `tests/unit/cli-endpoint-presets.test.js`: legacy key copied forward (tokenhop brand).
- `tests/unit/cli-tools-config-safety.test.js`: codex reset removes legacy `sk_9router` and `sk_tokenhop` from auth.json.

## Verify

`npm run lint`, `npm run lint:brand -- --update` (lower baseline), `npm test` and `npm run build` under default and `NEXT_PUBLIC_BRAND=tokenhop`.

## Out of scope

Tool-config keys/markers (YAN-331/332), MITM names (YAN-328), UI copy and i18n literals (YAN-335/336), `grokBuildConfig` sentinel (YAN-331).
