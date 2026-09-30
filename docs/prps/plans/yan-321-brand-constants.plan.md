# YAN-321 — central brand constants and legacy-name registry

Target: `v1.0.0` label, trunk `master`, no backport (RELEASING.md: feature → next
minor/major on the trunk). Trunk landing: **ships anytime** (constants and
helpers only, no call sites). Blocker YAN-320 merged in #381.

## Research summary

- YAN-320 created `src/shared/brand/index.cjs` (switch: `BRAND_IDS`,
  `DEFAULT_BRAND_ID`, `ACTIVE_BRAND_ID`, `isActiveBrand`) plus the ESM entry
  `index.js`. Extend these two files; no second module.
- Consumers: Next server + client bundles (webpack, `npm run build`), `open-sse/`
  (resolved through the same bundles), and the CLI (`cli/`, CommonJS, pack
  `files` = `cli.js, src, hooks, app`). The CLI never reaches outside `cli/` at
  runtime, so the build copies the `.cjs` file into the package.
- Legacy values in use today (inventory via `git grep`): `x-9router-*` headers
  (`connection-id`, `token-saver`), `NINEROUTER_*` / `NINE_ROUTER_*` env vars,
  `sk_9router`, `urn:9router:sp`, `9Router MITM Root CA` / `9Router`,
  `9router-root-ca.crt`, `9router.pid`, `com.9router.autostart`, client config
  keys `9router` / `9Router`, storage keys `9router.*`.

## Design

`src/shared/brand/index.cjs` gains:

| Export                                                                | Meaning                                                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAND`                                                               | frozen tokenhop values from handbook §2                                                                                                            |
| `LEGACY`                                                              | frozen 9router values; same keys, pluralised (`names`, `envPrefixes`, `clientConfigKeys`) when there are several spellings, primary spelling first |
| `ACTIVE`                                                              | `BRAND` when the brand is tokenhop, else each key's primary `LEGACY` value, except brand-independent keys (below)                                  |
| `envName`, `readEnv`, `warnLegacyOnce`, `header`, `legacyHeaderNames` | helpers from the issue                                                                                                                             |

Decisions:

- **Brand-independent keys** (`repoSlug`, `repoUrl`, `imageName`, `websiteUrl`,
  `docsUrl`) resolve to `BRAND` under both brands. The repo and image already
  moved (YAN-319), and `9router.com` is upstream's domain that must never be a
  default (handbook §4). The old repo and image stay in `LEGACY` for
  recognising old inputs; `LEGACY` has no `websiteUrl`/`docsUrl`, since that
  site was never ours and `no-tracking-or-upstream-phone-home.test.js` forbids
  the domain in runtime code.
- `envName`/`readEnv` always prefer `TOKENHOP_*` (accepting new env names ships
  anytime); `header()` follows `ACTIVE` (headers are behind the switch);
  `legacyHeaderNames()` returns legacy spellings other than `header(name)`, so
  it is empty under the default brand.
- `warnLegacyOnce` is silent unless the active brand is tokenhop.
- Invalid `suffix` / header `name` throws (fail fast).
- CLI: `cli/scripts/build-cli.js` copies `index.cjs` to
  `cli/src/shared/brand/index.cjs` (gitignored); the artifacts test packs a
  fixture package with `npm pack --dry-run` and asserts the file is included.

## Tasks

1. `tests/unit/brand.test.js` (failing first): §2 values, `ACTIVE` for both
   brands, `readEnv` precedence and once-only warnings, `import` + `require`,
   `LEGACY` ∩ `BRAND` = ∅.
2. Implement in `index.cjs`, re-export in `index.js`.
3. `build-cli.js`: `copyBrandModule`; root `.gitignore`; artifacts test.
4. Prove four consumers (throwaway server/client imports, `npm run build`,
   `require` from `cli/`, `npm --prefix cli run pack:cli`), then revert.
5. Verify: lint, test and build for both brands.
