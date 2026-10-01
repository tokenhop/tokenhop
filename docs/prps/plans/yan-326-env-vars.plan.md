# Plan: TOKENHOP_* environment variables with legacy aliases (YAN-326)

## Summary

Rename every product-prefixed env var to `TOKENHOP_*`. User-settable ones read
through the brand module's `readEnv(suffix)`, so `NINEROUTER_*` / `NINE_ROUTER_*`
keep working (warn once, only under the tokenhop brand). Internal and test-only
variables are plain renames. Trunk landing: **ships anytime**.

## Metadata

- Linear: YAN-326 · GitHub: #196 · Target: v1.0.0 (trunk `master`, no backport)
- Branch: `rebrand/yan-326-env-vars` · Worktree: `.claude/worktrees/tokenhop-env-vars`
- Blocker YAN-321 (brand module): merged.

## Decisions

| Variable                                           | New                                   | Class                            | Why                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE`            | `TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE` | alias                            | User-facing tuning knob (build time in `next.config.mjs`, runtime in `custom-server.js`).                                                       |
| `NINE_ROUTER_API_KEY`                              | `TOKENHOP_API_KEY`                    | alias                            | User sets it for `xai video`.                                                                                                                   |
| `NINEROUTER_CLI_APP_DIR`                           | `TOKENHOP_CLI_APP_DIR`                | alias                            | Manual build override; no in-repo setter.                                                                                                       |
| `NINE_ROUTER_DISABLE_MITM`                         | `TOKENHOP_DISABLE_MITM`               | alias on read, new name on write | Only the bundled CLI sets it (same version as the app), but a user running `custom-server.js` by hand could set it. Reading both costs nothing. |
| `NINEROUTER_PEER_TOKEN`                            | `TOKENHOP_PEER_TOKEN`                 | plain rename                     | `custom-server.js` always overwrites it with a fresh random token at boot; a user value is never honoured.                                      |
| `NINE_ROUTER_PROXY_MANAGED` / `_URL` / `_NO_PROXY` | `TOKENHOP_PROXY_*`                    | plain rename                     | In-process bookkeeping in `outboundProxy.js` only.                                                                                              |
| `NINEROUTER_TEST_*`                                | `TOKENHOP_TEST_*`                     | plain rename                     | Test harness only; no CI reference.                                                                                                             |

- `custom-server.js` loads the brand module from `./src/shared/brand/index.cjs`
  (repo checkout, Docker `/app/src/shared/brand`) and falls back to the CLI's packed
  copy `../src/shared/brand/index.cjs` (`cli/app/custom-server.js` →
  `cli/src/shared/brand`). Same pattern as `cli/hooks/sqliteRuntime.js`.
- CLI runtime (`xaiVideo.js`) uses the packed-copy-then-repo pattern too.
- Build scripts (`build-cli.js`, `buildMitm.js`) require the repo copy directly
  (they run before the packed copy exists).
- `xai video --help` names `${ACTIVE.envPrefix}API_KEY`: `NINEROUTER_API_KEY` under
  the default brand (accepted, matches README), `TOKENHOP_API_KEY` under tokenhop.
- `.env.example`: unchanged. It documents none of these vars; the `CLOUD_URL`
  cleanup already landed; the header and `INSTANCE_NAME` flip are release-window
  doc work (YAN-338/YAN-343).
- Out of scope: `NINEROUTER_URL`/`NINEROUTER_KEY` (skills, YAN-333),
  `JCODE_9ROUTER_API_KEY` (YAN-331), README/gitbook examples (YAN-338/YAN-340),
  the `x-9r-*` internal headers.

## Files to change

| File                                                                                                                                              | Change                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `next.config.mjs`                                                                                                                                 | `import brand from "./src/shared/brand/index.cjs"`; `brand.readEnv("PROXY_CLIENT_MAX_BODY_SIZE") \|\| "128mb"` |
| `custom-server.js`                                                                                                                                | require brand (fallback path); `TOKENHOP_PEER_TOKEN`; body limit via `readEnv`                                 |
| `src/lib/auth/trustedPeer.js`                                                                                                                     | read `TOKENHOP_PEER_TOKEN`                                                                                     |
| `src/lib/network/outboundProxy.js`                                                                                                                | `TOKENHOP_PROXY_*`                                                                                             |
| `src/shared/services/initializeApp.js`                                                                                                            | `readEnv("DISABLE_MITM") === "1"`                                                                              |
| `cli/cli.js`                                                                                                                                      | child env sets `TOKENHOP_DISABLE_MITM`                                                                         |
| `cli/scripts/build-cli.js`, `cli/scripts/buildMitm.js`                                                                                            | `readEnv("CLI_APP_DIR")`                                                                                       |
| `cli/src/cli/commands/xaiVideo.js`                                                                                                                | `readEnv("API_KEY")`, help text                                                                                |
| `tests/setup/tempRoot.js`, `tests/setup/isolateDataDir.js`, `tests/vitest.config.js`, `tests/README.md`, `tests/unit/test-data-isolation.test.js` | `TOKENHOP_TEST_*`                                                                                              |
| `tests/unit/custom-server-peer-headers.test.js`, `dashboard-guard.test.js`, `local-request-peer-trust-3294.test.js`, `security-audit.test.js`     | new names                                                                                                      |
| `tests/unit/env-aliases.test.js` (new)                                                                                                            | alias matrix (below)                                                                                           |
| `scripts/brand-guard.baseline.json`                                                                                                               | lowered via `npm run lint:brand -- --update`                                                                   |

## Tests (critical only)

`tests/unit/env-aliases.test.js`, legacy fixtures first:

- `next.config.mjs` (build time): legacy `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` honoured;
  `TOKENHOP_*` honoured; both set → new wins; neither → `128mb`.
- `xaiVideo.parseArgs` default `apiKey`: legacy `NINE_ROUTER_API_KEY` honoured, new
  honoured, both → new wins; one deprecation warning under the tokenhop brand.

Warn-once and prefix ordering are already covered by `tests/unit/brand.test.js`.
Plain renames are covered by the existing tests updated to the new names.

## Validation

```bash
npm run lint
npm run lint:brand
npm test
npm run build
NEXT_PUBLIC_BRAND=tokenhop npm test
NEXT_PUBLIC_BRAND=tokenhop npm run build
git grep -nIE 'NINE_?ROUTER' -- ':!docs' ':!gitbook' ':!i18n' ':!CHANGELOG.md'
```

The grep may only show the brand module's `LEGACY`, brand/guard test fixtures,
skills, and README/gitbook examples owned by the docs issues.
