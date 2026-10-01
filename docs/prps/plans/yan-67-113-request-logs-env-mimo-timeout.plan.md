# YAN-67 + YAN-113: `.env.example` request-logs default, Xiaomi MiMo proxy timeout

GitHub: tokenhop/tokenhop#453, #454 · Linear: YAN-67, YAN-113 · Target: v0.6.x patch (PR into `master`, then
`backport:0.6` to `release/0.6`; `release/0.5` is frozen)

Both bugs reproduce on `origin/master` (e38587ac) and `origin/release/0.6`. The touched files are byte-identical on
both branches, so the squash commit cherry-picks cleanly.

## YAN-67: `ENABLE_REQUEST_LOGS=false` in `.env.example` disables request details

### Research

- `src/lib/db/repos/requestDetailsRepo.js` `getObservabilityConfig`: any explicit `ENABLE_REQUEST_LOGS` decides
  `enabled` alone. Otherwise `requestLogsEnabled` or `enableObservability` being `true` enables recording.
- `src/lib/settingsFlags.js` `resolveFlagSetting` and `open-sse/utils/requestLogger.js` use the same rule (env set =
  env wins) for the debug file logs.
- `ObservabilitySection.js` already locks both toggles and says "Set by ENABLE_REQUEST_LOGS in .env" when the env var
  is set (YAN-312). The precedence is deliberate and visible.
- `.env.example` (copied to `.env` per the README, and loaded by `compose.yml` `env_file`) ships
  `ENABLE_REQUEST_LOGS=false`. The gitbook install guide (all locales) exports the same value. So every new install
  pins recording off and locks the dashboard toggles.

### Design

- Keep the YAN-312 precedence. Fix the shipped default: `.env.example` comments the variable out and explains that
  unset means the dashboard setting applies. Same change in `gitbook/content/*/getting-started/installation.md`.
- Existing installs that already copied `ENABLE_REQUEST_LOGS=false` see the ".env overrides" lock and its
  explanation, so the override is no longer silent. They remove the line to hand control back to the dashboard.
- Found in review: with the env var unset, "Log every request to console" (`requestLogsEnabled`) was forgotten on
  restart. `open-sse/utils/requestLogger.js` caches the stored flag in memory and only the settings PATCH updates it.
  Seeding it from `instrumentation.js` doesn't reach the route bundle (separate module instance), so `handleChat`
  syncs it from the settings it already reads per request. Verified on a production build: stored `true` logs after
  a restart, `ENABLE_REQUEST_LOGS=false` and a live toggle-off both stop logging.

## YAN-113: Xiaomi MiMo callback proxy reuse doesn't renew its timeout

### Research

- `src/lib/oauth/utils/server.js` `startXiaomiMimoProxy`: the reuse branch resolves with the live port but leaves
  the first flow's 5-minute `xiaomiMimoProxyTimeout` running. When it fires, `stopXiaomiMimoProxy` closes the port
  and clears every pending session, killing the newer login.
- `startZedProxy` renews its timeout on reuse. Xiaomi missed it.

### Design

- One `armXiaomiMimoProxyTimeout()` helper (clear + set 5 minutes) called from both the reuse branch and the
  `listen` callback.
- Regression test in `tests/unit/xiaomi-mimo-oauth-proxy.test.js` with fake timers: start, advance 4m50s, start
  again (reuse), advance 1 minute, the session survives; advance past the new deadline, it is dropped.

## Validation

- `npm run lint`, `npm run lint:brand`
- `cd tests && npx vitest run unit/xiaomi-mimo-oauth-proxy.test.js unit/xiaomi-mimo-oauth-session.test.js`
- `npm test` (known-fails gate), `npm run build`
