# PR Review #456 — fix(config): stop .env.example pinning request logs off and renew the MiMo proxy timeout

**Reviewed**: 2026-10-01
**Mode**: PR (correctness, security, quality)
**Author**: yandy-r
**Branch**: fix/yan-67-113-request-logs-env-mimo-timeout → master
**Decision**: APPROVE after fixes

## Summary

No CRITICAL findings. One HIGH: with `ENABLE_REQUEST_LOGS` no longer set by default, the stored "Log every request
to console" toggle became the only switch, and it was lost on every restart. Fixed in the follow-up commit and
verified against a production build.

## Findings

### HIGH

- **[F001]** `open-sse/utils/requestLogger.js:11` — the stored `requestLogsEnabled` flag lives only in memory and is
  set only by the settings PATCH, so a restart forgets it (debug logs stop until the toggle is flipped again)
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: sync it in `src/sse/handlers/chat.js` from the settings already read per request.
    `instrumentation.js` was tried first and does not reach the route bundle's module instance.

### LOW

- **[F002]** `tests/unit/xiaomi-mimo-oauth-proxy.test.js` — the fake-timer test opens a real loopback listener
  - **Status**: Open (accepted)
  - **Category**: Tests
  - **Suggested fix**: none; `finally` always calls `stopXiaomiMimoProxy()` and restores real timers.

## Validation

- `npm run lint`, `npm run lint:brand`, `npm test` (no regression), `npm run build`
- Production-build smoke: stored `true` + restart logs; `ENABLE_REQUEST_LOGS=false` does not; live toggle-off does not.
